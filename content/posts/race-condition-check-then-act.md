---
title: Race condition in Java: check-then-act explained
date: 2026-11-01
description: Why code that looks correct loses updates or creates duplicates under load, how to reproduce a race condition, and how to fix it on one server and across many.
tags: java, concurrency
draft: true
---

## The question

A coupon can be used only once. The code checks that it is unused, applies the discount, then marks it used. Tests pass. On a laptop it never goes wrong.

In production, a handful of coupons get redeemed twice. Or a counter ends up a little below the true number. Or there are duplicate rows even though the code checks for duplicates first. It happens rarely and randomly, and nobody can reproduce it.

> The code checks first, so how can it still do the thing twice?

Between the check and the action, another thread got in. Imagine two people booking the last theater seat. Both look at the screen, both see one seat free, and both press "buy".

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **race condition** is and why a "check, then act" sequence is vulnerable
> 2. Three classic shapes: lost counter updates, duplicate inserts, double redemption
> 3. How to **reproduce** one on purpose, and how to spot one in review
> 4. How to fix it in one process, and why that fix stops working across several servers

## First, why two correct lines can be wrong together

A single operation can be safe, while two safe operations in a row are not. Each line below is correct alone. Together, they leave a gap:

```java
if (!coupon.isUsed()) {      // 1. check
    applyDiscount();         // 2. act
    coupon.markUsed();       // 3. update
}
```

Two requests can run this at the same moment on two threads. A **thread** is one line of execution inside a program, and a server runs many at once:

```diagram
type: sequence
alt: Two threads both check the coupon before either marks it used, so both apply the discount.
caption: Figure 1. Both checks happen before either update.
actors: Thread A | Coupon | Thread B
Thread A -> Coupon: is it unused?
Coupon --> Thread A: yes
Thread B -> Coupon: is it unused?
Coupon --> Thread B: yes !
note all: both apply the discount !
Thread A -> Coupon: mark used
Thread B -> Coupon: mark used
```

Both checked before either one updated. That is a **race condition**: the result depends on the exact order in which threads happen to interleave, meaning how their steps get mixed together. The gap is tiny, microseconds, which is why tests almost never hit it and a busy server hits it every day.

Even `count++` is a sequence in disguise: read the value, add one, write it back. Two threads can read 5, both write 6, and one increment is lost.

## Reproduce it on purpose

A race you cannot reproduce is a race you cannot fix. This program lets 1,000 tasks add 1,000 each to a plain `int`:

```java
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class Race {
    static int plain = 0;
    static AtomicInteger atomic = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(8);
        for (int i = 0; i < 1000; i++) {
            pool.submit(() -> {
                for (int j = 0; j < 1000; j++) {
                    plain++;                        // read, add, write: not atomic
                    atomic.incrementAndGet();       // one indivisible step
                }
            });
        }
        pool.shutdown();
        pool.awaitTermination(1, TimeUnit.MINUTES);
        System.out.println("plain=" + plain + " atomic=" + atomic.get());
    }
}
```

The right answer is 1,000,000. In one run it printed this:

```text
plain=427844 atomic=1000000
```

In that run more than half the updates vanished, with no exception and no warning. The number changes on every run, which is the fingerprint of a race. On a machine with few cores you may see less loss, so raise the iteration counts if you see none.

## The same bug in other clothes

**Duplicated work and overwritten values.** Each call on a `ConcurrentHashMap` is thread-safe, but the pair is not:

```java
if (!map.containsKey(key)) {      // thread B can get here too
    map.put(key, expensiveValue(key));
}
```

**Duplicate rows in a database.** "Select, and insert if none found" has the same gap, even across separate servers:

```sql
SELECT count(*) FROM users WHERE email = 'a@example.com';   -- 0, for both requests
INSERT INTO users (email) VALUES ('a@example.com');         -- both succeed
```

**A plain `HashMap` shared between threads.** It is not built for it. Concurrent writes can lose entries or corrupt its structure. Never share one that is being modified.

## How to spot it

**In review,** look for the pattern *read shared state, decide, then write shared state*. Whenever two steps depend on each other, ask: "What if another thread does the same thing in between?"

**In production,** the signs are numbers that are slightly off, duplicates despite checks, and problems that appear only under load or after adding more servers. Because it is not repeatable, a stress test like the one above is your friend: run the suspicious code from many threads and check the final result is what it should be.

## Fix 1: make the step indivisible (one process)

Use operations that are **atomic**, meaning they happen completely or not at all, with nothing in between. They do the check and the act as **one step**:

```java
atomic.incrementAndGet();                 // instead of count++
map.computeIfAbsent(key, k -> load(k));   // instead of containsKey + put
map.merge(key, 1, Integer::sum);          // instead of get + put (counts in a Map<K, Integer>)
```

If your logic is bigger than one of these, protect the whole sequence with a **lock**, so only one thread at a time can run it:

```java
synchronized (couponLock) {
    if (!coupon.isUsed()) {
        applyDiscount();
        coupon.markUsed();
    }
}
```

This works only if the coupon's state lives in this process's memory. A coupon loaded fresh from the database for each request is a different object per thread, so its used flag can be out of date by the time you hold the lock. Reload it inside the lock, or use Fix 2. A single shared lock for all coupons also makes every redemption wait in line. Use one lock per coupon, or go to Fix 2.

## Fix 2: let the database decide (many servers)

A lock inside one Java process protects nothing once you have three servers, because each has its own lock. The one place all servers share is the database, so make **it** the referee.

Combine the check and the update into a single statement, and read how many rows it changed:

```sql
UPDATE coupons
SET used = true
WHERE id = 42 AND used = false;
-- rows affected: 1 -> you won, apply the discount
-- rows affected: 0 -> someone else already used it
```

In JDBC, `executeUpdate()` returns that row count:

```java
int rows = ps.executeUpdate();
if (rows == 1) {
    applyDiscount();    // in the same transaction as the UPDATE
}
```

A **transaction** is a group of statements that succeed or fail together. Keep the update and the discount in one, or a crash can burn the coupon without giving the discount.

For duplicates, add a **unique constraint** and let the database reject the second insert. If duplicates already exist, clean them up first, or the command fails:

```sql
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
-- then: INSERT ... ON CONFLICT DO NOTHING   (PostgreSQL syntax)
```

Other databases have their own form, such as `INSERT IGNORE` in MySQL. You can also insert and catch the duplicate-key error.

For counters, let the database add: `UPDATE stats SET hits = hits + 1 WHERE id = 1` is atomic. Reading the value in Java and writing it back is not.

When a conditional `UPDATE` does not fit, use **optimistic locking**: add a `version` column, and update only `WHERE id = ? AND version = ?`. [The lost update post](/posts/lost-update-optimistic-locking/) shows this in full. Locks inside the database can deadlock, which [the deadlocks post](/posts/database-deadlocks/) explains.

The database serializes these steps for you, and correctness no longer depends on how many servers there are.

## When the fix goes wrong

These are the pitfalls that catch people most often. The first two look like fixes but are not.

**1. Using `synchronized` across servers.** A coupon may be used once, and you wrap the check and the update in `synchronized`. On your laptop, with one process, it works.

In production you run three servers. A lock made by `synchronized` lives in the memory of one process. Server B cannot see the lock that server A holds, and each server has its own. So two requests, one on each server, can both read "coupon unused" at the same moment, and both apply the discount. Each server obeyed its own lock, and the coupon was still used twice.

Move the check to a place that all servers share: the database. For example, run `UPDATE coupons SET used = true WHERE id = ? AND used = false` and look at how many rows changed. The database does this as one step, so exactly one request sees "1 row changed" and wins. The other sees "0 rows" and knows it lost. This is Fix 2 above.

**2. Using `volatile` as a cure.** `volatile` makes sure that when one thread writes a value, other threads see the new value, not an old copy. That is called **visibility**. It sounds like it solves races, but it does not.

`count++` is really three steps: read the number, add 1, write it back. Say `count` is 5. Two threads both read 5, both add 1, and both write 6. Two increments happened, and the count went up by only 1. `volatile` did its job, since both threads saw a fresh value, yet the steps still overlapped.

Use `AtomicInteger.incrementAndGet()`, or a lock around the whole sequence. Keep `volatile` for simple cases, such as a `stopped` flag that one thread sets and others only read.

**3. Slow work inside a lock.** Only one thread can hold a lock at a time, and the others wait in line. Say 50 requests arrive together, and each calls a payment service for 200 ms while holding the lock. The last request waits 50 × 0.2 = 10 seconds.

Lock only the quick check and update. If you need a slow call, first mark the item as reserved inside the lock, then make the call outside it, and undo the reservation if the call fails. That way the check and the act stay together, and the line stays short.

The smaller pitfalls, in short:

- **Slow or recursive work in `computeIfAbsent`.** The map locks part of itself while your function runs. A slow function blocks others, and a function that modifies the same map can throw an exception or deadlock.
- **"It hasn't happened in months."** A race that needs microsecond timing may wait for a traffic spike. Absence of failures is not proof of safety.

## Which should you use?

| Situation | Reach for |
|---|---|
| A counter shared between threads | **`AtomicInteger` / `AtomicLong`,** or `LongAdder` for heavy contention (many threads fighting over one value) |
| "Add to map if missing" | **`computeIfAbsent`, `putIfAbsent` or `merge`** |
| A multi-step update in one process | **A lock** around the whole sequence, held briefly |
| "Do this only once" across several servers | **A conditional `UPDATE` or a unique constraint** in the database |
| Read, change, write back across servers | **Optimistic locking** with a version column |
| Something that must not run twice, and no database fits | **A distributed lock,** with a timeout, as a last resort. A lock can expire while its holder is still working, so make the work safe to repeat |

If you are not sure, assume the gap exists and ask the database to enforce the rule. A constraint in the database holds even when the code around it is wrong.

## The takeaway

1. A **check, then act** is two steps with a gap, and another thread can slip into that gap.
2. Each step can be thread-safe while the pair is not.
3. Races are **rare, random and load-dependent**, which is why tests pass and production fails. Reproduce them with a stress test.
4. Fix them by making the check and the act **one atomic step**: atomic classes and `computeIfAbsent` in a process, a conditional `UPDATE` or a unique constraint across servers.
5. A lock inside one process protects nothing once you scale out. **Let the shared database be the referee.**
