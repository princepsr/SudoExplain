---
title: Unbounded thread pool queue: how it hides overload
date: 2026-11-11
description: Why a thread pool with a fixed size still crashes under a traffic spike, how a hidden queue grows, and how to make overload fail fast instead.
tags: java, concurrency, performance
---

## The question

A Java service does its background work with a pool of ten threads, made with `Executors.newFixedThreadPool(10)`. It looks safe, because it can never use more than ten threads.

Then one day traffic doubles. No error appears, but responses get slower and slower, and an hour later the program crashes with `OutOfMemoryError`, the error Java throws when it has no memory left.

> I limited the threads to ten, so why did nothing stop the overload?

The limit was on the threads. It was not on the **work waiting for a thread**, and that waiting line had no limit at all. Think of a supermarket with ten checkout lanes and a line that can stretch down the street. Nobody is turned away, so nobody is told to go elsewhere.

> [!SUMMARY]
> By the end you will know:
>
> 1. Where the hidden queue in a thread pool is, and why it has no limit by default
> 2. How a queue turns a small overload into a slow, silent disaster
> 3. How to **diagnose** it from queue size, latency and heap
> 4. How to make overload fail fast, and the traps in each choice

## First, the pool and its queue

**Why a pool.** A server does many jobs at once, such as sending emails or resizing images. Each job runs on a **thread**, which is one line of work inside a program. Starting a new thread for every job is slow, and thousands of threads at once can use up the memory. So a program creates a few threads once and reuses them. This group of reusable threads is a **thread pool**, and its threads are called **workers**.

**What a task is.** A **task** is one job you hand to the pool, such as "send this email":

```java
ExecutorService pool = Executors.newFixedThreadPool(10);   // 10 workers
pool.submit(() -> sendEmail(user));                         // one task
```

**What happens when every worker is busy.** Say all 10 workers are busy and an 11th task arrives. The pool does not turn it away. It puts the task in a **queue**, which is a waiting line. When a worker becomes free, it takes the next task from the front. It is the supermarket again: ten lanes, and shoppers wait in one line.

```diagram
type: flow
alt: A submitted task waits in the queue until a worker is free, then runs.
caption: Figure 1. A task waits in the queue until a worker is free.
Task submitted -> All workers busy: task waits in the queue -> A worker becomes free -> Task runs
```

**How long can the line be?** Here is the catch. `newFixedThreadPool(10)` builds the line with **no limit**. A queue like this is called **unbounded**. Its capacity is about two billion tasks (`Integer.MAX_VALUE`), so in practice it is never full, and the pool never says "no". `newSingleThreadExecutor()` works the same way. You set the number of workers, the `10`. You never set a size for the line, so Java left it with no limit.

**The opposite mistake.** `newCachedThreadPool()` has no waiting line, but it has no limit on workers. A sudden burst of tasks creates thousands of threads, and the failure becomes `OutOfMemoryError: unable to create native thread`. So both shortcuts hide a missing limit: one on the line, the other on the workers.

**Frameworks do it too.** Spring Boot is a popular Java framework. Its default task executor, which runs methods marked `@Async` in the background, also has an unbounded queue unless you set `spring.task.execution.pool.queue-capacity`.

## The failure: demand above capacity, with nowhere to say no

Two terms first. **Throughput** is how many tasks finish per second. **Latency** is how long one task takes from the moment it arrives until it is done.

Say each task takes 100 ms. Ten threads can finish 100 tasks per second. Now requests arrive at 200 per second:

```text
capacity:   10 threads / 0.1 s  = 100 tasks/s
arrivals:                         200 tasks/s
queue grows by:                   100 tasks/s

after 1 minute:    6,000 tasks waiting     new task waits  1 minute
after 10 minutes: 60,000 tasks waiting     new task waits 10 minutes
```

```diagram
type: flow
alt: Tasks arrive twice as fast as they finish, so the queue grows every second until memory runs out.
caption: Figure 2. Nothing in this chain ever says no.
200 tasks/s arrive -> Only 100 tasks/s finish -> Queue grows 100 per second -> Memory fills, program dies !
```

Three bad things happen together:

1. **Latency grows without limit.** A new task waits behind everything already queued, so the delay is queue length divided by throughput.
2. **The work is wasted.** The **client**, the program or person that sent the request, waited 30 seconds, gave up and left. The server still processes that request ten minutes later, for nobody. This is sometimes called *zombie work*, and it keeps the queue full even after traffic returns to normal.
3. **Memory fills.** Each queued task holds its data, such as the request and the connection to the client. Sixty thousand of them take real memory. Java keeps its objects in a part of memory called the **heap**, and eventually the heap is full.

The worst part is the silence. A full queue never rejects anything, so no error appears in the logs until the program dies. A system that cannot say "I am full" cannot protect itself. A [connection pool](/posts/connection-pool-exhausted/) has the same shape of problem, but there the waiting ends in a loud error after a timeout. Here nothing ever fails until it is too late.

## How to diagnose it

**1. Watch the queue length.** Record it as a number you can graph. For a `ThreadPoolExecutor` it is `executor.getQueue().size()`. A healthy queue stays near zero and bounces up and down. An overloaded one climbs steadily.

**2. Look at latency over time.** Graph response time over a few hours. If it gets a little worse every minute, even though traffic is steady, tasks are piling up in the queue.

**3. Look at the threads.** A **thread dump** is a list of what every thread is doing right now. Take one with `jcmd <pid> Thread.print`, where `<pid>` is the program's process ID. It will show all ten workers busy while the rest of the app is idle. The workers are not stuck. They are simply busy all the time.

**4. Look at the heap.** A **class histogram** counts the objects in it, by type. Take one with `jcmd <pid> GC.class_histogram`. It will show a huge count of `LinkedBlockingQueue$Node` objects and of your own task class. That is the queue itself. The histogram makes Java pause briefly to clean up unused objects (this cleanup is called garbage collection). If you run several copies of your service, try it on one copy first, so the others keep serving users. [The memory leak post](/posts/java-memory-leak/) explains histograms and heap dumps.

## Fix 1: bound the queue and decide what happens when it is full

Build the executor yourself, with a **bounded queue**, a waiting line with a size limit, and a **rejection policy**, a rule for what to do with a task when the line is full:

```java
ExecutorService executor = new ThreadPoolExecutor(
        10, 10,                                 // core size, max size
        0L, TimeUnit.SECONDS,                   // idle time for extra workers
        new ArrayBlockingQueue<>(200),          // at most 200 waiting tasks
        new ThreadPoolExecutor.AbortPolicy());  // full -> throw RejectedExecutionException
```

The first `10` is the **core size**, the number of workers the pool keeps. The second `10` is the **maximum size**, the most workers it may ever have. We set both to 10, so the pool always has exactly 10 workers. The `0L, TimeUnit.SECONDS` says how long an extra worker may sit idle before it is removed. With no extra workers, it never matters.

How big should the line be? Do not guess. Start from the longest wait you can accept. Say nobody should wait more than 2 seconds in the line. The pool finishes 100 tasks per second, so in 2 seconds it clears 200 tasks. A line of 200 means the last task in it waits about 2 seconds. A longer line would make people wait longer than you decided.

```text
queue length  =  acceptable wait  x  throughput
              =  2 seconds        x  100 tasks/s   =  200
```

The caller also waits for the task itself to run, 0.1 seconds here, so the total is about 2.1 seconds.

When the queue is full, the pool must choose between four policies:

| Policy | What happens | When it fits |
|---|---|---|
| `AbortPolicy` | Throws `RejectedExecutionException` | **Most requests.** Catch it and return an error such as HTTP 503 ("service unavailable": the server is too busy, try later), so the caller knows right away |
| `CallerRunsPolicy` | The submitting thread runs the task itself | **Backpressure:** the sender feels the pressure and slows down, because it is busy doing the work itself |
| `DiscardPolicy` | Silently drops the task | Almost never. Data disappears with no trace |
| `DiscardOldestPolicy` | Drops the longest-waiting task | Only when the newest data replaces the old |

## Fix 2: tell callers to slow down

When the pool says "full", the caller needs to know what to do next.

**A web request.** Catch the rejection and answer with a 503. Add a `Retry-After` header, which tells the caller how many seconds to wait before trying again.

**A message queue.** This is a place where messages wait until a program reads them. If your tasks come from one, stop reading new messages until the pool has room again. The messages wait safely in the queue.

Both do the same thing. They push the pressure back to where the work comes from, instead of piling it up inside your program. That is backpressure. Limiting requests at the front door, before they reach the pool, is a topic of its own.

## Fix 3: do not process work nobody is waiting for

Give each task a deadline, stamped when it is submitted. When a worker takes a task from the queue, it checks whether the deadline has passed and skips the task if so:

```pseudocode
task = queue.take()
if now > task.deadline:
    skip it                     # the client has already gone
else:
    process(task)
```

This stops the zombie work, so the queue drains quickly after a spike instead of staying full of dead requests.

## When the fix goes wrong

A bounded queue and a rejection policy are the right fix, but each piece has a catch.

**1. Expecting extra threads to help.** A common setup is 10 **core threads** (the number the pool always keeps) and a maximum of 50, "so the pool grows under load". It does not grow when you expect. A `ThreadPoolExecutor` starts a thread beyond the core size only when the queue is **full**. With an unbounded queue it is never full, so the maximum is ignored.

Even with a bounded queue the growth comes late. I ran a pool with 10 core threads, a maximum of 50 and a queue of 200, using tasks that never finish. Tasks 1 to 10 started threads. Tasks 11 to 210 went into the queue, so there were still 10 threads. Task 211 was the first to start an 11th thread. Thread 50 started with task 250, and task 251 was rejected.

So the extra threads help only after 200 tasks are already waiting. If you want them to join early, use a small queue. If you do not need extra workers, make the core size and the maximum size the same number, as in Fix 1 (`10, 10`). Then the pool always has exactly 10 workers, and there is no growing to wait for.

**2. Running the rejected task on the wrong thread.** `CallerRunsPolicy` makes the thread that submitted the task run it. That slows the producer, which is the goal. But some callers must never be slowed. Some servers use one thread to look after many users at once, switching quickly between them. If that thread runs a 2-second task itself, all of those users freeze for 2 seconds. Use `CallerRunsPolicy` only when the caller can afford to be busy. Otherwise use `AbortPolicy` and return an error.

**3. Rejecting without backoff.** *Backoff* means waiting before you try again, a little longer each time. Suppose the pool can finish 100 tasks per second and 200 arrive. Half are rejected, and each rejected client retries at once. The next second brings those 100 retries plus 200 new tasks. That is 300 tasks for a pool that can do 100. Rejecting made the load worse.

Return 503 with a `Retry-After` header and make clients wait. Better still, clients should wait longer after each failure, with a random delay added so they do not all return together. Retries that make an outage worse, called a retry storm, are a topic of their own.

## Which should you use?

| Situation | Reach for |
|---|---|
| Handling user requests | **Bounded queue + `AbortPolicy`,** return 503 quickly |
| A producer you control feeding a pool | **Bounded queue + `CallerRunsPolicy`** so it slows down naturally |
| Messages from a message broker (a server that holds messages, such as Kafka) | **Pause or slow the consumer,** the program that reads the messages, when the queue is full |
| Tasks that expire (a client is waiting) | **A deadline check** when a worker takes the task from the queue |
| You are not sure what to pick | **`AbortPolicy`.** Failing loudly is better than failing silently |

Avoid `newFixedThreadPool` and `newCachedThreadPool` in production code unless something else bounds the work. Construct `ThreadPoolExecutor` directly, so every limit is written down where you can see it.

## The takeaway

1. A thread pool is **threads plus a queue**. Capping the threads does nothing if the queue is unlimited.
2. `newFixedThreadPool` hides an **unbounded queue**. `newCachedThreadPool` hides **unbounded threads**.
3. Past capacity, an unbounded queue gives you **growing latency, wasted work and finally an out-of-memory crash**, all without one error.
4. Diagnose it by watching **queue length** and latency over time, and the heap histogram.
5. Fix it with a **bounded queue sized from the wait you can accept**, a deliberate rejection policy, and a way for callers to back off. A system must be able to say "I am full".
