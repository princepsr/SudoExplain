---
title: Cascading failures: timeouts, retries, circuit breakers
date: 2026-11-27
description: How one slow dependency, plus missing timeouts and eager retries, takes down every service that calls it, and the four defenses that stop the spread.
tags: system-design, microservices
---

## The question

One service, say the one that returns product recommendations, gets slow. It does not crash. A few minutes later checkout is down, then login, then the whole site.

> Only one thing was slow. Why did everything else fall over?

The slow service did not spread a bug. It spread **waiting**. Think of a shop with one slow cashier: the queue grows until even people who only want to walk out cannot move.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a **slow** dependency is more dangerous than a **dead** one
> 2. How waiting and retries (sending the same request again) turn one slow service into an outage
> 3. How to **diagnose** the root cause when everything is red at once
> 4. The four defenses: timeouts, limited retries, circuit breakers and bulkheads

## The failure: threads run out

When a service is down, a call to it is rejected right away ("connection refused"). The caller gets an error and moves on.

A **slow** service is worse. The call does not fail. It waits. While it waits, the **thread** that handles this request cannot do anything else.

Here is the sum. Service A calls service B, so B is a **dependency** of A. A has 200 threads. B now takes 10 seconds to answer, not 0.1. A gets 50 requests per second:

```text
threads needed = 50 requests per second x 10 seconds = 500
threads available = 200

A is out of threads within a few seconds
```

```diagram
type: flow
alt: A slow service makes its callers hold threads until no thread is free and unrelated pages stall.
caption: Figure 1. The slowness spreads as waiting, not as errors.
Recommendations takes 10 s -> Callers hold threads while waiting -> No free threads left -> Checkout and login stall !
```

Once A is out of threads, it cannot answer **anything**, even requests that do not need B. That includes its **health check**: a small request that a monitoring tool sends every few seconds to ask "are you alive?".

Now A looks slow to the services that call it, so the same thing happens one layer up. The slowness travels backwards, as fast as threads run out.

### See it yourself

[CascadeDemo.java](/code/cascading-failures-circuit-breaker/CascadeDemo.java) repeats this with small numbers. A has 4 threads, B takes 2 seconds, and 4 requests arrive every second. This is real output from Java 21:

```text
request 1 took 2020 ms
...
request 5 took 2992 ms
HEALTH CHECK took 2211 ms
request 6 took 2966 ms
...
request 12 took 3946 ms
```

The first four requests take 2 seconds, which is B's time. After that, each one also waits for a free thread, so the delay grows. The health check needs nothing from B, yet it waited 2.2 seconds in the same line. With `java CascadeDemo.java timeout`, A gives up on B after 300 ms. Every request then takes about 0.3 seconds, and the health check takes 1 ms. The full outputs are in [no-timeout-output.txt](/code/cascading-failures-circuit-breaker/no-timeout-output.txt) and [with-timeout-output.txt](/code/cascading-failures-circuit-breaker/with-timeout-output.txt).

A pool of database connections can run dry in the same way. [The connection pool post](/posts/connection-pool-exhausted/) shows that version.

## The retry storm

Then comes the worst part. A's callers do what good clients do. When a call fails or times out, they **retry**: they send it again.

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

**1. Follow the timeline back.** Line up the latency charts (how long requests take) of every service on one time axis. The service whose latency rose **first** is the root cause. Everything after it is fallout.

**2. Look at the call chain.** A **distributed trace** (a record of one request's path through every service, with timings) shows where the time goes. Nearly all of it is in one call to another service.

**3. Check the pools.** Look at the charts for active threads and active connections against their maximum. A **pool** is a fixed set of threads or connections that requests share. A pool pinned at its maximum on A while B's latency is high confirms the story.

**4. Read a thread dump of a victim.** A **thread dump** lists what every thread is doing right now. `jcmd <pid> Thread.print` on service A shows most threads waiting on a socket read to B:

```text
"http-nio-8080-exec-88" RUNNABLE
    at (a network read, waiting for bytes from B)
    at com.example.RecommendationClient.fetch(RecommendationClient.java:31)
```

A thread waiting on the network still shows as `RUNNABLE`. The clue is that many threads sit at the same remote call.

**5. Check the retry traffic.** If B's request rate is a multiple of the user traffic, retries are amplifying the problem.

A's health check also fails when its threads are gone. Some platforms restart a program whose health check fails (Kubernetes calls this a liveness probe), which makes things worse. The post on readiness and liveness probes covers that trap.

## Defense 1: a timeout on every remote call

Never make a call without a **timeout**. Many HTTP clients default to **no limit at all**. Set a connect timeout and a request timeout:

```java
HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(1))
        .build();

HttpRequest request = HttpRequest.newBuilder(URI.create(url))
        .timeout(Duration.ofSeconds(2))       // give up after 2 seconds
        .build();
```

Check what your timeout covers. Some clients limit only the time until the answer starts. If the server then sends the answer very slowly, the call can last much longer. Test it against a slow server. Databases and connection pools need timeouts too.

Keep each timeout shorter than the time the caller has left. If the user's page must load in 5 seconds, do not give B 10 seconds.

## Defense 2: limit and space out retries

Retries help with short problems, but only if they are used carefully:

- **Few attempts, at one layer only.** Two or three, not unlimited, and only in one place in the chain. Retries at every layer are what turned 3 into 27.
- **Retry only errors that may pass.** A timeout or a 503 (the server says it is busy) may pass. A 400 (the request itself is wrong) never will.
- **Set a retry budget.** Allow retries only while they are under about 10% of your requests. At 100 requests per second, that is at most 10 retries. Above that, do not retry.
- **Wait longer after each failure.** Retry after 1 second, then 2, then 4. This is called **backoff**. Make each wait a random length too, called **jitter**, so clients that failed together do not retry together.

```pseudocode
# the wait doubles each attempt, up to a maximum
delay = min(maxDelay, baseDelay * 2^attempt)
# wait a random time between 0 and that delay
sleep(random(0 to delay))
```

Retrying a request that changes data can repeat the change. [The double charge post](/posts/idempotency-key-double-charge/) explains how to make that safe.

## Defense 3: a circuit breaker

A circuit breaker works like the fuse box in a house. When something goes wrong, it cuts the line, so the damage cannot spread. In code, it sits between your service and a dependency and counts how the calls go. It has three states:

1. **Closed.** All is well, like a closed switch that lets power flow. Calls go through.
2. **Open.** Too many recent calls failed, so the breaker stops calling the dependency. Every call is now **rejected**: it gets an error right away, without being sent. Or it gets a **fallback**, which is a cheap substitute answer. No thread waits, and the struggling service gets a rest.
3. **Half-open.** After a wait (say 30 seconds), the breaker lets a few **trial calls** through. If they work, it closes again. If one fails, it opens again for another wait.

<figure>
<div class="diagram" style="max-width:520px;margin-inline:auto">
<svg viewBox="0 0 420 300" style="min-width:0;width:100%" role="img" aria-label="Animated diagram of a circuit breaker between your service and service B. It starts closed and requests pass through. When service B breaks, requests fail and the breaker opens, so requests are rejected. After a wait it goes half-open and lets one trial request through. The trial works, so it closes again. The loop repeats.">
  <g font-family="var(--sans)" font-size="14" fill="currentColor" stroke="currentColor" stroke-width="2">
    <rect x="10" y="130" width="100" height="70" rx="8" fill="none"/>
    <rect x="165" y="105" width="90" height="120" rx="8" fill="none"/>
    <rect x="165" y="105" width="90" height="120" rx="8" fill="none" stroke="var(--accent)" opacity="0"><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.4444;0.6667" dur="18s" repeatCount="indefinite" calcMode="discrete"/></rect>
    <rect x="310" y="130" width="100" height="70" rx="8" fill="none"/>
    <line x1="110" y1="165" x2="165" y2="165" stroke-opacity=".35"/>
    <line x1="255" y1="165" x2="310" y2="165" stroke-opacity=".35"/>
    <rect x="156" y="140" width="6" height="50" rx="2" fill="var(--accent)" stroke="none" opacity="0"><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.4444;0.6667" dur="18s" repeatCount="indefinite" calcMode="discrete"/></rect>
    <g stroke="none" text-anchor="middle">
      <text x="60" y="170">Your service</text>
      <text x="210" y="190" font-size="12">circuit breaker</text>
      <text x="360" y="162">Service B</text>
      <text x="360" y="184" font-size="13" opacity="0">healthy<animate attributeName="opacity" values="1;0;1" keyTimes="0;0.2222;0.6667" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="360" y="184" font-size="13" fill="var(--accent)" opacity="0">broken<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.2222;0.6667" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="155" font-weight="700" opacity="0">CLOSED<animate attributeName="opacity" values="1;0;1" keyTimes="0;0.4444;0.8333" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="155" font-weight="700" fill="var(--accent)" opacity="0">OPEN<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.4444;0.6667" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="155" font-weight="700" opacity="0">HALF-OPEN<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.6667;0.8333" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="262"  opacity="0">1. Closed: calls go through to the service.<animate attributeName="opacity" values="1;0" keyTimes="0;0.2222" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="262"  opacity="0">2. The service breaks. Calls fail and are counted.<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.2222;0.4444" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="262"  opacity="0">3. Open: calls are rejected. The service rests.<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.4444;0.6667" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="262"  opacity="0">4. Half-open: one trial call goes through.<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.6667;0.8333" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
      <text x="210" y="262"  opacity="0">5. The trial worked, so the breaker closes.<animate attributeName="opacity" values="0;1" keyTimes="0;0.8333" dur="18s" repeatCount="indefinite" calcMode="discrete"/></text>
    </g>
    <g stroke="none"><circle cx="118" cy="165" r="6" fill="currentColor" opacity="0"><animate attributeName="cx" values="118;118;302;302;118;118" keyTimes="0;0.0167;0.0722;0.0778;0.1333;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.0167;0.1333" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="currentColor" opacity="0"><animate attributeName="cx" values="118;118;302;302;118;118" keyTimes="0;0.1111;0.1667;0.1722;0.2278;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.1111;0.2278" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="var(--accent)" opacity="0"><animate attributeName="cx" values="118;118;302;302;118;118" keyTimes="0;0.2333;0.2889;0.2944;0.35;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.2333;0.35" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="var(--accent)" opacity="0"><animate attributeName="cx" values="118;118;302;302;118;118" keyTimes="0;0.3;0.3556;0.3611;0.4167;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.3;0.4167" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="var(--accent)" opacity="0"><animate attributeName="cx" values="118;118;302;302;118;118" keyTimes="0;0.3667;0.4222;0.4278;0.4833;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.3667;0.4833" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="var(--accent)" opacity="0"><animate attributeName="cx" values="118;118;157;157;118;118" keyTimes="0;0.4667;0.4889;0.4944;0.5167;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.4667;0.5167" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="var(--accent)" opacity="0"><animate attributeName="cx" values="118;118;157;157;118;118" keyTimes="0;0.5222;0.5444;0.55;0.5722;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.5222;0.5722" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="var(--accent)" opacity="0"><animate attributeName="cx" values="118;118;157;157;118;118" keyTimes="0;0.5778;0.6;0.6056;0.6278;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.5778;0.6278" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="var(--accent)" opacity="0"><animate attributeName="cx" values="118;118;157;157;118;118" keyTimes="0;0.6333;0.6556;0.6611;0.6833;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.6333;0.6833" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="currentColor" opacity="0"><animate attributeName="cx" values="118;118;302;302;118;118" keyTimes="0;0.6833;0.7389;0.7444;0.8;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.6833;0.8" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle>
    <circle cx="118" cy="165" r="6" fill="currentColor" opacity="0"><animate attributeName="cx" values="118;118;302;302;118;118" keyTimes="0;0.85;0.9056;0.9111;0.9667;1" dur="18s" repeatCount="indefinite" /><animate attributeName="opacity" values="0;1;0" keyTimes="0;0.85;0.9667" dur="18s" repeatCount="indefinite" calcMode="discrete"/></circle></g>
  </g>
</svg>
</div>
<figcaption>Figure 3. A circuit breaker over one full cycle. It repeats every 18 seconds. Dots are requests.</figcaption>
</figure>

The breaker frees your own threads at once and gives the struggling service room to recover. In Java, the Resilience4j library provides one ready-made. A Spring Boot configuration looks like this:

```properties
# judge the last 20 calls
resilience4j.circuitbreaker.instances.recommendations.slidingWindowSize=20
# but only after at least 10 calls, so that two early
# errors cannot open it (a breaker that opens and
# closes again and again is called "flapping")
resilience4j.circuitbreaker.instances.recommendations.minimumNumberOfCalls=10
# open when half of them failed
resilience4j.circuitbreaker.instances.recommendations.failureRateThreshold=50
# stay open for 30 seconds
resilience4j.circuitbreaker.instances.recommendations.waitDurationInOpenState=30s
```

Resilience4j counts a call as failed only when it throws an error. A slow call does not throw, so keep the timeout from Defense 1. It turns a slow call into an error.

## Defense 4: bulkheads

A **bulkhead** limits how many threads one dependency can use.

Say A has 200 threads, and recommendations may use at most 20 of them. When recommendations goes slow, only those 20 get stuck. The other 180 keep serving checkout and login.

When all 20 are busy, the 21st call must be **rejected**, or get a fallback. If it waited, its own thread would be stuck too.

Resilience4j offers two kinds. A **thread-pool bulkhead** gives the dependency its own set of threads. A **semaphore bulkhead** is a counter that allows only 20 calls at the same time.

## When the fix goes wrong

Three pitfalls look harmless in a code review but cause trouble in production.

**1. A timeout below normal latency.** A short timeout feels safe, because it protects your threads. But a timeout must sit above what a *healthy* call needs. The 99th percentile is the time that 99 of 100 requests beat. Say B's usual 99th percentile is 800 ms and you set the timeout to 500 ms. By definition, at least 1 healthy request in 100 takes longer than 800 ms, so at least 1 in 100 now fails even though nothing is wrong. At 50 requests per second, that is at least one failure every 2 seconds.

It gets worse with retries. Each failed call is sent again, so B gets more load. B also does not know that A gave up, so it keeps working on the abandoned request. You have added load to a service that was fine.

**What to do instead:** measure B's real latency first, then set the timeout above its 99th percentile, for example 1 to 2 seconds for an 800 ms 99th percentile. Check it again when B changes.

**2. Breaker wrapped outside the retry.** Say each call is tried up to 3 times, and B is down. The breaker opens after it sees 10 failed calls. If the breaker wraps the whole retry, it sees only the final result: one failure per call, even though 3 requests went to B. So it opens only after 10 x 3 = 30 requests have hit a service that is already down.

**What to do instead:** put the breaker inside the retry, right next to the call, so it counts every attempt. It then opens after 10 real requests, and the remaining retries are rejected. Resilience4j's Spring Boot setup already works this way by default, but check it if you wrap calls by hand.

**3. A fallback that calls something else slow.** A fallback is the cheap answer you give when the breaker is open. Say the fallback for "recommendations" runs a "best sellers" query on your main database, and it takes 0.3 seconds. At 50 requests per second, that is 50 x 0.3 = 15 database connections in use all the time (the same sum as in [the connection pool post](/posts/connection-pool-exhausted/)). If the pool has 10, checkout now cannot get a connection. The breaker saved your threads and drained the database.

**What to do instead:** make the fallback do almost no work. Return a list that was saved earlier and refreshed in the background, or an empty list, so the page still loads without recommendations.

## Which should you use?

| Situation | Reach for |
|---|---|
| Any call to another service or database | **Timeouts,** always, on both connect and read |
| Calls that fail briefly and then work | **A few retries** with backoff and jitter, at one layer only |
| A dependency that stays broken for minutes | **A circuit breaker** with a cheap fallback |
| One non-critical dependency could drain everything | **A bulkhead:** its own small thread pool |
| The system is overloaded as a whole | **Shed load** (turn away some requests early so the rest still work), as in [the unbounded queue post](/posts/unbounded-thread-pool-queue/) |

If you are not sure, add timeouts first. They cost nothing and remove the most dangerous case: waiting forever.

## The takeaway

1. A **slow** dependency is worse than a dead one, because callers wait instead of failing.
2. Waiting uses up **threads**, and when A runs out, the problem moves up to A's callers: a **cascade**.
3. Retries at every layer **multiply** the load on the struggling service, so it can never recover.
4. In an incident, find the **first** service whose latency rose. Everything else is fallout.
5. Defend with **timeouts, limited and spaced-out retries, circuit breakers and bulkheads**. Reject early, so trouble stays small.
