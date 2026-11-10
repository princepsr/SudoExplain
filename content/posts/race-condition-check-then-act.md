---
title: Race condition in Java: check-then-act explained
date: 2026-11-08
description: Why code that looks correct loses updates or creates duplicates under load, how to reproduce a race condition, and how to fix it on one server and across many.
tags: java, concurrency
---

## The question

A coupon can be used only once. The code checks that it is unused, applies the discount, then marks it used. Tests pass. But in production, a few coupons get used twice.

> The code checks first, so how can it still do it twice?

Between the check and the action, another request got in. Think of two people booking the last theater seat. Both see one seat free, and both press "buy".

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **race condition** is and why a "check, then act" sequence is vulnerable
> 2. Four classic shapes: double redemption, lost counter updates, duplicate rows, and work done twice in a map
> 3. How to **reproduce** one on purpose, and how to spot one in review
> 4. Two fixes: one for data in your program's memory, and one for data in the database, which also works across several servers

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

Both checked before either one updated. That is a **race condition**: the threads race each other, and the result depends on who gets there first. Run in one order, the code is correct. Run in another order, it is wrong. The gap is tiny, a few microseconds, so tests almost never hit it, but a busy server hits it every day.

Even `count++` is a sequence in disguise: read the value, add one, write it back. Two threads can read 5, both write 6, and one increment is lost.

## Reproduce it on purpose

A race you cannot reproduce is a race you cannot fix. This program lets 100 tasks add 100 each to a plain `int`:

```java
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class Race {
    static int plain = 0;
    static AtomicInteger atomic = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(8);
        for (int i = 0; i < 100; i++) {
            pool.submit(() -> {
                for (int j = 0; j < 100; j++) {
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

The right answer is 10,000. Here is one run (Java 21, 12 cores):

```text
plain=7306 atomic=10000
```

About a quarter of the updates vanished, with no exception and no warning. The number changes on every run, which is the fingerprint of a race. On a machine with few cores you may see less loss, so raise the iteration counts if you see none.

## The same bug in other clothes

**Duplicated work and overwritten values.** A `ConcurrentHashMap` is a map made for many threads at once. Each single call on it, such as `containsKey` or `put`, is safe: two threads can never break the map by calling it together. But two safe calls in a row still leave a gap between them:

```java
if (!map.containsKey(key)) {      // thread B can get here too
    map.put(key, expensiveValue(key));
}
```

Say the key is missing. Thread A checks and sees "missing". Before A puts anything, thread B checks and also sees "missing". Both now do the slow work, and both put. The second `put` overwrites the first, so the work was done twice, and A may keep using a value that is no longer in the map. The map was never damaged. The check and the put just were not one step.

**Duplicate rows in a database.** "Select, and insert if none found" has the same gap, even across separate servers:

```sql
SELECT count(*) FROM users WHERE email = 'a@example.com';   -- 0, for both requests
INSERT INTO users (email) VALUES ('a@example.com');         -- both succeed
```

**A related mistake: a plain `HashMap` shared between threads.** This is not a gap between two steps. A `HashMap` is not built for several threads. Even one `put` is unsafe when two threads do it together. An entry can vanish or the size can be wrong, and nothing tells you. If several threads write to one map, use a `ConcurrentHashMap`. If only one thread uses it, a `HashMap` is fine.

## How to spot it

**In review,** look for the pattern *read shared state, decide, then write shared state*. Whenever two steps depend on each other, ask: "What if another thread does the same thing in between?"

**In production,** the signs are numbers that are slightly off, or duplicates even though the code checks first. A race can stay quiet for months and then show up in a traffic spike. To test for one, run the suspicious code from many threads, like the program above, and check the final result.

## Fix 1: data in memory (one process)

Every fix has the same idea: make the check and the act **one step**, so nothing can slip in between. Fix 1 is for data that lives in your program's memory, such as a counter or a map. Here Java makes it one step, with operations that are **atomic**: they happen completely or not at all.

These do the check and the act as one step:

```java
atomic.incrementAndGet();                 // instead of count++
map.computeIfAbsent(key, k -> load(k));   // instead of containsKey + put
map.merge(key, 1, Integer::sum);          // instead of get + put (counts in a Map<K, Integer>)
```

Keep the function you pass to `computeIfAbsent` short. While it runs, the map keeps a lock on the spot where your key is stored, so other threads that need the same spot must wait. A slow function means a long wait. Do not change the same map inside it either, or the code can fail or get stuck.

If your logic is bigger than one of these, protect the whole sequence with a **lock**, so only one thread at a time can run it:

```java
synchronized (couponLock) {
    if (!coupon.isUsed()) {
        applyDiscount();
        coupon.markUsed();
    }
}
```

A lock is simple, but it has two problems:

- **A stale copy.** It works only if every thread uses the same coupon object in memory. If each request loads its own copy from the database, the copy can be out of date by the time the thread gets the lock, and two threads can still both see "unused".
- **Everyone waits.** One lock for all coupons makes every redemption wait in line, even for different coupons.

When the data lives in the database, Fix 2 avoids both problems.

## Fix 2: data in the database (many servers)

Fix 2 is for data that lives in the database, or when you run more than one server. Here the database makes the check and the act one step. It solves what a Java lock cannot: the stale copy, everyone waiting, and several servers. A lock inside one Java process protects nothing once you have three servers, because each has its own lock. The one place all servers share is the database, so make **it** the referee.

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

**Duplicate rows: use a unique constraint.** The coupon trick fits "use it once". For rows that must not repeat, such as two sign-ups with the same email, use a **unique constraint**. It is a rule the database enforces: it refuses a second row with the same value.

```sql
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
```

If duplicates already exist, this command fails, so clean them up first.

Now skip the "select first" check and just insert. When two requests arrive together, the database accepts one and refuses the other, so no gap is left. You then choose how to handle the refused one:

```sql
-- Option 1: skip a duplicate quietly (PostgreSQL syntax)
INSERT INTO users (email) VALUES ('a@example.com')
ON CONFLICT DO NOTHING;
-- rows affected: 1 -> new user, 0 -> it already existed
```

Option 2 is to insert normally and catch the duplicate-key error in Java. PostgreSQL reports it with the code `23505`. Either way, the database decides, not your code.

A unique constraint is also what makes an [idempotency key](/posts/idempotency-key-double-charge/) work: it stops a retried request from doing the work twice.

**Counters: let the database add.** `UPDATE stats SET hits = hits + 1 WHERE id = 1` is one atomic step. Reading the value in Java and writing it back is not.

**When one statement is not enough: a version number.** Always try one statement first, like `hits = hits + 1`. Sometimes it is not possible, because the new value does not come from the database. Say an admin opens a product page, thinks for a minute, and saves a new price. In that minute, another admin saved a change to the same product. A plain `UPDATE` would quietly overwrite that change. The database cannot work out the new price by itself, because a person chose it.

The trick is to add a `version` column that goes up by 1 on every change:

```sql
-- when the page opened, the row was at version 5
UPDATE products
SET price = 25, version = 6
WHERE id = 7 AND version = 5;
-- rows affected: 1 -> nobody changed it, saved
-- rows affected: 0 -> someone saved first, show the new values
```

You are saying "save this, but only if the row is still at version 5". If another request saved first, the row is at version 6, so your update changes nothing, and you show the person the latest values instead of overwriting them. This is called **optimistic locking**: you do not lock the row, you hope nobody else changes it, and you check at the end. It is a topic of its own.

The database serializes these steps for you, and correctness no longer depends on how many servers there are.

## When the fix goes wrong

Two mistakes catch people most often, and both look like fixes.

**1. Using `volatile` as a cure.** A thread can keep its own copy of a variable and miss another thread's change. `volatile` fixes that: every thread reads the latest value. This is called **visibility**. A race is a different problem: another thread changes the value between my read and my write. `volatile` fixes only visibility.

Say `count` is 5 and two threads run `count++`, which is read, add 1, write:

```text
Thread A reads count    -> 5
Thread B reads count    -> 5   (A has not written yet)
Thread A writes 5 + 1   -> 6
Thread B writes 5 + 1   -> 6
```

Two increments ran, but the count went from 5 to 6, not 7. Every read was up to date, and the update was still lost. Use `AtomicInteger.incrementAndGet()` or a lock around the whole sequence.

`volatile` is right for a simple stop flag. One thread loops while `!stopped`, and another sets `stopped = true`. Without `volatile`, the loop may never see the change. There is no race, because the only step is one write and nobody reads the flag first. If a thread must check the flag before setting it, use `AtomicBoolean`.

**2. Slow work inside a lock.** A lock lets one thread in at a time, and the others wait in line. If the thread holding the lock does something slow, everyone waits. Say 50 requests arrive together, and each calls a payment service for 200 ms while holding the lock. The last request waits 50 × 0.2 = 10 seconds.

**What to do instead.** Hold the lock only for the quick part. For the coupon, that means three steps:

1. **Inside the lock (quick):** check that the coupon is unused, and mark it "reserved".
2. **Outside the lock (slow):** call the payment service. Other threads are not blocked now.
3. **If the call fails:** mark the coupon unused again.

The coupon was reserved inside the lock, so no other thread can take it while the slow call runs.

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
