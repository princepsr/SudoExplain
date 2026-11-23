---
title: Java thread deadlock: find it with a thread dump
date: 2026-11-23
description: A Java thread deadlock hangs requests while CPU stays idle. See how to find it with a thread dump, read the report, and fix it with lock ordering.
tags: java, concurrency
---

## The question

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
> 4. The fixes: consistent lock order, timeouts, short lock times, and safer tools

## First, locks in Java

A **thread** is one line of execution inside a program. A web server runs many at once. When two threads touch the same data, they can corrupt it, so Java lets one thread take a **lock** first. In Java, `synchronized (x) { ... }` takes the lock attached to object `x`. Any other thread that wants that same lock must **block**, which means it waits and uses no CPU.

Picture a bathroom key at a cafe. Whoever holds the key is inside, and everyone else queues. That works while each person needs one key. It fails when one person holds the key to room A and waits for room B, while another holds B and waits for A.

Unlike a person, a Java thread cannot give up politely. A thread waiting on `synchronized` waits **forever**. The JVM does not detect this while running and does not abort anyone. It only reports the circle when you ask for a thread dump.

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

A database can have the same circle between two transactions. The shape is the same, but the ending is not.

| | Database deadlock | Java thread deadlock |
|---|---|---|
| Who detects it | The database, automatically | **Nobody, automatically** |
| What happens | One transaction is aborted | **Threads wait forever** |
| What you see | An error you can retry | A silent hang |
| What fixes it | Lock order, then retry | Lock order, and a dump to find where the circle forms |

A database can roll a transaction back. A JVM cannot undo a half-finished method, so it leaves the threads where they are.

## How to diagnose it

**1. Capture a thread dump.** A **thread dump** is a snapshot of what every thread is doing and which locks it holds. [Reading a thread dump](/posts/java-thread-dump-find-lock-owner/) shows how to take one and what its lines mean, so here we only need this:

```bash
jcmd <pid> Thread.print > dump.txt
```

Take two or three dumps ten seconds apart. Threads that show the same stack each time are stuck, not just slow.

**2. Search for the report.** When the JVM prints a dump, it also checks for a circle of locks. This is trimmed output from the real run above (JDK 21.0.2). [The whole dump](/code/java-thread-deadlock/deadlock-jcmd-java21.txt) is a download:

```text
Found one Java-level deadlock:
=============================
"transfer-1":
  waiting to lock monitor 0x00000221a373cdf0 (object 0x0000000626d90fe0, a java.lang.Object),
  which is held by "transfer-2"

"transfer-2":
  waiting to lock monitor 0x00000221a373f470 (object 0x0000000626d90fd0, a java.lang.Object),
  which is held by "transfer-1"

Java stack information for the threads listed above:
"transfer-1":
	at Deadlock.transfer(Deadlock.java:19)
	- waiting to lock <0x0000000626d90fe0> (a java.lang.Object)
	- locked <0x0000000626d90fd0> (a java.lang.Object)
```

Read it like a sentence. Thread 1 waits for a lock held by thread 2, and thread 2 waits for a lock held by thread 1. A "monitor" is the lock behind `synchronized`. The `at` lines give the method and line where each thread is stuck. In my run the line number is one more than the line of the second `synchronized` in the code, so it can be off by one.

**3. Check the thread state.** Each stuck thread shows `BLOCKED (on object monitor)`. A hung service full of `BLOCKED` threads and zero CPU is the classic signature. If the threads are `BLOCKED` but the report says "no deadlock", they are queuing behind one slow thread, and [following the lock to its owner](/posts/java-thread-dump-find-lock-owner/) finds it.

**4. Detect it from inside the app.** The JDK class `ThreadMXBean` has a method `findDeadlockedThreads()` that returns the ids of threads in a circle, or `null` if there is none. Some teams call it from a health endpoint, so an alert fires instead of someone finding the hang by hand:

```java
ThreadMXBean threads = ManagementFactory.getThreadMXBean();
long[] ids = threads.findDeadlockedThreads();   // null when none
if (ids != null) {
    for (ThreadInfo info : threads.getThreadInfo(ids)) {
        System.out.println(info.getThreadName() + " waits for a lock held by "
                + info.getLockOwnerName());
    }
}
```

On the demo program it printed `transfer-1 waits for a lock held by transfer-2` and the same line the other way round. [The full program](/code/java-thread-deadlock/DetectDeadlock.java) is a download.

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

I ran this version with opposite-direction transfers, and both finished. It costs nothing at run time. The cost is discipline: the order must be a rule the whole team knows. [The full program](/code/java-thread-deadlock/OrderedTransfer.java) is a download.

## Fix 2: use `tryLock` with a timeout

A `synchronized` lock waits forever. A `ReentrantLock` (another Java lock) can give up. `tryLock(1, TimeUnit.SECONDS)` waits at most one second and returns `false` if it did not get the lock:

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

I ran the opposite-order transfers with this code. Both threads waited one second, then both gave up. A timeout does not make the work succeed. It turns a silent hang into a failure you can log and retry, so check for `false` and do not ignore it.

## Fix 3: hold locks for as short a time as possible

A circle needs threads that hold locks for a long time. So do slow work, such as a network call, before you take the lock:

```java
// Slow: the lock is held during the network call
synchronized (account) {
    double rate = rateService.fetch();   // takes seconds
    account.multiplyBalance(rate);
}

// Better: call first, lock only for the quick update
double rate = rateService.fetch();
synchronized (account) {
    account.multiplyBalance(rate);
}
```

Also prefer tools that lock for you, such as `ConcurrentHashMap` and atomic classes. Then you take fewer locks by hand.

## When the fix goes wrong

A fixed lock order only works for the locks you can see.

**1. A hidden lock in code you call.** Say `transfer()` locks two accounts in sorted order, and then, still holding both, calls a listener. A **listener** is code passed in from outside. This one takes an audit lock. Elsewhere, an audit report takes the audit lock first, and then needs an account lock (a made-up case):

```text
transfer thread:  account lock -> audit lock
report thread:    audit lock   -> account lock
```

That is the same circle, with one lock hidden in another class. Each class looks correct on its own, so reading one file does not find it.

**What to do instead.** Do not call outside code while you hold a lock. Release the locks first, then call it. Every place that takes these locks must also follow the same order.

**2. A timeout that is ignored or retried at once.** If the code ignores the `false` result, the transfer is silently skipped and the money never moves. If it retries at once, two threads that failed together try again together, and keep failing together.

**What to do instead.** Treat `false` as a real result: log it, and return an error or queue the work. If you retry, wait a short random time first, and give up after a few attempts.

**3. A hang with no lock in it.** Some hangs look like a deadlock, but the dump shows no deadlock report because no lock is involved. Here the circle is made of a thread pool and its waiting line. A **thread pool** is a fixed group of worker threads that run tasks, and a task that finds every worker busy waits in a **queue**. [The thread pool post](/posts/unbounded-thread-pool-queue/) explains both.

The smallest case is a pool with one worker. A task inside it asks the same pool to run a second task, and then waits for the answer:

```java
ExecutorService pool = Executors.newFixedThreadPool(1);
pool.submit(() -> {
    Future<String> inner = pool.submit(() -> "inner result");
    return inner.get();    // waits until the inner task is done
});
```

Follow it step by step:

1. The outer task starts on the only worker.
2. The outer task submits the inner task. The worker is busy, so the inner task waits in the queue.
3. The outer task calls `inner.get()`, which waits until the inner task has finished.
4. The inner task waits for a free worker. The only worker is the outer task, and it is waiting for the inner task.

Each waits for the other, so nothing ever moves. A bigger pool does not remove the problem. With 10 workers, 10 outer tasks arriving together take all 10, and their 10 inner tasks wait in the queue behind them.

I ran the one-worker version on JDK 21.0.2. The dump had no deadlock report, and the worker showed `WAITING` inside `FutureTask.get`. [The full program](/code/java-thread-deadlock/PoolWait.java) and [its dump](/code/java-thread-deadlock/pool-wait-jcmd-java21.txt) are downloads.

**What to do instead.** Do not wait for a task from the same pool inside a task. Use a separate pool for the inner work.

## Which should you use?

| Situation | Reach for |
|---|---|
| You know all the locks involved | **A fixed order** |
| Locks come from code you cannot control | **`tryLock` with a timeout** |
| A lock is held across slow work | **Hold the lock for less time** |
| You lock only to protect a map or counter | **A concurrent collection or atomic class** |

If you are not sure, take a thread dump during the hang. The report names the threads, the locks and the lines, so you rarely need to guess.

## See it yourself

Save the program above as `Deadlock.java`. Run it with `java Deadlock.java`. In a second terminal, run `jcmd` to find its id, then `jcmd <pid> Thread.print`. Find the deadlock report.

> [!WARNING]
> The program never ends by itself. Stop it with Ctrl+C when you are done, and run it only on your own machine.

Files from my runs on JDK 21.0.2:

- [deadlock-jcmd-java21.txt](/code/java-thread-deadlock/deadlock-jcmd-java21.txt): the whole thread dump of `Deadlock.java`
- [OrderedTransfer.java](/code/java-thread-deadlock/OrderedTransfer.java): Fix 1 as a full program
- [TryLockTransfer.java](/code/java-thread-deadlock/TryLockTransfer.java): Fix 2 as a full program
- [DetectDeadlock.java](/code/java-thread-deadlock/DetectDeadlock.java): the `ThreadMXBean` check as a full program
- [PoolWait.java](/code/java-thread-deadlock/PoolWait.java) and [pool-wait-jcmd-java21.txt](/code/java-thread-deadlock/pool-wait-jcmd-java21.txt): the pool hang and its dump

## The takeaway

1. A **deadlock** is a circle of waiting: each thread holds a lock the next one needs.
2. The signature is **hung requests, idle CPU**, and threads stuck in `BLOCKED`.
3. A JVM does **not** break the circle for you, unlike a database.
4. Capture a dump with **`jcmd <pid> Thread.print`** and read "Found one Java-level deadlock".
5. Prevent it with **one lock order**, timeouts where you cannot control order, and short lock times.
