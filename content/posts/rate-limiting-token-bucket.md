---
title: Rate limiting an API: token bucket vs fixed window
date: 2026-11-01
description: How one buggy client can slow an API for everyone, how to find the noisy caller, and how token buckets and shared counters keep a fair limit.
tags: apis, scaling, redis
draft: true
---

## The question

An API serves hundreds of customers. One afternoon it becomes slow for all of them, and the database is close to its limit. The cause is **one** customer: a script with a bug that calls the API in a tight loop, hundreds of times a second.

There is nothing wrong with the API. It did what it was asked, for everyone, as fast as it could, until it ran out of room.

> One caller made a mistake. Why did everyone else suffer?

Because nothing in the API said "that's enough". Every request was treated as equally welcome, however many arrived.

Think of a nightclub with no doorman. Nothing is wrong with the club until one crowd walks in, and then nobody else can get to the bar.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **rate limiter** does and what the client sees when it is applied
> 2. How two common algorithms differ, and which one allows bursts
> 3. How to **diagnose** a noisy client from your access logs
> 4. Why a limiter that works on one server is wrong on five, and how to fix that

## First, what a rate limiter does

A **rate limiter** caps how many requests one caller may make in a period of time, for example 100 per minute per API key (the secret string that identifies a customer). When a caller goes over, the server does not do the work. It answers **429 Too Many Requests**, and a `Retry-After` header says how long to wait, usually as a number of seconds. A header is a labeled line of extra information sent with the response:

```text
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

This protects everyone. A caller that misbehaves slows down only itself. It also guards sensitive endpoints, such as login, against password guessing.

## The failure: a loop with no brake

The usual causes are mundane:

- a script with a bug, or an infinite retry loop (a **tight loop** is one that repeats with no pause)
- a mobile app version that retries instantly after an outage, and a million phones do it together when the service comes back. This is called a **thundering herd**
- a customer who loads the API with a heavy export, without meaning to
- an attacker guessing passwords, or scraping your data

Each looks like **a lot of traffic from one place**, and without a limit, your servers, database and connection pools take all of it.

```diagram
type: flow
alt: One client loops with no limit, the API does all the work, and the database nears its limit, so every customer slows down.
caption: Figure 1. One loop with no brake slows everyone.
One client loops, no limit -> API does all the work -> Database nears its limit -> Every customer gets slow !
```

## How to diagnose it

Look at who is calling. A quick look at an access log, assuming the client address is the first field and you have first narrowed the file to the incident window:

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -nr | head
```

```text
 412350  203.0.113.45        <- one caller far above the rest
   9120  198.51.100.7
   8870  192.0.2.19
```

A single address, or API key, far above the rest, whose spike matches the slowdown, is the culprit. Group by API key or user rather than by address when you have one, since many users can sit behind one address.

Behind a load balancer, the first field is often the balancer's own address. Use the forwarded-for field or the API key field instead. Also check the database side: slow queries and active connections confirm where the load lands.

## Algorithm 1: fixed window (and its flaw)

Count requests in fixed periods, such as each calendar minute, and reject over 100. It is easy, but it has a flaw at the edges. A caller can send 100 requests at 12:00:59 and 100 more at 12:01:00, which is **200 in two seconds**, while staying within "100 per minute" in each window.

A **sliding window** fixes this by counting the last 60 seconds from now, not the calendar minute. It is more precise but needs more bookkeeping.

## Algorithm 2: token bucket (the common choice)

Imagine a bucket that holds up to a fixed number of **tokens**. Tokens drip in at a steady rate. Each request takes one token. If the bucket is empty, the request is refused.

```pseudocode
capacity = 100;   refillPerSecond = 10

on request:
    tokens = min(capacity, tokens + secondsSinceLastRequest * refillPerSecond)
    lastRequestTime = now
    if tokens >= 1:
        tokens = tokens - 1
        allow
    else:
        reject (429)
```

```diagram
type: sequence
alt: After the bucket is empty, the next request is refused with a 429 and a Retry-After header.
caption: Figure 2. An empty bucket means a 429, not extra work.
actors: Client | API | Limiter
Client -> API: request number 101
API -> Limiter: any tokens left?
Limiter --> API: no, bucket is empty
API --> Client: 429 + Retry-After !
```

The bucket allows a **burst** of up to its capacity, a short spike of requests, then settles to the refill rate. That matches real behavior: a page loads ten API calls at once, then goes quiet. A Java version for a single process:

```java
class TokenBucket {
    private final long capacity;
    private final double refillPerSecond;
    private double tokens;
    private long lastNanos;

    TokenBucket(long capacity, double refillPerSecond) {
        this.capacity = capacity;
        this.refillPerSecond = refillPerSecond;
        this.tokens = capacity;
        this.lastNanos = System.nanoTime();
    }

    synchronized boolean tryAcquire() {
        long now = System.nanoTime();
        tokens = Math.min(capacity, tokens + (now - lastNanos) / 1e9 * refillPerSecond);
        lastNanos = now;
        if (tokens >= 1) {
            tokens -= 1;
            return true;
        }
        return false;
    }
}
```

Keep one bucket per caller, for example in a map keyed by API key. That map grows with every new caller, so evict buckets that have gone idle. A well-tested library, such as Bucket4j, saves you from writing this yourself.

## The catch: many servers

That class lives in one process. With five servers behind a load balancer, each has its own buckets, so a caller is allowed up to five times the limit, depending on where its requests land. The limit you meant is not the limit you get.

The fix is a counter that all servers **share**. A common choice is Redis, an in-memory data store, with the limit enforced there. A simple version counts per window, so it has the fixed-window flaw from above:

```text
INCR  key           -> returns 1 (first request of the window)
EXPIRE key 60       -> if the server dies between these two, the key never expires
```

The two steps can be separated by a crash. This is a partial failure between steps, a close cousin of the race in [the check-then-act post](/posts/race-condition-check-then-act/). Do them as one **atomic** operation (one indivisible step) with a small Lua script, which Redis runs as a unit, or use a library that already does it.

A shared **token bucket** works the same way. Keep the token count and the last refill time in Redis, and update both inside one script.

The alternative is to apply the limit **once, at the edge**, before traffic reaches the servers. Nginx's `limit_req`, the rate limiter in Spring Cloud Gateway, and the usage plans of cloud API gateways all offer this. There is then a single place to count.

## When the fix goes wrong

Three pitfalls are worth a closer look, because the limiter looks correct until real traffic arrives.

**1. Limiting by IP address only.** The IP address is easy to read from every request, so it is the first thing people use as the key. But many people can share one address. An office or a mobile network often puts thousands of users behind a single public address (this is called NAT). Say you allow 100 requests a minute per address, and 2,000 staff share one. That is 100 ÷ 2,000 = 0.05 requests per person per minute, or one request every 20 minutes. They all get blocked together.

In the other direction, an attacker with 1,000 addresses gets 1,000 × 100 = 100,000 requests a minute, and your limit never notices.

Use an API key or an account as the key whenever the caller is known. Keep the IP address for callers who are not known yet, such as a login page, and as a generous backstop. One more warning: behind a proxy, your server sees the proxy's address. Read the real client address from the header that your own proxy sets, and never trust such a header when it comes straight from the client, because clients can fake it.

**2. The limiter store goes down.** When the limit lives in a shared store such as Redis, every request asks it first. If the store is down, the limiter has two choices. **Fail open** means allow everything, so you risk overload. **Fail closed** means block everything, so you cause an outage.

Many teams never choose. The call throws an error, nobody catches it, and every request returns a server error. That is failing closed by accident: your protection took the site down.

Decide on purpose, and set a short timeout on the limiter call, so a slow store does not slow every request. For most APIs, failing open for a short time is the lesser harm, and you should alert someone. For login and expensive endpoints, fall back to a small in-memory limiter on each server. It is rough, since each server counts alone (see the section above), but it is better than no limit.

**3. No `Retry-After`.** A **429** response means "too many requests". Say 1,000 clients get a 429 in the same second, and nothing tells them when to return. Many retry after a second or less, so the next second brings 1,000 requests again, and the flood continues.

The `Retry-After` header tells the client how long to wait, in seconds. But if every client waits exactly 30 seconds, they all return at the same moment. So make your own clients add **jitter**, a random extra delay. If they wait 30 to 40 seconds, the 1,000 retries spread over 10 seconds, about 100 per second. See [the cascading failures post](/posts/cascading-failures-circuit-breaker/).

The smaller pitfalls, in short:

- **Counting after the work.** If the limiter runs after the expensive query, you have protected nothing. Check first, work second, and return 429 before touching the database.
- **A limit that is too tight.** A bucket sized for averages blocks legitimate bursts. Size the capacity for real peaks.
- **One limit for every endpoint.** A cheap `GET` and an expensive report should not cost the same. Charge more tokens for heavy calls.

## Which should you use?

| Situation | Reach for |
|---|---|
| A public API with per-customer limits | **Token bucket,** keyed by API key |
| Several servers | **A shared counter** (Redis, atomically), or limit at the gateway |
| Login and password reset | **A strict, separate limit** per account and per address |
| Expensive endpoints | **A cost per call,** so heavy calls use more tokens |
| Clients that retry | **`429` with `Retry-After`,** and clients that obey it |

If you are not sure, start at the gateway with one generous limit per API key. A rough limit that exists beats a perfect one that does not.

## The takeaway

1. Without a limit, **one misbehaving caller can slow everyone**, because every request is treated alike.
2. A rate limiter returns **429 with `Retry-After`** once a caller exceeds its share.
3. **Fixed windows** allow double bursts at the edges. A **token bucket** allows controlled bursts and a steady rate.
4. In-memory limits are **per server**, so with five servers the real limit is five times higher. Share the counter, atomically, or limit at the edge.
5. Diagnose with **top callers in the access log**. Key the limit on **account**, not just IP, and check before doing the work.
