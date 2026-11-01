---
title: Cascading failures: timeouts, retries, circuit breakers
date: 2026-11-01
description: How one slow dependency, plus missing timeouts and eager retries, takes down every service that calls it, and the four defenses that stop the spread.
tags: reliability, system-design, scaling
draft: true
---

## The doubt

One service, say the one that returns product recommendations, gets slow. It does not crash. It just takes ten seconds instead of one hundred milliseconds. A few minutes later the checkout service is down. Then the login page. Then the whole site.

None of those other services had a bug, and their own databases were healthy.

> Only one thing was slow. Why did everything else fall over?

The slow service did not spread a bug. It spread **waiting**. Each caller sat holding a thread, a connection and memory while it waited, until the callers ran out of those too.

Think of a shop with one slow cashier. The queue grows, shoppers block the aisles, and soon even people who only want to walk out cannot move.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a **slow** dependency is more dangerous than a **dead** one
> 2. How waiting and retries turn one slow service into an outage
> 3. How to **diagnose** the root cause when everything is red at once
> 4. The four defenses: timeouts, limited retries, circuit breakers and bulkheads

## First, why slow is worse than down

When a service is down, a call to it fails at once ("connection refused"). The caller gets an error, releases its resources and moves on.

When a service is **slow**, the call does not fail. It waits. The **thread** handling that request (one worker that runs one request at a time) stays blocked. Resources are held for as long as the slow call takes, and new requests keep arriving to take more.

## The failure: threads run out

Service A calls service B. A has 200 request threads. B starts answering in 10 seconds instead of 0.1. A receives 50 requests per second, and each one now occupies a thread for 10 seconds:

```text
threads needed  =  requests per second  x  seconds each takes
                =  50 x 10   =  500

threads available: 200  ->  A is out of threads within a few seconds
```

```diagram
type: flow
alt: A slow service makes its callers hold threads until the thread pool is empty and unrelated pages stall.
caption: Figure 1. The slowness spreads as waiting, not as errors.
Recommendations takes 10 s -> Callers hold threads while waiting -> Thread pool is empty -> Checkout and login stall !
```

Once A has no free threads, it cannot answer **anything**, including requests that do not need B at all, like its health check. To the services that call A, A is now slow, and the same thing happens one layer up. The failure travels backwards along the call chain, as fast as threads run out.

A pool of database connections can run dry in the same way. [The connection pool post](/posts/connection-pool-exhausted/) shows that version.

Then comes the worst part. A's callers do what good clients do and **retry**:

```text
3 attempts per layer, 3 layers deep:  3 x 3 x 3 = 27 requests to B
for every original user click
```

B was struggling at normal load. Now it receives up to 27 times more. It cannot recover, even after the original problem has gone, because the retries keep it buried. This is called a **retry storm**.

```diagram
type: flow
alt: Each layer retries three times, so one user click becomes 27 requests to the slow service.
caption: Figure 2. Retries at every layer multiply.
One user click -> Layer 1 tries 3 times -> Layer 2 tries 3 times each -> Layer 3 tries 3 times each -> B gets 27 requests !
```

## How to diagnose it

When all graphs are red at once, the loudest alarm is usually a victim, not the cause. Find the **first** one.

**1. Follow the timeline back.** Line up the latency charts of every service on one time axis. The service whose latency rose **first** is the root. Everything after it is fallout.

**2. Look at the call chain.** A **distributed trace** (a record of one request's path through every service, with timings) shows where the time goes. Nearly all of it is in one downstream call.

**3. Check the pools.** Look at the gauges for active threads and active connections against their maximum. A pool pinned at its maximum on A while B's latency is high confirms the story.

**4. Read a thread dump of a victim.** A **thread dump** lists what every thread is doing right now. `jcmd <pid> Thread.print` on service A shows most threads waiting on a socket read to B:

```text
"http-nio-8080-exec-88" RUNNABLE
    at (a socket read, waiting for bytes from B)
    at com.example.RecommendationClient.fetch(RecommendationClient.java:31)
```

A thread waiting on the network still shows as `RUNNABLE`. The clue is that many threads sit at the same remote call.

**5. Check the retry traffic.** If B's request rate is a multiple of the user traffic, retries are amplifying the problem.

A's health check also fails when its threads are gone. Under a liveness probe that gets A restarted, which makes things worse. [The health checks post](/posts/readiness-vs-liveness-probes/) covers that trap.

## Defense 1: a timeout on every remote call

Never make a call without a timeout. Many HTTP clients default to **no limit at all**. Set a connect timeout and a request timeout, and keep them well below what the user will tolerate:

```java
HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(1))
        .build();

HttpRequest request = HttpRequest.newBuilder(URI.create(url))
        .timeout(Duration.ofSeconds(2))       // give up after 2 seconds
        .build();
```

Check what each client's timeout actually covers. Some limit only the wait for the first response bytes, not the whole body. Databases and connection pools need timeouts too, such as how long to wait for a free connection.

Make inner timeouts shorter than outer ones. If the user's request has 5 seconds in total, a call that is itself allowed 10 seconds can never be useful.

## Defense 2: limit and space out retries

Retry only when it is safe and likely to help:

- **Few attempts.** Two or three, not unlimited.
- **Wait between attempts,** with growing gaps and a random element, so clients do not retry in sync:

```pseudocode
delay = min(maxDelay, baseDelay * 2^attempt)
sleep(random(0 to delay))        # "full jitter"
```

- **Retry only some errors.** A timeout or a 503 (the server says it is unavailable) may be worth retrying. A 400 (bad request) never is.
- **Use a retry budget.** For example, let each client send retries only while they are under about 10% of its requests, which is the figure Google's SRE book gives as an example. Other systems use different numbers. When the budget is spent, fail instead of retrying.
- **Retry at one layer only,** not at every layer in the chain. That is what turns 3 into 27.

Retrying a request that changes data can repeat the change. [The double charge post](/posts/idempotency-key-double-charge/) explains how to make that safe.

## Defense 3: a circuit breaker

A circuit breaker works like the fuse box in a house. It watches calls to a dependency. When too many fail or time out, it **opens** and stops calling it for a while. Callers get an immediate failure, or a **fallback** (a cheap substitute answer), instead of waiting:

```pseudocode
state = CLOSED                        # normal: calls go through

on call:
    if state == OPEN:
        if now > openedAt + cooldown:  state = HALF_OPEN     # allow a few trial calls
        else:                          return fail fast (or fallback)
    result = callService()
    if failed:
        recordFailure()
        if state == HALF_OPEN:         state = OPEN, openedAt = now   # still broken
        else if failureRate >= threshold and enoughCalls:
                                       state = OPEN, openedAt = now
    else if state == HALF_OPEN:        state = CLOSED        # recovered
    return result
```

This gives the struggling service room to recover, and it frees your own threads at once. In Java, the Resilience4j library provides this ready-made. A Spring Boot configuration looks like this:

```properties
resilience4j.circuitbreaker.instances.recommendations.slidingWindowSize=20
resilience4j.circuitbreaker.instances.recommendations.minimumNumberOfCalls=10
resilience4j.circuitbreaker.instances.recommendations.failureRateThreshold=50
resilience4j.circuitbreaker.instances.recommendations.waitDurationInOpenState=30s
```

Note two details. In the half-open state, Resilience4j allows several trial calls by default (`permittedNumberOfCallsInHalfOpenState`), not one. And it counts a call as failed only if it throws. In our story the service is slow but does not fail, so keep the client timeout from Defense 1, which turns a slow call into an error. You can also set `slowCallDurationThreshold` and `slowCallRateThreshold` to count slow calls directly.

## Defense 4: bulkheads

A ship has watertight compartments, so a leak in one does not sink the ship. Do the same with threads. Give each dependency its **own small pool**. If the recommendation service goes slow, it can use up only its own 20 threads. The other 180 keep serving checkout and login.

The bulkhead must **reject** calls when its slots are full. If the request thread just waits for a free slot, it is stuck again. Resilience4j offers both a semaphore bulkhead (a counter of allowed concurrent calls) and a thread-pool bulkhead.

## When the fix goes wrong

Three pitfalls look harmless in a code review but cause trouble in production.

**1. A timeout below normal latency.** A short timeout feels safe, because it protects your threads. But a timeout must sit above what a *healthy* call needs. The 99th percentile is the time that 99 of 100 requests beat. Say B's usual 99th percentile is 800 ms and you set the timeout to 500 ms. By definition, at least 1 healthy request in 100 takes longer than 800 ms, so at least 1 in 100 now fails even though nothing is wrong. At 50 requests per second, that is at least one failure every 2 seconds.

It gets worse with retries. Each failed call is sent again, so B gets more load. B also does not know that A gave up, so it keeps working on the abandoned request. You have added load to a service that was fine.

**What to do instead:** measure B's real latency first, then set the timeout above its 99th percentile, for example 1 to 2 seconds for an 800 ms 99th percentile. Check it again when B changes. For genuinely slow answers, let the breaker count slow calls, as in Defense 3.

**2. Breaker wrapped outside the retry.** Suppose each logical call is tried up to 3 times, and the breaker opens when at least 10 calls have been seen and half of them fail (the settings above). B is down. If the breaker sits *outside* the retry, it only sees the final result. Each logical call counts as one failure, but sends 3 real requests to B. To reach 10 calls, you send 10 x 3 = 30 requests at a service that is already down.

**What to do instead:** put the retry on the outside and the breaker inside it, next to the call, so the breaker counts every attempt. It then opens after 10 real calls, not 30, and the remaining retries get a quick refusal instead of another request. In Resilience4j's Spring Boot annotations, the default order already puts the retry outside the circuit breaker, but check it if you wrap calls by hand.

**3. A fallback that calls something else slow.** A fallback is the cheap answer you give when the breaker is open. Say the fallback for "recommendations" runs a "best sellers" query on your main database, and it takes 0.3 seconds. At 50 requests per second, that is 50 x 0.3 = 15 database connections in use all the time (the same sum as in [the connection pool post](/posts/connection-pool-exhausted/)). If the pool has 10, checkout now cannot get a connection. The breaker saved your threads and drained the database.

**What to do instead:** make the fallback do almost no work. Return a list that was saved earlier and refreshed in the background, or an empty list, so the page still loads without recommendations.

Smaller traps:

- **A timeout that is too long.** A 30-second timeout is almost no protection. By the time it fires, the pool is already empty.
- **A breaker that flaps.** Thresholds that are too sensitive open and close it constantly. Require a minimum number of calls before judging the failure rate.

## Which should you use?

| Situation | Reach for |
|---|---|
| Any call to another service or database | **Timeouts,** always, on both connect and read |
| Calls that fail briefly and then work | **A few retries** with backoff and jitter, at one layer only |
| A dependency that stays broken for minutes | **A circuit breaker** with a cheap fallback |
| One non-critical dependency could drain everything | **A bulkhead:** its own small thread pool |
| The system is overloaded as a whole | **Shed load:** reject new work early, as in [the unbounded queue post](/posts/unbounded-thread-pool-queue/) |

If you are not sure, add timeouts first. They cost nothing and remove the most dangerous case: waiting forever.

## The takeaway

1. A **slow** dependency is worse than a dead one, because callers wait instead of failing.
2. Waiting uses up **threads**, and when A runs out, the problem moves up to A's callers: a **cascade**.
3. Retries at every layer **multiply** the load on the struggling service, so it can never recover.
4. In an incident, find the **first** service whose latency rose. Everything else is fallout.
5. Defend with **timeouts, limited and spaced-out retries, circuit breakers and bulkheads**. Fail fast so trouble stays small.
