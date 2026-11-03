---
title: DNS caching: why traffic still hits the old server
date: 2026-11-01
description: Why traffic still reaches the old server after a DNS change, how TTL and caches at every layer cause it, and how to plan a migration that avoids it.
tags: DNS, networking, deployment
draft: true
---

## The question

You move a service to new servers. You change one DNS record, check it, and shut the old machines down at the end of the day. Then the complaints arrive.

Some users see errors. Some of your own services still call the old address. A colleague on another network says everything works. The record is right, so what is going on?

> I changed the record an hour ago. Why is traffic still going to the old server?

Because the record is not stored in one place. Many caches hold a copy, and each one keeps its copy until a timer runs out.

> [!SUMMARY]
> By the end you will know:
>
> 1. What DNS does, and what the **TTL** on a record means
> 2. Which caches sit between a user and your record, including the one inside the JVM
> 3. How to **diagnose** a stale answer with `dig` and `nslookup`
> 4. How to plan a change with a lowered TTL, a draining old server and a health-checked front

## First, names, addresses and timers

**DNS** (the Domain Name System) turns a name such as `api.example.com` into an **IP address** such as `203.0.113.10`. Computers connect to addresses, not names, so every connection starts with a lookup.

Think of a phone book that many people photocopy. You change a number in the original, but the copies stay as they were until their owners replace them.

Each record carries a **TTL** (time to live): the number of seconds a cache may keep the answer before asking again. A **resolver** is the server that looks names up for you, usually run by your ISP, your company or a public provider. It keeps answers until their TTL ends. Your operating system, browser and application often add caches of their own.

## The failure: every cache keeps its own copy

You change `api.example.com` from `203.0.113.10` to `203.0.113.20`. The record had a TTL of 86,400 seconds, which is 24 hours.

```diagram
type: sequence
alt: A resolver cached the old address, so a client keeps reaching the old server after the record changed.
caption: Figure 1. The resolver answers from its cache, so the client never sees the new record.
actors: Client | Resolver | DNS zone | Old server
Client -> Resolver: api.example.com?
Resolver -> DNS zone: api.example.com? (10:00)
DNS zone --> Resolver: 203.0.113.10, TTL 86400
note DNS zone: record changed to .20 at 12:00
Client -> Resolver: api.example.com? (13:00)
Resolver --> Client: 203.0.113.10 (cached) !
Client -> Old server: still connects here !
```

The resolver asked at 10:00 and may keep that answer until 10:00 the next day. People call this "propagation", but nothing is pushed anywhere. The old copies simply **expire**. Resolvers that never asked recently fetch the new value at once, which is why some users see the change early and others see it late.

## Every layer caches

A request passes through several caches, each with its own timer:

- **The recursive resolver** (the shared one at your ISP or company) honors the TTL, though some apply their own minimum or maximum.
- **The operating system** may keep a small cache. Windows always does, and on Linux it depends on whether a local resolver such as systemd-resolved is running.
- **The browser** keeps its own short-lived cache of lookups.
- **The JVM** caches lookups made through `InetAddress`. The JDK default is 30 seconds when no security manager is installed. The setting is the security property `networkaddress.cache.ttl`, and a value of `-1` means cache forever. Some platforms and base images change it, so check yours.
- **Connection pools** do not look up the name again at all. A pool that already holds connections to `203.0.113.10` keeps using them until they close, however short the TTL is.

The last one surprises people most. DNS is only asked when a **new** connection opens.

## Negative caching

A resolver also remembers **no**. If you query a name before you create it, the resolver may cache the answer "does not exist". RFC 2308 says the length comes from the smaller of the zone's SOA `MINIMUM` field and the SOA record's own TTL. The SOA is a record at the top of each zone that holds its administrative settings.

The JVM does this too. Its `networkaddress.cache.negative.ttl` defaults to 10 seconds in the JDK 21 `java.security` file. So a new record can look missing for a while after you add it.

## How to diagnose it

**1. Ask for the answer and read the TTL.** The number after the name is the seconds **remaining** in that resolver's cache. Illustrative output:

```bash
dig +noall +answer api.example.com
```

```text
api.example.com.   5120   IN   A   203.0.113.10
```

Run it again a minute later. If the number fell by about 60, you are reading a cache that is counting down. If it jumps back to the full TTL, the cache just refreshed. The `+noall +answer` options print only the answer lines.

**2. Ask a specific resolver.** Put an `@` and the resolver's address before the options. This compares what different caches believe:

```bash
dig +noall +answer api.example.com @203.0.113.53
```

To skip caches and ask the zone's own server, run `dig +trace api.example.com`. It starts at the root and follows the delegation. The `NS` record lists the authoritative servers, which hold the real record.

**3. On Windows, use `nslookup`.**

```bash
nslookup api.example.com 203.0.113.53
```

Without the second argument it uses the machine's default resolver. Add `-debug` to see the TTL.

**4. Check the JVM and the pools.** If `dig` is right but the app is wrong, print the JVM setting with `Security.getProperty("networkaddress.cache.ttl")`. If it prints `null`, the property is unset and the JDK default applies (30 seconds with no security manager, forever with one), so set it explicitly if you need a known value. Then check how old the pooled connections are.

> [!WARNING]
> Flushing caches is harmless to data, but it can briefly slow a busy machine. On Windows, `ipconfig /flushdns` clears the local cache. On Linux with systemd-resolved, use `resolvectl flush-caches`. Flushing your laptop does not clear your ISP's resolver.

## Fix 1: lower the TTL well before the change

A cache that holds the old record for up to 24 hours was told so when it fetched it. Lowering the TTL now does not shorten that wait. So lower it **at least one old TTL ahead** of the change.

Plan for the example: the change is Friday at 14:00 and the TTL is 86,400 seconds. Drop the TTL to 60 seconds by Thursday at 14:00. By Friday, every cache is holding a 60-second record. Change the record, and the world follows within about a minute. After things are stable, **raise the TTL** again, for example to 3,600 seconds, to cut lookup load.

The cost: more lookups for a while, and a short TTL is no help against a resolver that applies its own minimum.

## Fix 2: keep the old server serving until traffic drains

Do not turn the old server off when you change the record. Keep it running with the same data, or have it forward requests to the new one. Watch its request rate fall. Switch it off only when the traffic is near zero, and well past the longest TTL that anyone could still hold.

The cost: you run two environments for a while, and both must stay correct. A database that only the new server writes to will give the old server stale reads.

## Fix 3: put a load balancer or failover in front

Clients should resolve a name that **never changes**, pointing at a load balancer. Behind it you add and remove servers with no DNS change. The [502 Bad Gateway post](/posts/502-bad-gateway-keep-alive/) covers a trap in that layer.

For failover, some DNS providers run health checks and swap the record when a server fails. This works, but only as fast as the TTL and the resolvers allow.

## Fix 4: refresh the clients you control

For your own JVM services, set the TTL on purpose. Put it in the `java.security` file, or set it in code before the first lookup:

```java
import java.security.Security;

public class Startup {
    public static void main(String[] args) {
        // must run before the first name lookup in the process
        Security.setProperty("networkaddress.cache.ttl", "30");
    }
}
```

Also give pooled connections a **maximum lifetime**, so they close and reconnect now and then. Most pool libraries have a setting for it. Without one, a pool can keep a dead address for days. The [connection pool exhaustion post](/posts/connection-pool-exhausted/) covers other pool settings, such as size and leak detection. Check your pool's own documentation for the maximum lifetime.

The cost: very low values increase lookups, and the JDK notes that changing the default can matter for DNS spoofing protection.

## When the fix goes wrong

Most of these are small. Three of them cause real outages, so they get more space.

**1. Lowering the TTL too late.** The plan looks right: drop the TTL to 60 seconds, then change the record. But a cache only learns the new TTL when it next asks. Until then it keeps the old answer for the old time.

Say the TTL is 86,400 seconds (24 hours). A resolver fetched the record at 09:00 on Thursday, so it may keep it until 09:00 on Friday. You lower the TTL to 60 at 13:00 and change the record at 14:00. That resolver has not asked again, so it still serves the old address. Its users stay on the old server for 19 hours, from 14:00 to 09:00 the next day.

**What to do instead.** Lower the TTL at least one full old TTL before the change. Here that means by 14:00 on Thursday for a change at 14:00 on Friday. By then every cache has asked again at least once, and each one holds the 60-second value.

**2. Believing DNS failover is instant.** DNS failover means a provider checks your servers and swaps the record when one fails. People expect users to move within seconds. The delays add up.

Take these numbers (assumed, check your own provider). The health check runs every 30 seconds and needs 3 failures in a row. That is 3 × 30 = 90 seconds before the record changes. Then caches keep the old record for up to the TTL, say 60 more seconds. That is about 150 seconds so far. On top of that, pooled connections do not look the name up again. A pool keeps trying the dead address until its connections close.

**What to do instead.** Plan for minutes, not seconds. Use a short TTL, give pools a maximum connection lifetime, and for fast failover put a load balancer in front, so clients never need a new address.

**3. Creating the record late.** A resolver also remembers "this name does not exist". If someone looks up `api.example.com` at 11:55, before you create it at 12:00, that "no" is cached. Suppose the zone's negative caching time is 3,600 seconds (assumed). Then that resolver keeps saying "no such name" until 12:55, even though the record exists.

**What to do instead.** Create the record before anyone is told to use it. Test from a resolver that has not seen the name. If a "no" was already cached, you can only wait for it to expire, or ask the resolver's operator to flush it.

The smaller ones:

- **Forgetting to raise the TTL again.** A 60-second TTL forever means more load and more dependence on your DNS provider.
- **Testing from one machine.** Your own cache can mislead you. Query several resolvers.
- **Ignoring other uses of the name.** Mail servers, allow-lists and certificates may depend on the old address.

## Which should you use?

| Situation | Reach for |
|---|---|
| A planned migration | **Lower the TTL a full old TTL ahead,** then raise it |
| Old clients still arriving | **Keep the old server serving** until traffic drains |
| Frequent server changes | **A load balancer** behind a stable name |
| JVM apps hold stale addresses | **An explicit cache TTL** and a pool lifetime limit |

If you are not sure, run `dig` against two resolvers and read the TTL numbers. They tell you how long the slowest cache can last.

## The takeaway

1. DNS maps names to addresses, and **every answer comes with a TTL**.
2. "Propagation" is really **caches expiring**, each on its own timer.
3. The JVM, the OS and **connection pools** keep old addresses too.
4. Diagnose with **`dig`**, reading the remaining TTL and asking specific resolvers.
5. Lower the TTL **early**, keep the old server alive, and put a stable front in place.
