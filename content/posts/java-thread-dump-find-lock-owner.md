---
title: "Java thread dump: find the lock owner of BLOCKED threads"
date: 2026-11-21
description: How to read a Java thread dump: what RUNNABLE, BLOCKED and WAITING mean, how to follow a lock to its owner, and a real editor freeze as an example.
tags: java, concurrency, performance
---

## The question

A Java service hangs. Requests pile up, but the CPU (the chip that does the computing) is nearly idle and nothing crashes. You take a **thread dump**, a text snapshot of what every thread in the program is doing right now, and 200 threads are marked `BLOCKED`.

> There are 200 stuck threads. Which one do I look at?

None of the 200. The cause is the one thread they are all waiting for, and the dump tells you which thread that is.

> [!SUMMARY]
> By the end you will know:
>
> 1. What `RUNNABLE`, `BLOCKED` and `WAITING` mean in a thread dump
> 2. How to follow a lock from the waiting threads to its **owner**
> 3. Why the owner can look healthy, and how a real code-editor freeze showed it
> 4. The fixes, and the two ways they go wrong

## First, what a thread dump says

A **thread** is one line of execution inside a program. A web server runs many at once. When two threads change the same data they can corrupt it, so Java lets one thread take a **lock** first. In Java, `synchronized (x) { ... }` takes the lock that belongs to object `x`. Any other thread that wants the same lock must wait.

Picture a shop with one till. One customer is being served and everyone else queues. If that customer takes one second, nobody notices. If that customer starts a long argument, the whole queue stops, even though everyone behind only needs a moment.

A thread dump shows every thread's name, its **state**, and its **stack**: the chain of method calls the thread is inside, newest first. Each call is one line starting with `at`. The state is the part to learn first:

| State | What it means |
|---|---|
| `RUNNABLE` | Running, ready to run, or waiting for the operating system to finish a job like a network read. It does **not** mean the thread uses CPU |
| `BLOCKED` | Waiting to enter a `synchronized` block that another thread holds |
| `WAITING`, `TIMED_WAITING` | Waiting for a signal, or for a time limit such as `sleep`. Not waiting for a `synchronized` lock |

A `BLOCKED` thread is a victim. It is stuck because of someone else, so its own stack shows nothing wrong with it.

## The failure: one slow thread holds the lock

Here is a small program that shows the pattern. One thread takes a lock and holds it for ten minutes, which stands in for a slow call. Three more threads need the lock for one millisecond each. `Thread.sleep(ms)` pauses a thread for that many milliseconds. I ran this on OpenJDK 21.0.2:

```java
public class SlowLock {
    static final Object LOCK = new Object();

    static void work(long ms) {
        synchronized (LOCK) {
            try {
                Thread.sleep(ms);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    static Thread start(String name, long ms) {
        Thread t = new Thread(() -> work(ms), name);
        t.start();
        return t;
    }

    public static void main(String[] args) throws Exception {
        // takes the lock and holds it for ten minutes
        start("git-loader", 600_000);
        Thread.sleep(300);
        // each needs the lock for 1 ms, but must wait for it
        start("npm-registry", 1);
        start("build-manager", 1);
        start("hardware-check", 1);
        Thread.sleep(600_000);
    }
}
```

```diagram
type: flow
alt: One thread takes a lock and works for a long time, so three other threads wait for the lock and are BLOCKED.
caption: Figure 1. The three waiting threads need only a moment. The lock owner is slow.
git-loader takes the lock -> It works for a long time -> Three threads wait for the lock -> They are BLOCKED !
```

The lock is not the bug. Three one-millisecond jobs would finish at once. The bug is the **slow work inside the lock**, because it turns a short queue into a long one.

## Read the dump in four steps

I captured a dump of the running program with `jstack <pid>`. It is a tool from the JDK (Java Development Kit, the tools that come with Java), and it prints the same dump as `jcmd <pid> Thread.print`. The `<pid>` is the program's process id, which `jcmd` with no arguments lists. This is the real output, trimmed to the four threads and their first lines:

```text
"git-loader"
   java.lang.Thread.State: TIMED_WAITING (sleeping)
	at java.lang.Thread.sleep(Thread.java:509)
	at SlowLock.work(SlowLock.java:7)
	- locked <0x0000000628202858> (a java.lang.Object)

"npm-registry"
   java.lang.Thread.State: BLOCKED (on object monitor)
	at SlowLock.work(SlowLock.java:7)
	- waiting to lock <0x0000000628202858> (a java.lang.Object)

"build-manager"
   java.lang.Thread.State: BLOCKED (on object monitor)
	at SlowLock.work(SlowLock.java:7)
	- waiting to lock <0x0000000628202858> (a java.lang.Object)

"hardware-check"
   java.lang.Thread.State: BLOCKED (on object monitor)
	at SlowLock.work(SlowLock.java:7)
	- waiting to lock <0x0000000628202858> (a java.lang.Object)
```

Every Java object has a built-in lock, called its **monitor**, and `synchronized` takes it. So "BLOCKED (on object monitor)" means the thread is waiting for an object's lock. Now follow the lock:

**1. Count the states.** A few `BLOCKED` threads are normal. Dozens or hundreds, with idle CPU, mean a queue behind one lock.

**2. Group the waiting threads by lock.** Each `waiting to lock <0x...>` line names the lock it wants. The long number is the lock's address in memory, and it works as the lock's name. Three threads with the same number are in the same queue. On Linux or macOS, this prints each lock and how many threads wait for it:

```bash
grep "waiting to lock" dump.txt | sort | uniq -c
```

**3. Find the owner.** Search for the same number after the word `locked`. The thread with `- locked <0x0000000628202858>` is the owner. Here it is `git-loader`.

**4. Read the owner's stack.** The top lines say what it is doing while it holds the lock. Here it is inside `Thread.sleep`. In a real service it is more often a network read, a database call, or a file operation.

The owner's state can be anything. It can be `TIMED_WAITING` as here, `RUNNABLE` inside a network call, or even `BLOCKED` on a second lock. If the owner is blocked, repeat step 3 for its lock and keep going until you reach a thread that is not waiting for a lock. That thread is the root.

Take two or three dumps ten seconds apart. If the same thread owns the same lock each time, it is not a passing moment.

## How this differs from a deadlock

In a **deadlock**, threads wait for each other in a circle, and none of them can ever continue. The JVM prints a "Found one Java-level deadlock" report for it. [Deadlocks](/posts/java-thread-deadlock/) are a topic of their own.

Here there is no circle. The owner is still moving, only slowly. So the JVM prints no report, and you follow the lock yourself with the four steps above.

[The connection pool post](/posts/connection-pool-exhausted/) is close in topic too. There, threads wait in a queue for a database connection, and a dump shows them as `waiting on condition`, not `BLOCKED`. The waiting is real in both cases, but here the queue is a `synchronized` lock.

## A real example: a code-editor freeze

The same pattern appeared in a real freeze of IntelliJ IDEA, a Java editor. Its dump had 140 threads on Java 25.0.4 on Windows, and 17 were `BLOCKED`. This dump prints the owner on the waiting thread's line, as `owned by`, so step 3 is shorter. Trimmed to the key lines:

```text
"DefaultDispatcher-worker-17"
   State: RUNNABLE
	at java.lang.ProcessImpl.create(Native Method)
	at java.lang.ProcessBuilder.start(ProcessBuilder.java:1078)
	at git4idea.commands.GitLineHandler$1.<init>(GitLineHandler.java:154)
	...

"CustomNpmRegistryService"
   State: BLOCKED
   on java.lang.Class@1397910 owned by "DefaultDispatcher-worker-17"
	at java.lang.ProcessImpl.create(Native Method)
	...

"BuildManager Pool"
   State: BLOCKED
   on java.lang.Class@1397910 owned by "DefaultDispatcher-worker-17"
	at java.lang.ProcessImpl.create(Native Method)
	...

"DefaultDispatcher-worker-45"
   State: BLOCKED
   on java.lang.Class@1397910 owned by "DefaultDispatcher-worker-17"
	at java.lang.ProcessImpl.create(Native Method)
	...
	at kotlin.SynchronizedLazyImpl.getValue(LazyJVM.kt:86)
	...

"DefaultDispatcher-worker-10"
   State: BLOCKED
   on kotlin.SynchronizedLazyImpl@6c7d7fa8 owned by "DefaultDispatcher-worker-45"
	at kotlin.SynchronizedLazyImpl.getValue(LazyJVM.kt:81)
	...
```

Apply the steps:

1. **Group by lock.** 13 threads wait for `java.lang.Class@1397910`, and all 13 are inside `ProcessImpl.create`. That is the JDK code that asks the operating system to start a program. The dump shows that starting a program takes one lock shared by the whole JVM, so only one thread can start a program at a time.
2. **Find the owner.** All 13 name `DefaultDispatcher-worker-17`. It is `RUNNABLE`, but a **native call** (code outside Java, here in the operating system) is its top line. The stack below it shows the editor starting `git`. It is not computing. It is waiting for Windows to start a program.
3. **Spot the chain.** `worker-45` is also `BLOCKED` on that class lock, and it also owns a second lock, a Kotlin `lazy` (a value worked out once, on first use, under a lock). Four more threads wait for it. Counting 13 and 4 gives the 17 `BLOCKED` threads.

The npm helper, the build system and the CPU check do not need each other. They queued only because all of them needed to start a program.

What the thread dump does not tell us: why starting `git` was slow. It shows only that the operating system took a long time to start it, not why. It also does not explain why the editor window itself froze.

## Fix 1: do the slow work outside the lock

Keep inside the lock only what must be protected, and do the slow part before or after. This version does the slow work first and then takes the lock for a moment:

```java
static void work(long ms) {
    try {
        // slow part: no lock is held
        Thread.sleep(ms);
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    }
    // short part: the lock is held for a moment
    synchronized (LOCK) {
        started++;
    }
}
```

I ran four threads that each do two seconds of slow work. After half a second all four were `TIMED_WAITING` and none were `BLOCKED`, and the program finished with `started=4`. The cost is that shared data can change while you are outside the lock. Pitfall 1 below shows how.

## Fix 2: stop waiting forever

A thread waiting for `synchronized` waits without a limit. A `ReentrantLock` (a lock class in `java.util.concurrent.locks`) can give up after a time limit with `tryLock`. Then a slow owner becomes a quick failure you can log and retry, not a hang. The cost is that every caller must handle "I did not get the lock".

```java
// wait at most 1 second for the lock
if (LOCK.tryLock(1, TimeUnit.SECONDS)) {
    try {
        work();
    } finally {
        LOCK.unlock();
    }
} else {
    // gave up: log it, then retry or fail fast
}
```

In a test where another thread held the lock for 5 seconds, this gave up after about 1000 ms (Java 21.0.2). [TryLock.java](/code/java-thread-dump-find-lock-owner/TryLock.java) is the whole program.

## Fix 3: stop unrelated jobs sharing a lock

Git, npm and the build had no reason to wait for each other. If the lock is yours, give each job its own lock, or remove the lock. If it lives in the JDK or a library, as in the IDE case, you cannot split it. Then start fewer jobs at the same time, or fix the slow part itself.

## When the fix goes wrong

**1. Moving work out of the lock and losing the check.** The thinking: "The lock is held too long, so I will release it before the slow call." But suppose the code reads a balance, makes the slow call, and then writes the new balance. Two threads can do this together (a made-up case):

```text
thread A: lock, read balance = 100, unlock
thread B: lock, read balance = 100, unlock
thread A: slow call, lock, write 100 - 30 = 70, unlock
thread B: slow call, lock, write 100 - 30 = 70, unlock
```

Two withdrawals of 30 happened, and the balance is 70 and not 40. The read and the write used to be one protected step. Now another thread can slip in between. This is the check-then-act bug (look at a value, then act on it, with a gap in between) from [the race condition post](/posts/race-condition-check-then-act/).

**What to do instead.** Keep the check and the change together under one short lock. Do only the slow call outside. In steps: lock, check and reserve the amount, unlock, make the slow call, lock again, confirm or undo the reservation.

**2. Adding more threads.** The thinking: "200 threads are blocked, so a bigger pool of 400 will cope." A **pool** is a fixed group of threads that take jobs from a queue. If the owner holds the lock for 1 second and every job needs it, only one job finishes per second, however many threads you have. With 400 threads, 399 wait instead of 199, and each one also uses memory for its stack. More threads add cost and fix nothing. Shorten the time under the lock instead (Fix 1).

**3. Blaming the owner's own code.** If the owner is waiting on a remote service, the cause is that service. Read the top lines of the owner's stack to see what it waits for.

## Which should you use?

| Situation | Reach for |
|---|---|
| Slow work sits inside your lock | **Move it outside** (Fix 1), keeping the check and the change together |
| You cannot avoid a long wait | **`tryLock` with a timeout** (Fix 2) |
| Unrelated jobs share one lock | **Separate locks**, or fewer jobs at once (Fix 3) |
| The lock is inside the JDK or a library | **Reduce callers**, and fix the slow part |

If you are not sure, take two dumps, group the `BLOCKED` threads by lock, and read the owner's stack.

## See it yourself

Save the program above as `SlowLock.java` and run `java SlowLock.java`. In a second terminal run `jcmd`, find the id of `SlowLock`, then run `jcmd <pid> Thread.print`. Find `git-loader` and the three threads that wait for its lock.

Files from this post:

- [Fixed.java](/code/java-thread-dump-find-lock-owner/Fixed.java): the whole program with the slow work moved outside the lock (Fix 1)
- [slowlock-jstack-java21.txt](/code/java-thread-dump-find-lock-owner/slowlock-jstack-java21.txt): the thread dump I captured from it
- [TryLock.java](/code/java-thread-dump-find-lock-owner/TryLock.java): the `tryLock` test from Fix 2
- [ide-freeze-thread-dump-trimmed.txt](/code/java-thread-dump-find-lock-owner/ide-freeze-thread-dump-trimmed.txt): the trimmed dump from the editor freeze

> [!WARNING]
> The program runs for ten minutes. Stop it with Ctrl+C when you are done, and run it only on your own machine.

## The takeaway

1. A `BLOCKED` thread is a victim. Look for its **owner**.
2. Group `BLOCKED` threads by `waiting to lock <0x...>`, then find the same number after `locked`.
3. The owner can be in any state. Read its stack to see what it is waiting for, and follow the chain if it is blocked too.
4. Unlike a deadlock, there is no circle and **no report**. You follow the lock yourself.
5. Fix the slow work under the lock. More threads will not help.
