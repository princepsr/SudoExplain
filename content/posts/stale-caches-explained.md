---
title: Stale cache and cache stampede: why servers disagree
date: 2026-11-01
description: Why two servers give different answers, how to spot a stale cache, three ways to fix it, and how a cache stampede can follow.
tags: caching, system-design, scaling, web
---

## The doubt

Imagine an online shop. You change a product's price from $20 to $25 and save it. You open the product page and see $25. Good.

Then a customer opens the very same page and still sees **$20**. They refresh. Now it says $25. They refresh again. $20.

Nothing is broken in the usual sense. There is no error, no crash, and the database holds the right price. The site is just giving different answers to the same question, and it seems to change its mind at random.

> The price is saved correctly, so why do some people still see the old one?

The answer is a **stale cache**. It only makes sense after a few basics, so we start there. I won't assume you know any of these words.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a cache is, and why almost every app uses one
> 2. Why a cache that works on one server goes wrong on two
> 3. How to **diagnose** a stale cache with a few requests
> 4. Three ways to **fix** it, and what each one costs
> 5. How a fix can fail under real traffic, and how to stop it

## First, the basics

A **cache** is a saved copy of an answer, kept close by so you can reuse it without the slow trip to where it came from. Think of a notebook on your desk: you look a phone number up in the library once, write it down, and read it from the notebook after that.

For an app, the library is the database, the notebook is the cache, and the cache usually lives in the server's memory:

```pseudocode
function getPrice(productId):
    if cache has productId:
        return cache[productId]            # fast: no trip to the database
    price = database.readPrice(productId)  # slow: the trip
    cache[productId] = price               # write it in the notebook
    return price

function setPrice(productId, newPrice):
    database.writePrice(productId, newPrice)
    cache[productId] = newPrice            # keep the notebook up to date
```

Look at `setPrice`. It updates the database **and** its own notebook. On a single server that is perfect, because there is one notebook and one writer, so the two can never disagree.

A cached copy is **stale** when the real data has changed but the copy has not. A stale answer is not an error. It looks completely normal, which is what makes it hard to spot.

## One server has one notebook. Two servers have two.

Real apps rarely run on one server, so you run several copies behind a **load balancer**, which hands each incoming request to one of them. (New to that? The [sessions post](/posts/sessions-jwt-and-load-balancers/) explains it from scratch.)

Here is the catch. Each server is a separate running program, so each one has **its own memory** and therefore **its own notebook**. They do not share it, and they do not know what is in each other's.

## The problem: two notebooks that disagree

Watch what happens when you change the price with two servers running:

<figure>
<div class="diagram diagram-wide">
<svg viewBox="0 0 680 300" role="img" aria-label="Diagram: an admin saves a new price of 25 through the load balancer to Server A. Server A writes 25 to the database and to its own cache. Server B still has the old price of 20 in its cache, so a customer routed to Server B sees 20.">
  <defs><marker id="arr-c1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <g font-family="var(--sans)" font-size="14" fill="currentColor" stroke="currentColor" stroke-width="2">
    <rect x="10" y="120" width="130" height="56" rx="8" fill="none"/>
    <rect x="260" y="30" width="190" height="80" rx="8" fill="none"/>
    <rect x="260" y="190" width="190" height="80" rx="8" fill="none"/>
    <rect x="540" y="115" width="130" height="70" rx="8" fill="none"/>
    <line x1="140" y1="135" x2="256" y2="78" marker-end="url(#arr-c1)"/>
    <line x1="140" y1="161" x2="256" y2="222" stroke="var(--accent)" stroke-dasharray="6 5" marker-end="url(#arr-c1)"/>
    <line x1="450" y1="70" x2="536" y2="135" marker-end="url(#arr-c1)"/>
    <g stroke="none" text-anchor="middle">
      <text x="75" y="153">Load balancer</text>
      <text x="355" y="62">Server A</text>
      <text x="355" y="88" font-size="13">cache: price = 25</text>
      <text x="355" y="222">Server B</text>
      <text x="355" y="248" font-size="13">cache: price = 20</text>
      <text x="605" y="146">Database</text>
      <text x="605" y="168" font-size="13">price = 25</text>
      <text x="355" y="292" font-size="13" fill="var(--accent)">Customer sees $20 (stale)</text>
    </g>
    <g stroke="none" font-size="13">
      <text x="150" y="90">1. save $25</text>
      <text x="150" y="212" fill="var(--accent)">2. view page</text>
    </g>
  </g>
</svg>
</div>
<div class="diagram diagram-tall">
<svg viewBox="0 0 340 420" role="img" aria-label="Diagram: an admin saves a new price of 25 through the load balancer to Server A. Server A writes 25 to the database and to its own cache. Server B still has the old price of 20 in its cache, so a customer routed to Server B sees 20.">
  <defs><marker id="arr-c1t" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <g font-family="var(--sans)" font-size="14" fill="currentColor" stroke="currentColor" stroke-width="2">
    <rect x="100" y="10" width="140" height="44" rx="8" fill="none"/>
    <rect x="10" y="130" width="150" height="84" rx="8" fill="none"/>
    <rect x="180" y="130" width="150" height="84" rx="8" fill="none"/>
    <rect x="100" y="290" width="140" height="64" rx="8" fill="none"/>
    <line x1="140" y1="54" x2="88" y2="126" marker-end="url(#arr-c1t)"/>
    <line x1="200" y1="54" x2="252" y2="126" stroke="var(--accent)" stroke-dasharray="6 5" marker-end="url(#arr-c1t)"/>
    <line x1="85" y1="214" x2="140" y2="286" marker-end="url(#arr-c1t)"/>
    <g stroke="none" text-anchor="middle">
      <text x="170" y="37">Load balancer</text>
      <text x="85" y="165">Server A</text>
      <text x="85" y="191" font-size="13">cache: 25</text>
      <text x="255" y="165">Server B</text>
      <text x="255" y="191" font-size="13">cache: 20</text>
      <text x="170" y="318">Database</text>
      <text x="170" y="340" font-size="13">price = 25</text>
      <text x="255" y="240" font-size="13" fill="var(--accent)">Customer sees</text>
      <text x="255" y="258" font-size="13" fill="var(--accent)">$20 (stale)</text>
    </g>
    <g stroke="none" font-size="13">
      <text x="20" y="100">1. save $25</text>
      <text x="215" y="100" fill="var(--accent)">2. view page</text>
    </g>
  </g>
</svg>
</div>
<figcaption>Figure 1. Server A updates its own notebook and the database. Server B never hears about it, so it keeps serving the old price.</figcaption>
</figure>

1. The admin saves $25. The load balancer sends that request to **Server A**. Server A writes $25 to the database and to its own cache.
2. A customer opens the product page. The load balancer sends this request to **Server B**. Server B has $20 in its notebook, so it answers $20 without ever asking the database.

Server B did nothing wrong. It followed the code exactly. It just has no way to know that Server A changed anything.

This explains the random flipping: each refresh may land on a different server, and each server tells its own version of the truth. Like the session bug, this one **never shows up on your laptop**, because on your laptop there is only one notebook.

### See it yourself

You can reproduce it in a few lines of Java. Two "servers" each get their own cache, and they share one "database":

```java
import java.util.HashMap;
import java.util.Map;

public class StaleCache {
    static Map<Integer, Integer> database = new HashMap<>();

    static class Server {
        Map<Integer, Integer> cache = new HashMap<>();

        int getPrice(int id) {
            return cache.computeIfAbsent(id, database::get);
        }

        void setPrice(int id, int price) {
            database.put(id, price);
            cache.put(id, price);
        }
    }

    public static void main(String[] args) {
        database.put(42, 20);
        Server a = new Server();
        Server b = new Server();

        System.out.println(a.getPrice(42)); // 20
        System.out.println(b.getPrice(42)); // 20
        a.setPrice(42, 25);
        System.out.println(a.getPrice(42)); // 25
        System.out.println(b.getPrice(42)); // 20  <- stale
    }
}
```

Save it as `StaleCache.java` and run `java StaleCache.java` (this needs Java 11 or newer). The last line prints 20 even though the database now holds 25.

## How to diagnose it

When users say "I see old data, but only sometimes", suspect this. Here is how to confirm it.

**1. Notice the pattern.** The data is correct in the database. The wrong answer comes and goes with refreshes. It started after you added a second server, or it disappears when you run just one.

**2. Find out which server answers.** Have each server add a **header** to its responses with its own name, for example `X-Served-By: server-a`. A header is a labelled extra line of information sent along with the page. Then ask for the same page several times. The tool below is `curl`, a command-line program that makes web requests for you:

```bash
for i in 1 2 3 4 5 6; do
  curl -si https://example.com/api/products/42 | grep -iE "x-served-by|price"
done
```

**3. Read the output.** A stale cache looks like this:

```text
x-served-by: server-a
{"id":42,"price":25}
x-served-by: server-b
{"id":42,"price":20}
x-served-by: server-a
{"id":42,"price":25}
x-served-by: server-b
{"id":42,"price":20}
```

(Over HTTP/2 and HTTP/3, header names are sent in lowercase, which is why `grep -i` ignores the case.)

The same address gives two different answers, and the answer depends on **which server replied**. Server A always says 25. Server B always says 20. That pattern is the fingerprint of a stale cache in one server's memory.

**4. Check the source of truth.** That is the one place that holds the real data, here the database. Look at the price there. If it says 25, the data is fine and one of the notebooks is out of date.

> [!NOTE]
> If the answers are random and do **not** line up with the server names, the cause is something else, such as two requests racing each other. The giveaway for a stale cache is that each server is consistently wrong in its own way.
>
> Also check for caches in front of your servers, in the browser or a CDN (a network of servers that keeps copies of pages close to users). Look at the `Cache-Control` and `Age` response headers. A response with a large `Age` came from such a cache, not from your app.

## Fix 1: let copies expire

The simplest fix is to give every cached copy a **time to live**, usually shortened to **TTL**. It is a timer that says "trust this copy for 60 seconds, then throw it away and ask the database again."

```pseudocode
function getPrice(productId):
    entry = cache[productId]
    if entry exists and now < entry.expiresAt:
        return entry.price
    price = database.readPrice(productId)
    cache[productId] = { price: price, expiresAt: now + 60 seconds }
    return price
```

(`setPrice` must store an expiry time in the same way when it writes to the cache.)

Server B's $20 now lives for at most a minute. After that it fetches 25 from the database and the servers agree again.

**The cost:** for up to one TTL, people can still see the old price. A shorter timer means fresher data but more trips to the database, which is the thing the cache was meant to avoid. Expiry is a good fit when slightly old data is harmless, such as a view count. It is a poor fit for a price someone just corrected.

## Fix 2: check a version number

Instead of guessing how long a copy stays good, ask whether it is still good. Keep a **version number** next to the data in the database: a counter that goes up by one every time the data changes. Before trusting its notebook, a server compares versions:

```pseudocode
current = database.versionOf("product:42")    # cheap: one small number

if cache.version != current:                  # someone changed it elsewhere
    cache.data    = database.readProduct(42)  # reload the fresh copy
    cache.version = current
```

Checking one small number is cheap. Reloading the whole product on every request is not. The version number tells you exactly when a reload is needed, so stale answers become much rarer, and you only pay for the full read when something really changed.

**The cost:** every request still makes one small trip to the database to read the version. You save the heavy work but not the trip. If the trip itself is the problem, you need the next fix.

## Fix 3: tell the other servers (invalidation)

The third idea is to stop waiting for servers to find out, and **tell them**. When a server changes the data, it announces the change, and every server throws away its old copy. Removing a cached copy because it is no longer true is called **invalidation**.

```pseudocode
function setPrice(productId, newPrice):
    database.writePrice(productId, newPrice)
    announce("product:" + productId + " changed")    # every server hears this

on hearing "product:42 changed":
    cache.remove(42)                                 # next read fetches fresh data
```

The announcement travels over a **message channel**, which is a shared pipe that servers can send short notes into and listen to. Many systems provide one, so you rarely build it yourself.

There is a close relative of this idea: instead of each server having its own notebook, keep **one shared notebook** that all servers read and write, in a separate fast store. This is the same move as the shared session store in the sessions post. There is only one copy, so there is nothing to disagree with.

**The cost:** more moving parts. Messages can be lost if a server is restarting at the wrong moment, and a shared store is one more thing that must stay running. So real systems usually combine this with a TTL as a safety net: even if an announcement is missed, the copy dies on its own within a minute.

## When the fix itself breaks: the cache stampede

Fix 1 has a hidden problem that only shows up under real traffic. Every copy gets the same timer, so popular items **expire at the same moment**.

Picture the product page everyone is viewing. Its cached copy expires at 12:00:00. In the next second a thousand requests arrive, and every one of them finds the cache empty. Each one asks the database for the same thing at the same time.

The database slows down under the sudden load. Requests start timing out, so nobody manages to refill the cache, and the pile-up grows. This is called a **cache stampede**: a crowd of requests all rushing to rebuild the same missing copy at once. The cache was meant to protect the database, and at that moment it does the opposite.

**How you would notice.** The database is calm, then load spikes sharply at the instant popular items expire, and responses get slow for a while. If traffic is steady, charts of database load show regular spikes, spaced one TTL apart.

There are two common fixes, and real systems usually use both.

**1. Let only one request rebuild.** The first request to find the copy missing takes a **lock**, which is a marker that lets only one request through at a time. It reloads the data. The others either wait a moment, or are handed the old copy until the new one is ready.

```pseudocode
function getPrice(productId):
    entry = cache[productId]
    if entry exists and now < entry.expiresAt:
        return entry.price

    if lock.tryAcquire("price:" + productId):     # only one request wins
        price = database.readPrice(productId)
        cache[productId] = { price: price, expiresAt: now + ttl }
        lock.release("price:" + productId)
        return price

    return entry.price if entry exists            # others serve the old copy
    # (or wait briefly, then read the cache again)
```

**2. Spread out the expiry times.** Instead of exactly 60 seconds, use 60 seconds plus a random few. Copies made at the same moment now die at slightly different moments, so the reloads trickle in instead of arriving as one wave.

```pseudocode
ttl = 60 seconds + random(0 to 10 seconds)        # "jitter"
```

The lock must be shared by all servers, for example kept in the shared store. A lock held in one server's memory only protects that server. Deleting a popular copy (Fix 3) causes the same stampede, so the lock helps there too. After a deletion there is no old copy to serve, so the other requests must wait for the rebuild.

The cost of the lock is a little more code, and one more thing that can go wrong, such as a lock never released after a crash, so locks are given their own short expiry. The cost of jitter is nothing at all. That is why the TTL in real systems almost always carries some randomness.

## Which should you use?

| Situation | Reach for |
|---|---|
| Being a little out of date is harmless (counters, trending lists) | **Expiry (TTL).** Simple, nothing clever to get wrong |
| The data must be correct, and one small database read per request is fine | **Version number.** Correct as of the version check, still cheaper than reloading |
| Many servers, very high traffic, and each trip to the database hurts | **Invalidation or a shared cache,** plus a TTL as a backstop |
| You are not sure whether you even need a cache | **No cache.** Measure first, because a cache you do not need is a bug waiting to happen |

If you are not sure, start with a short TTL. It is the easiest to understand and the easiest to remove. Move to versions or invalidation when "a minute out of date" turns out to matter to real users.

Two more things are worth looking up once this makes sense. Two updates arriving at the same moment can leave a wrong value in the cache for good, which is a **race condition**. And a cache with no size limit slowly fills the server's memory. Both are common in production, and each deserves a post of its own.

## The takeaway

1. A **cache** is a saved copy that makes things faster. It is only safe while the copy matches the original.
2. A cache in **one server's memory** is private to that server. Add a second server and you have two copies that can disagree.
3. A **stale** answer looks completely normal, which is why the bug feels random instead of broken.
4. Diagnose it by asking the same question many times and noting **which server** answers. Each server being consistently different is the fingerprint.
5. Fix it by making copies **expire**, by **checking a version**, or by **telling every server** when data changes. Each trades freshness against speed and complexity.
6. Fixes have failure modes of their own. When popular copies expire together, a **stampede** hits the database. Let only one request rebuild, and **add random jitter** to expiry times.
