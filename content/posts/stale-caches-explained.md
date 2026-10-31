---
title: Stale caches explained: why two servers show different data
date: 2026-11-01
description: Why two servers can give two different answers to the same question, how to spot a stale cache, and three ways to fix it.
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

## First, the basics

### Memory and the database

An application keeps its important data, such as products, prices and orders, in a **database**. A database is a program built to store data safely on disk, so that nothing is lost when the power goes off.

Disks are safe but slow. Asking the database for something takes a trip, and the answer comes back after a short wait. Do that thousands of times a second and the waiting adds up.

An application also has **memory** (RAM), which is the fast, short-term space a running program uses to hold things it is working with right now. Reading from memory is far quicker than a trip to the database. The catch is that memory is private to one running program, and it is wiped when the program stops.

### What is a cache?

A **cache** is a saved copy of an answer, kept close by so you can reuse it quickly.

Think of a notebook on your desk. The first time someone asks you a phone number, you walk to the library, look it up and write it in the notebook. The next time, you read it straight from the notebook. That is much faster than walking to the library again.

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

Look at `setPrice`. When the price changes, the code updates the database **and** its own notebook. On a single server this is perfect: the notebook can never disagree with the database, because there is only one notebook and one writer.

### Stale

A cached copy is **stale** when the real data has changed but the copy has not. The notebook still says $20 while the library says $25. A stale answer is not an error. It is an out-of-date answer that looks completely normal, and that is exactly what makes it hard to spot.

## One server has one notebook. Two servers have two.

Real apps rarely run on one server, because one server means limited capacity, no backup if it crashes, and downtime for every release. So you run several copies and put a **load balancer** in front. A load balancer is a traffic cop: it receives every request and hands each one to one of the servers. (If that is new, the [sessions post](/posts/sessions-jwt-and-load-balancers/) explains it from scratch.)

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
  curl -si https://example.com/api/products/42 | grep -E "X-Served-By|price"
done
```

**3. Read the output.** A stale cache looks like this:

```text
X-Served-By: server-a
{"id":42,"price":25}
X-Served-By: server-b
{"id":42,"price":20}
X-Served-By: server-a
{"id":42,"price":25}
X-Served-By: server-b
{"id":42,"price":20}
```

The same address gives two different answers, and the answer depends on **which server replied**. Server A always says 25. Server B always says 20. That pattern is the fingerprint of a stale cache in one server's memory.

**4. Check the source of truth.** Look at the price in the database itself. If it says 25, the data is fine and one of the notebooks is out of date.

> [!NOTE]
> If the answers are random and do **not** line up with the server names, the cause is something else, such as two requests racing each other. The giveaway for a stale cache is that each server is consistently wrong in its own way.

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

Checking one small number is cheap. Reloading the whole product on every request is not. The version number tells you exactly when a reload is needed, so stale answers disappear, and you only pay for the full read when something really changed.

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

## Which should you use?

| Situation | Reach for |
|---|---|
| Being a little out of date is harmless (counters, trending lists) | **Expiry (TTL).** Simple, nothing clever to get wrong |
| The data must be correct, and one small database read per request is fine | **Version number.** Always correct, still cheaper than reloading |
| Many servers, very high traffic, and each trip to the database hurts | **Invalidation or a shared cache,** plus a TTL as a backstop |
| You are not sure whether you even need a cache | **No cache.** Measure first, because a cache you do not need is a bug waiting to happen |

If you are not sure, start with a short TTL. It is the easiest to understand and the easiest to remove. Move to versions or invalidation when "a minute out of date" turns out to matter to real users.

## The takeaway

1. A **cache** is a saved copy that makes things faster. It is only safe while the copy matches the original.
2. A cache in **one server's memory** is private to that server. Add a second server and you have two copies that can disagree.
3. A **stale** answer looks completely normal, which is why the bug feels random instead of broken.
4. Diagnose it by asking the same question many times and noting **which server** answers. Each server being consistently different is the fingerprint.
5. Fix it by making copies **expire**, by **checking a version**, or by **telling every server** when data changes. Each trades freshness against speed and complexity.
