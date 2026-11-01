---
title: Blocked event loop: why one slow call freezes everything
date: 2026-11-01
description: A blocked event loop freezes every endpoint of a Netty, WebFlux, Vert.x or Node service, even the health check. Learn to find and fix the blocking call.
tags: java, async, performance
draft: true
---

## The doubt

A service built on a reactive framework (one that handles many requests with a few threads) has been fast for months. Today every endpoint is slow at the same moment, including the health check. CPU is at 5%. The database is idle. Then the orchestrator sees the failed health check, restarts the instance, and the pattern repeats on the next one.

Nothing is busy, yet nothing is answering.

> One endpoint is slow, so why did the whole service stop?

The cause is usually one handler making a blocking call on a thread that was never meant to wait.

> [!SUMMARY]
> By the end you will know:
>
> 1. What an event loop is, and why it must never wait
> 2. What counts as a blocking call, some of which look harmless
> 3. How to **diagnose** a blocked loop with a thread dump and BlockHound
> 4. How to fix it with non-blocking drivers or a separate, bounded thread pool

## First, a few threads for many connections

A traditional server gives each request its own **thread** (one line of execution inside a program). Platform threads are expensive, so a few thousand is a practical limit.

An **event loop** takes the opposite approach. A small number of threads, often about one per CPU core, each handle thousands of connections. A loop thread runs a short piece of code for one request, then moves to the next. When a request needs to wait for the network or a disk, it does not wait. It registers a **callback** (code to run later) and the thread moves on.

Think of one waiter serving fifty tables. The waiter never stands at the kitchen door waiting for a dish. They place the order, leave, and come back when it is ready.

That only works if the waiter never waits. If one handler **blocks**, meaning the thread sits idle until something finishes, every other connection on that thread waits too. Netty, Spring WebFlux (which runs on Netty by default), Vert.x and Node.js all work this way.

## The failure: one blocked thread, many frozen requests

The program below is a toy event loop with a single thread. One handler sleeps for three seconds, standing in for a blocking database call. A health check arrives 100 ms later. This is real output from a run on JDK 21:

```text
t=14ms slow handler starts (blocking call)
t=125ms health check arrives
t=3039ms slow handler ends
t=3039ms health check answered
```

The health check needed no work at all, but it waited 2.9 seconds because the only thread was busy:

```diagram
type: sequence
alt: A slow handler blocks the only event loop thread, so a health check that arrives after it waits for the full block.
caption: Figure 1. The health check is trivial, but it queues behind a thread that is blocked.
actors: Client A | Client B | Event loop
Client A -> Event loop: GET /report
note Event loop: blocked on a 3 s database call !
Client B -> Event loop: GET /health
Event loop --> Client B: answered 2.9 s late !
```

With several loop threads, it takes several slow calls to freeze everything, but the effect is the same. Requests are spread across the loops, so soon each loop is stuck behind one slow call.

## What counts as blocking

- **Database calls with JDBC** (the standard Java database API), which waits for the network.
- **`Thread.sleep`**, and any `Future.get()` or `.block()` that waits for a result.
- **Synchronous HTTP clients**, such as a plain `HttpURLConnection` call.
- **File reads and writes** with the classic `java.io` classes.
- **Heavy computation:** hashing a password, compressing a large payload, or parsing a huge document. The thread is busy rather than idle, but nothing else runs on it.
- **A lock held for long.** Waiting for `synchronized` is also waiting.

The dangerous ones are calls hidden inside a library, where nothing in your code says "network".

## How to diagnose it

**1. Recognize the symptoms.** Everything is slow at the same time, not just one endpoint. CPU is low. The health check fails, even though it does no work.

**2. Take a thread dump.** A **thread dump** is a snapshot of what each thread is doing. Take two or three, ten seconds apart:

```bash
jcmd <pid> Thread.print > dump.txt
```

**3. Look at the event-loop threads.** In Reactor Netty they are named like `reactor-http-nio-2`, or `reactor-http-epoll-2` when native epoll is used, which is common on Linux. Find them and read the top of each stack. This is illustrative output, not from a real run:

```text
"reactor-http-nio-2" #31 ...
   java.lang.Thread.State: RUNNABLE
	at sun.nio.ch.NioSocketImpl.implRead(...)
	at com.example.report.ReportRepository.load(ReportRepository.java:48)
	at com.example.report.ReportHandler.handle(ReportHandler.java:21)
```

A loop thread sitting in a socket read, a sleep, or a file call means a handler is blocking it. The line below the library frames is your code. A healthy loop thread usually sits in the framework's `epollWait` or `select` call.

**4. Measure loop lag.** Schedule a tiny task every 100 ms on the loop and record how late it runs. A lag of seconds means the loop was blocked. Node.js has this built in as `monitorEventLoopDelay` in the `perf_hooks` module.

**5. Catch it in tests with BlockHound.** BlockHound is a Java agent from the Reactor project that throws when a blocking call happens on a thread marked as non-blocking. Add the `io.projectreactor.tools:blockhound` dependency and call `BlockHound.install()` at startup of a test. Its error, `BlockingOperationError`, names the call, for example `Thread.sleep`. On JDK 13 and later, its documentation says you need the JVM flag `-XX:+AllowRedefinitionToAddDeleteMethods`.

## Fix 1: use a non-blocking driver

Replace the blocking library with one built for the loop. Databases such as PostgreSQL have **R2DBC** drivers (a reactive database API), and Spring offers `WebClient` for HTTP instead of a synchronous client.

The cost is that the whole call chain must be reactive. Mixing a reactive web layer with a blocking data layer defeats the point, and your team must learn the style.

## Fix 2: move the blocking call to its own pool

When no non-blocking option exists, run the call on a different thread pool and let the loop continue. In Reactor, the scheduler for this is `Schedulers.boundedElastic()`. This sketch is illustrative, not run:

```java
Mono<Report> report(String id) {
    return Mono.fromCallable(() -> repository.loadBlocking(id))
               .subscribeOn(Schedulers.boundedElastic());
}
```

`fromCallable` wraps the blocking call. `subscribeOn` makes it run on a thread from the other pool. The Reactor documentation says that scheduler is meant for blocking work. It caps its threads at ten times the number of CPU cores, and queues up to 100,000 more tasks per thread before it rejects new ones.

The cost is that a blocked call still ties up a thread. You have moved the problem out of the loop, not removed it.

## Fix 3: keep handlers short

Even without I/O, long handlers hurt. Split big computations into pieces, or hand CPU-heavy work to a pool sized to your core count. A rule of thumb is that a handler should finish in well under a millisecond or two of CPU time.

## A note on Node.js

Node.js has one event loop thread for JavaScript. A synchronous call such as `fs.readFileSync`, a heavy `JSON.parse`, or a long loop blocks every request. The Node documentation says that when the loop spends too long on one task, all clients wait. The fix is the same: use the asynchronous version of the call, or move heavy work to a worker thread.

## When the fix goes wrong

Two pitfalls are easy to miss, because the code looks right.

**1. Blocking inside a callback.** You use `Mono` and `Flux`, so it feels like everything is asynchronous. It is not. An operator such as `map` does not move work to another thread. By default it runs on the thread that delivered the previous value, which here is the loop thread. This is illustrative, not run:

```java
// Looks reactive, but the JDBC call runs on the loop thread
Mono<Report> report(String id) {
    return Mono.just(id)
               .map(i -> repository.loadBlocking(i));
}
```

Reactor throws an error if you call `.block()` on some of its own threads, but a plain JDBC call inside `map` raises no error at all. The service just freezes under load. The same is true of `doOnNext` and `flatMap`. Changing the operator does nothing. What matters is which thread runs the call.

**What to do instead:** wrap the call in `Mono.fromCallable` and add `subscribeOn(Schedulers.boundedElastic())`, as in Fix 2. Then check with BlockHound, which will name any blocking call that is left.

**2. The separate pool is too small.** Moving the call off the loop protects the loop. It does not make the call faster. Say the machine has 4 CPU cores. `boundedElastic` allows up to 10 times that, so 40 threads. The database call takes 2 seconds. Each thread finishes one call per 2 seconds, so the pool handles 40 / 2 = 20 calls per second.

Now 50 requests per second arrive. The extra 50 - 20 = 30 per second wait in a queue. After 10 seconds, 300 are waiting, and a new request waits about 300 / 20 = 15 seconds before its call even starts. Reactor's queue is large by default (up to 100,000 waiting tasks, per its documentation), so it will not reject anything. It just makes everyone wait. The loop stays healthy, but users see timeouts.

**What to do instead:** put a timeout on the whole call, so a waiting request fails quickly. Limit how many calls may wait, for example with `Schedulers.newBoundedElastic`, which lets you set the queue size. And size the pool from what the dependency can take, not from how many requests you have.

Smaller traps:

- **The separate pool is unbounded.** A thread pool that creates threads without limit can exhaust memory. A queue without limit hides overload until latency explodes. See [the unbounded thread pool queue post](/posts/unbounded-thread-pool-queue/).
- **One slow dependency drags everything.** A pool full of waiting calls looks like an outage. Add timeouts and a circuit breaker, as in [the cascading failures post](/posts/cascading-failures-circuit-breaker/).
- **Trusting a library's name.** A "reactive" wrapper can still block inside. Test it with BlockHound.

## Which should you use?

| Situation | Reach for |
|---|---|
| A new service, and a non-blocking driver exists | **Non-blocking driver** |
| A legacy library with no async version | **`boundedElastic` pool,** with timeouts |
| A long computation | **A separate pool sized to your cores** |
| You are not sure what blocks | **BlockHound in tests,** a thread dump in production |

If you are not sure, take a thread dump during the freeze. If loop threads are inside a socket read, a sleep or a file call, you have found the cause.

## See it yourself

Write a tiny handler with a `Thread.sleep(3000)` on a single-threaded executor, as in the toy program above. Send a second task and time how long it waits.

> [!WARNING]
> Do this in a throwaway project. Do not add `Thread.sleep` to a real handler, because it freezes the loop it runs on.

## The takeaway

1. An **event loop** uses a few threads for many connections, so no handler may wait.
2. One **blocking call** freezes every request on that thread, even a trivial health check.
3. Symptoms: **everything slow at once, low CPU, failing health check**.
4. Find it with a **thread dump**, loop-lag metrics and BlockHound.
5. Fix with a **non-blocking driver**, or a **bounded** separate pool, and keep handlers short.
