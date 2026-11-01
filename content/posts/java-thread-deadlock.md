---
title: Java thread deadlock: find it with a thread dump
date: 2026-11-01
description: A Java thread deadlock hangs requests while CPU stays idle. See how to find it with a thread dump, read the report, and fix it with lock ordering.
tags: java, concurrency, debugging
draft: true
---

## The doubt

A service that normally answers in milliseconds starts hanging. Some requests never return. The load balancer marks instances unhealthy one by one. Yet CPU is near zero, memory is flat, and there is not one error in the log.

A restart fixes it for a few hours. Then it comes back.

> Nothing is busy, nothing has crashed, and still nothing moves. What are the threads doing?

They are waiting for each other. This post shows what that looks like in a thread dump, which takes about a minute to capture, and how to prevent it.

> [!SUMMARY]
> By the end you will know:
>
> 1. How `synchronized` locks work, and how two threads can wait on each other forever
> 2. How to capture a **thread dump** and read the "Found one Java-level deadlock" section
> 3. How this differs from a database deadlock
> 4. The fixes: consistent lock order, timeouts, small lock scope, and safer tools

## First, locks in Java

A **thread** is one line of execution inside a program. A web server runs many at once. When two threads touch the same data, they can corrupt it, so Java lets one thread take a **lock** first. In Java, `synchronized (x) { ... }` takes the lock attached to object `x`. Any other thread that wants that same lock must **block**, which means it waits and uses no CPU.

Picture a bathroom key at a cafe. Whoever holds the key is inside, and everyone else queues. That works while each person needs one key. It fails when one person holds the key to room A and waits for room B, while another holds B and waits for A.

Unlike a person, a Java thread cannot give up politely. A thread waiting on `synchronized` waits **forever**. The JVM (Java Virtual Machine, the program that runs your code) does not detect this while running and does not abort anyone. It only reports the cycle when you ask for a thread dump.

## The failure: two threads, two locks, opposite order

This program moves money between two accounts. The two threads take the same two locks in opposite order. I ran this exact program on JDK 21:

```java
public class Deadlock {
    static final Object ACCOUNT_A = new Object();
    static final Object ACCOUNT_B = new Object();

    public static void main(String[] args) throws Exception {
        Thread t1 = new Thread(() -> transfer(ACCOUNT_A, ACCOUNT_B), "transfer-1");
        Thread t2 = new Thread(() -> transfer(ACCOUNT_B, ACCOUNT_A), "transfer-2");
        t1.start();
        t2.start();
        t1.join();
        t2.join();
        System.out.println("done");
    }

    static void transfer(Object from, Object to) {
        synchronized (from) {
            pause(200);                  // stands in for real work
            synchronized (to) {
                System.out.println(Thread.currentThread().getName() + " finished");
            }
        }
    }

    static void pause(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

It prints nothing and never ends. Here is the timeline:

```diagram
type: sequence
alt: Thread 1 holds lock A and wants lock B while thread 2 holds lock B and wants lock A, so both wait forever.
caption: Figure 1. Each thread holds one lock and waits for the other. Neither can ever continue.
actors: Thread 1 | Thread 2 | Lock A | Lock B
Thread 1 -> Lock A: lock A (granted)
Thread 2 -> Lock B: lock B (granted)
Thread 1 -> Lock B: wants B ... blocked
Thread 2 -> Lock A: wants A ... blocked
note all: circle: both blocked forever !
```

The `pause(200)` makes the bad timing certain. Without it, the program would usually finish, because one thread would grab both locks before the other started. That is why this bug passes tests and fails under production load: it needs unlucky timing.

## How this differs from a database deadlock

[The database deadlocks post](/posts/database-deadlocks/) covers the same circle inside a database. The shape is the same, but the ending is not.

| | Database deadlock | Java thread deadlock |
|---|---|---|
| Who detects it | The database, automatically | **Nobody, automatically** |
| What happens | One transaction is aborted | **Threads wait forever** |
| What you see | An error you can retry | A silent hang |
| What fixes it | Lock order, then retry | Lock order, then a restart until fixed |

A database can roll a transaction back. A JVM cannot undo a half-finished method, so it leaves the threads where they are.

## How to diagnose it

**1. Find the process id.** `jcmd` with no arguments lists running Java processes:

```bash
jcmd
```

**2. Capture a thread dump.** A **thread dump** is a snapshot of what every thread is doing and which locks it holds:

```bash
jcmd <pid> Thread.print > dump.txt
```

Take two or three dumps ten seconds apart. Threads that show the same stack each time are stuck, not just slow.

**3. Search for the report.** The JVM checks for lock cycles when it prints a dump. This is trimmed output from the real run above:

```text
Found one Java-level deadlock:
=============================
"transfer-1":
  waiting to lock monitor 0x000002b638772980 (object 0x0000000628201fc0, a java.lang.Object),
  which is held by "transfer-2"

"transfer-2":
  waiting to lock monitor 0x000002b638772a60 (object 0x0000000628201fb0, a java.lang.Object),
  which is held by "transfer-1"

Java stack information for the threads listed above:
"transfer-1":
	at Deadlock.transfer(Deadlock.java:19)
	- waiting to lock <0x0000000628201fc0> (a java.lang.Object)
	- locked <0x0000000628201fb0> (a java.lang.Object)
```

Read it like a sentence. Thread 1 waits for a lock held by thread 2, and thread 2 waits for a lock held by thread 1. The `at` lines give the method and line where each thread is stuck. A `monitor` is the lock behind `synchronized`.

**4. Check the thread state.** Each stuck thread shows `BLOCKED (on object monitor)`. A hung service full of `BLOCKED` threads and zero CPU is the classic signature.

**5. Detect it from inside the app.** The JDK class `ThreadMXBean` has a method `findDeadlockedThreads()` that returns the ids of threads in a cycle. Some teams call it from a health endpoint.

## Fix 1: take locks in one agreed order

If every thread takes lock A before lock B, a circle cannot form. Decide an order, for example by account id, and always follow it:

```java
static void transfer(Account from, Account to) {
    Account first = from.id() < to.id() ? from : to;
    Account second = first == from ? to : from;
    synchronized (first) {
        synchronized (second) {
            // move the money
        }
    }
}
```

I ran this version with opposite-direction transfers, and both finished. It costs nothing at run time. The cost is discipline: the order must be a rule the whole team knows.

## Fix 2: use `tryLock` with a timeout

`ReentrantLock` (a lock class in `java.util.concurrent.locks`) can give up. `tryLock(1, TimeUnit.SECONDS)` returns `false` if it cannot get the lock in time:

```java
if (!from.lock().tryLock(1, TimeUnit.SECONDS)) return false;
try {
    if (!to.lock().tryLock(1, TimeUnit.SECONDS)) return false;
    try {
        // move the money
        return true;
    } finally {
        to.lock().unlock();
    }
} finally {
    from.lock().unlock();
}
```

A timeout turns a silent hang into a failure you can log and retry. The cost is more code, and you must handle `false`. Retrying with no pause can make threads collide again, so add a short random delay.

## Fix 3: keep locks small and avoid foreign code

- **Hold a lock for as little time as possible.** Do the slow work, such as a network call, outside it.
- **Never call code you do not control while holding a lock.** A listener, a callback or an overridable method might take another lock, and you cannot see the order.
- **Prefer higher-level tools.** Concurrent collections such as `ConcurrentHashMap`, atomic classes and executors handle locking for you, so you take fewer locks by hand.

## When the fix goes wrong

A fixed lock order only works for the locks you can see. These are the traps that survive a code review.

**1. A hidden lock behind a callback.** The thinking: "We sort the locks by account id, so a circle cannot form." That is true for the two account locks. But suppose `transfer()` also tells a listener about the move while it still holds both locks. The listener is a **callback**, which is code passed in from outside. Say it takes an audit lock.

Elsewhere, an audit report takes the audit lock first, and then reads an account balance, which needs the account lock. Now look at the order (a made-up case):

```text
transfer thread:  account lock -> audit lock
report thread:    audit lock   -> account lock
```

That is the same circle as before, with one lock hidden in another class. Each class looks correct on its own, so reading one file does not find it. The same happens when a method you call is `synchronized` and you did not know.

**What to do instead.** Do not call outside code while you hold a lock. Collect what the listener needs, release the locks, and then call it. If you cannot avoid it, put the extra lock into the written order, so that everything touching the audit lock agrees on where it comes in. If you miss one, a thread dump will still name the lines.

**2. A timeout that is ignored or retried at once.** `tryLock` with a timeout turns a hang into a failure. But what the code does after the failure matters.

If the code ignores the `false` result, the transfer is silently skipped. Nobody sees an error, and the money never moves. If the code retries at once, two threads that failed together will usually try again together. Each takes its first lock, waits for the second, times out, and repeats. They are no longer stuck for good, but they can keep failing for a long time. Threads that stay busy and never finish are called a **livelock**.

**What to do instead.** Treat `false` as a real result: log it, and return an error or queue the work. If you retry, wait a short random time first, so the threads stop moving in step, and give up after a few attempts.

Smaller traps:

- **Ordering that skips some paths.** Sorting in `transfer()` does not help if another method locks the same objects another way.
- **Believing a restart is a fix.** It clears the hang and keeps the bug.

## Which should you use?

| Situation | Reach for |
|---|---|
| You know all the locks involved | **A fixed order** |
| Locks come from code you cannot control | **`tryLock` with a timeout** |
| A lock is held across slow work | **Shrink the lock scope** |
| You lock only to protect a map or counter | **A concurrent collection or atomic class** |

If you are not sure, take a thread dump during the hang. The report names the threads, the locks and the lines, so you rarely need to guess.

## See it yourself

Save the program above as `Deadlock.java`. Run it with `java Deadlock.java`. In a second terminal, run `jcmd` to find its id, then `jcmd <pid> Thread.print`. Find the deadlock report.

> [!WARNING]
> The program never ends by itself. Stop it with Ctrl+C when you are done, and run it only on your own machine.

## The takeaway

1. A **deadlock** is a circle of waiting: each thread holds a lock the next one needs.
2. The signature is **hung requests, idle CPU**, and threads stuck in `BLOCKED`.
3. A JVM does **not** break the circle for you, unlike a database.
4. Capture a dump with **`jcmd <pid> Thread.print`** and read "Found one Java-level deadlock".
5. Prevent it with **one lock order**, timeouts where you cannot control order, and small lock scopes.
