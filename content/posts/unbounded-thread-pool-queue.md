---
title: Unbounded thread pool queue: how it hides overload
date: 2026-11-01
description: Why a thread pool with a fixed size still crashes under a traffic spike, how a hidden queue grows, and how to make overload fail fast instead.
tags: java, concurrency, scaling
draft: true
---

## The doubt

A Java service handles background work with `Executors.newFixedThreadPool(10)`. Ten threads. It looks safe: a hard cap, so it can never use more than ten threads.

Then one day traffic doubles. Nothing errors. But response times climb from milliseconds to seconds, then minutes, memory keeps rising, and an hour later the process dies with `OutOfMemoryError`.

> I capped the threads at ten. What was supposed to stop the overload, and why did nothing say no?

The cap limited the threads. It did not limit the **work waiting for them**, and that waiting line had no limit at all. Think of a supermarket with ten checkout lanes and a line that can stretch out the door and down the street. Nobody is ever turned away, so nobody is told to go elsewhere.

> [!SUMMARY]
> By the end you will know:
>
> 1. Where the hidden queue in a thread pool is, and why it has no limit by default
> 2. How a queue turns a small overload into a slow, silent disaster
> 3. How to **diagnose** it from queue size, latency and heap
> 4. How to make overload fail fast, and the traps in each choice

## First, the pool and its queue

A thread pool has a fixed number of worker threads. When you submit a task and all workers are busy, the task goes into a **queue** and waits its turn.

The factory method `Executors.newFixedThreadPool(10)` builds a pool with 10 threads and a `LinkedBlockingQueue` with **no capacity limit**. Its capacity is `Integer.MAX_VALUE`, about two billion. In practice, "never full". `newSingleThreadExecutor()` has the same unbounded queue.

The related `newCachedThreadPool()` goes the opposite way: no queue, but **no limit on threads**. A burst of tasks creates thousands of threads, and the failure becomes `OutOfMemoryError: unable to create native thread`. Both factory methods hide a missing limit somewhere.

Spring Boot hides it too. Its default task executor, used by `@Async`, has an unbounded queue unless you set `spring.task.execution.pool.queue-capacity`.

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
caption: Figure 1. Nothing in this chain ever says no.
200 tasks/s arrive -> Only 100 tasks/s finish -> Queue grows 100 per second -> Heap fills, process dies !
```

Three bad things happen together:

1. **Latency grows without limit.** A new task waits behind everything already queued, so the delay is queue length divided by throughput.
2. **The work is wasted.** The client that sent a request waited 30 seconds, gave up and left. The server still processes that request ten minutes later, for nobody. This is sometimes called *zombie work*, and it keeps the queue full even after traffic returns to normal.
3. **Memory fills.** Each queued task holds its data: request data, objects, references to callbacks and open sockets. Sixty thousand of them take real memory, and eventually the heap is full.

The worst part is the silence. A full queue never rejects anything, so no error appears in the logs until the process dies. A system that cannot say "I am full" cannot protect itself.

## How to diagnose it

**1. Watch the queue length.** Expose it as a metric. For a `ThreadPoolExecutor` it is `executor.getQueue().size()`. Note that `newFixedThreadPool` returns an `ExecutorService`, so you need to cast it to `ThreadPoolExecutor` first. With Micrometer, `ExecutorServiceMetrics` can publish the queue size for you. A healthy queue stays near zero and bounces. An overloaded one climbs steadily.

**2. Look at latency over time.** If response time rises in a straight line while the number of requests is flat, a queue is filling.

**3. Look at the threads.** A thread dump (`jcmd <pid> Thread.print`) will show all ten workers busy while the rest of the app is idle. The workers are not stuck. They are simply saturated.

**4. Look at the heap.** A class histogram (`jcmd <pid> GC.class_histogram`) will show a huge count of `LinkedBlockingQueue$Node` objects and of your own task class, often wrapped in `FutureTask`. That is the queue itself. The histogram forces a full GC, so run it on one instance. [The memory leak post](/posts/java-memory-leak/) explains histograms and heap dumps.

## Fix 1: bound the queue and decide what happens when it is full

Build the executor yourself, with a **bounded queue** and an explicit rejection policy:

```java
ExecutorService executor = new ThreadPoolExecutor(
        10, 10,                                 // 10 threads
        0L, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(200),          // at most 200 waiting tasks
        new ThreadPoolExecutor.AbortPolicy());  // full -> throw RejectedExecutionException
```

Size the queue from how long you are willing to make someone wait, not from a guess. The wait in the queue is only part of what a caller sees, because the task's own run time (here 0.1 seconds) comes on top, so keep that in mind when you choose the wait:

```text
queue length  =  acceptable wait  x  throughput
              =  2 seconds        x  100 tasks/s   =  200
```

When the queue is full, the pool must choose between four policies:

| Policy | What happens | When it fits |
|---|---|---|
| `AbortPolicy` | Throws `RejectedExecutionException` | **Most requests.** Catch it and return an error such as HTTP 503, so the caller knows right away |
| `CallerRunsPolicy` | The submitting thread runs the task itself | **Backpressure.** The producer slows down because it is busy doing the work |
| `DiscardPolicy` | Silently drops the task | Almost never. Data disappears with no trace |
| `DiscardOldestPolicy` | Drops the longest-waiting task | Only when the newest data replaces the old |

## Fix 2: tell callers to slow down

Rejecting is not enough on its own. The caller must know what to do next. In an HTTP service, return **503 Service Unavailable** with a `Retry-After` header. If the work was submitted from a request handler, the rejection becomes that request's 503.

In a message consumer, pause consuming until the queue drains. The point is called **backpressure**: pushing the pressure back toward the source instead of absorbing it silently. [The rate limiting post](/posts/rate-limiting-token-bucket/) covers limiting at the front door.

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

- **A queue that is still too big.** A bound of 100,000 is not a bound. At 100 tasks per second, that is a 1,000-second wait. Size it from the wait you can accept.
- **Extra threads that never appear.** A `ThreadPoolExecutor` adds threads beyond the core size only when the queue is full. With an unbounded queue, the maximum size is ignored. With a bounded one, the extra threads start late.
- **`CallerRunsPolicy` on the wrong thread.** If the caller is a network event-loop thread, running the task there blocks the loop and freezes unrelated connections.
- **Rejecting without backoff.** If callers immediately retry every rejected request, the retries add to the load you just refused. Clients need to wait before they retry. [The cascading failures post](/posts/cascading-failures-circuit-breaker/) goes deeper.
- **`DiscardPolicy` as the quick fix.** The errors vanish and so does the data. You find out from customers.
- **Too many threads as a "fix".** More threads on a CPU-bound or database-bound task only adds contention.

## Which should you use?

| Situation | Reach for |
|---|---|
| Handling user requests | **Bounded queue + `AbortPolicy`,** return 503 quickly |
| A producer you control feeding a pool | **Bounded queue + `CallerRunsPolicy`** so it slows down naturally |
| Messages from a broker | **Pause or slow the consumer** when the queue is full |
| Tasks that expire (a client is waiting) | **A deadline check** when the task is dequeued |
| You are not sure what to pick | **`AbortPolicy`.** Failing loudly is better than failing silently |

Avoid `newFixedThreadPool` and `newCachedThreadPool` in production code unless something else bounds the work. Construct `ThreadPoolExecutor` directly, so every limit is written down where you can see it.

## The takeaway

1. A thread pool is **threads plus a queue**. Capping the threads does nothing if the queue is unlimited.
2. `newFixedThreadPool` hides an **unbounded queue**. `newCachedThreadPool` hides **unbounded threads**.
3. Past capacity, an unbounded queue gives you **growing latency, wasted work and finally an out-of-memory crash**, all without one error.
4. Diagnose it by watching **queue length** and latency over time, and the heap histogram.
5. Fix it with a **bounded queue sized from your latency budget**, a deliberate rejection policy, and a way for callers to back off. A system must be able to say "I am full".
