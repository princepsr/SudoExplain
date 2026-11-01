---
title: Java memory leak: strong references and heap dumps
date: 2026-11-01
description: Java has a garbage collector, yet services die with OutOfMemoryError. How strong references cause leaks, how to find them in a heap dump, and the fixes.
tags: java, memory, debugging
draft: true
---

## The doubt

A Java service runs fine after a deploy. Over a few days it gets slower. Then it dies with `OutOfMemoryError` (Java's "no memory left" error), someone restarts it, and the cycle begins again.

The confusing part is that Java has a garbage collector (GC), the part of the runtime that frees memory automatically. The code never calls anything like `free()`.

> If Java cleans up after me automatically, how can it run out of memory?

Think of a coat check. The attendant throws away only coats that nobody holds a ticket for. If a ticket is still sitting in some drawer, the coat stays, even if its owner left years ago. The collector works the same way: it frees only what **nothing can reach any more**. If something still points at an object, it stays, even if your code will never use it again. That is a memory leak in a language that has garbage collection.

> [!SUMMARY]
> By the end you will know:
>
> 1. What the garbage collector really frees, and what it can never free
> 2. The three shapes most Java leaks take: static maps, listeners and `ThreadLocal`
> 3. How to **diagnose** a leak from GC logs, a class histogram and a heap dump
> 4. How to fix it, and how the usual fixes go wrong

## First, what "garbage" means

Java keeps its objects in the **heap**, a region of memory with a maximum size set by the `-Xmx` flag. The collector decides what to free by walking from a set of **roots**: things the running program can always reach, such as static fields, local variables on live threads, and active threads themselves.

It follows every reference from the roots. Anything it reaches is **live**. Anything it cannot reach is **garbage** and gets freed.

A normal reference in Java, the kind you write as `Foo f = new Foo();`, is a **strong reference**. As long as a strong reference chain leads from a root to an object, that object is live. The collector does not ask whether you still need it. It only asks whether it can be reached.

So a leak in Java is not "memory I forgot to free". It is "an object I no longer need, which something still points to".

## The failure: a cache that never forgets

Here is the most common leak in production code. It looks harmless:

```java
public class ProductService {
    private static final Map<String, Product> CACHE = new ConcurrentHashMap<>();

    public Product find(String key) {
        return CACHE.computeIfAbsent(key, this::loadFromDatabase);
    }
}
```

The map is `static`, so it hangs off a root for as long as the class is loaded, which is the life of the application. Every key that is ever requested stays in it forever.

With a few thousand products, that is fine. Then someone builds the key from something that varies: a user ID, a search phrase, a session ID, a timestamp. The map gains a new entry for every distinct request and never loses one.

```text
Day 1:   200,000 entries     heap after GC:  400 MB
Day 3:   900,000 entries     heap after GC: 1.8 GB
Day 5: 1,700,000 entries     heap after GC: 3.4 GB   -> OutOfMemoryError
```

The service did not use more memory because it got busier. It used more because **nothing was ever allowed to leave**. It also got slower first: as the heap fills, the collector runs more often and works harder, so CPU goes to GC instead of requests.

```diagram
type: flow
alt: A static field holds a map, the map holds every product, so the collector can never free them and the heap fills.
caption: Figure 1. The collector sees a chain from a root to every old entry, so it keeps them all.
Root: static field CACHE -> Map holds every key ever seen -> Old products are still reachable -> GC cannot free them !
```

## Two other shapes you will meet

The static map is the classic, but two more cause just as many incidents.

**Listeners that are never removed.** A component registers itself with something long-lived, such as an event bus, a scheduler or a static registry, and never unregisters:

```java
eventBus.register(this);   // the bus now holds a strong reference to "this"
// ...the component is "closed", but nobody calls eventBus.unregister(this)
```

Every component you create and throw away is kept alive by the bus, together with everything that component references.

**`ThreadLocal` values on pooled threads.** A `ThreadLocal` stores a value per thread. In a server, threads come from a pool and **live as long as the server does**. A value you set and never remove therefore lives as long as the thread:

```java
private static final ThreadLocal<UserContext> CURRENT = new ThreadLocal<>();

void handleRequest(Request request) {
    CURRENT.set(new UserContext(request));   // set per request, never cleared
    // ...
}
```

The old context stays attached to the thread until the next request overwrites it. It can also leak into that next request. The memory is bounded by the thread count, so this is slow retention rather than endless growth.

The dangerous case is an application server that redeploys applications. A leaked `ThreadLocal` can keep the entire old application's classes alive, so each redeploy leaks again.

## How to diagnose it

The key sign is not "memory is high". A healthy Java heap goes up and down in a sawtooth, because the collector keeps freeing garbage. What matters is **how much is left after a collection**.

**1. Watch the floor, not the peak.** Turn on GC logging with `-Xlog:gc` (JDK 9 and later). Each `Pause` line shows heap size before and after, such as `640M->610M`. Watch the number after the arrow. If it climbs steadily day after day, you have a leak. If it is flat and only the peaks are high, you have a sizing problem instead.

**2. Compare two class histograms.** A histogram lists how many instances of each class are alive. Take one, wait ten minutes under load, take another:

```bash
jcmd <pid> GC.class_histogram > before.txt
# ...wait, while the service handles traffic...
jcmd <pid> GC.class_histogram > after.txt
```

Whatever grew a lot between the two files is your suspect. The leak is often a `HashMap$Node`, a `String` or a `byte[]`, which is common to everything, so also look for your own classes.

> [!WARNING]
> By default, `GC.heap_dump` and `GC.class_histogram` both run a full GC first, which pauses the service. Adding `-all` skips the GC and includes unreachable objects. Run them on one instance, and check free disk space first.

**3. Take a heap dump and ask who is holding on.** A heap dump is a snapshot of every live object. It is about as large as the live heap. Capture one from a running process, or have the JVM write one when it dies:

```bash
jcmd <pid> GC.heap_dump /tmp/heap.hprof
# or, set in advance on the java command line:
# -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/dumps
```

Open it in a tool such as Eclipse Memory Analyzer (MAT) or VisualVM. In MAT, start with the Leak Suspects report. Then open the **dominator tree**, which lists objects by how much memory each one alone keeps alive.

Right-click a suspicious object, choose **Path to GC Roots**, then **exclude weak/soft references**. That path is the answer: it shows the exact chain of references, starting from a root, that keeps the object alive. In the static map example it ends at `ProductService.CACHE`.

> [!WARNING]
> A heap dump contains everything in memory: passwords, tokens, personal data. Treat the file like a secret. Do not attach it to a public ticket or upload it to an online tool.

## Fix 1: put a limit on the cache

If something is meant to be a cache, give it a size limit, so old entries are evicted. A least-recently-used (LRU) map is enough for a start (this snippet needs Java 9 or later):

```java
static <K, V> Map<K, V> lruCache(int maxEntries) {
    return Collections.synchronizedMap(
        new LinkedHashMap<>(16, 0.75f, true) {          // true = order by last access
            @Override
            protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
                return size() > maxEntries;
            }
        });
}
```

In real services, most people use a library such as Caffeine, which adds expiry and statistics. The idea is the same: **every cache needs a maximum size, or a time limit, or both**.

## Fix 2: remove what you register

Anything that adds itself to a long-lived structure must take itself out when it is finished. Tie that to a clear lifecycle: unregister in `close()`, use `try`-with-resources, or let a framework own the lifecycle.

For `ThreadLocal`, always clear the value in a `finally` block:

```java
void handleRequest(Request request) {
    try {
        CURRENT.set(new UserContext(request));
        // ...
    } finally {
        CURRENT.remove();     // pooled threads live on; the value must not
    }
}
```

## Fix 3: weak references, with care

A **weak reference** does not keep its object alive. If only weak references reach it, the collector frees it. `WeakHashMap` uses weak keys, so an entry disappears when nothing else holds the key.

It is useful, but it is easy to get wrong. If the **value** in the map refers back to its own key, the key is reachable through the value, so it is never freed and the entry stays forever. Keys that stay strongly reachable elsewhere, such as string literals, are never collected either, and `WeakHashMap` is not thread-safe.

Weak references are also cleared at the collector's convenience, so an entry can vanish earlier than you expect. They suit "attach extra data to an object while that object lives". They do not suit a general cache.

## When the fix goes wrong

The leak is the cause, so anything that only hides it will fail later. Here are the three tempting ones.

**1. Raising `-Xmx`.** It looks right because the crash said "out of memory". But a leak does not stop growing when you give it more room. Take the numbers from the example: the heap held 400 MB after day 1 and 3.4 GB after day 5, so it grew about 750 MB a day. A 4 GB heap fills in about 5 days. An 8 GB heap fills in about 10 days. You bought five days, and you pay for twice the memory. The heap dump you will need is also twice as big, and each full collection has more live objects to walk.

**What to do instead.** Treat a bigger heap as a short delay while you find what holds the memory, using a heap dump.

**2. Restarting every night.** A restart empties the heap, so the crash never arrives. That works as long as the leak needs more than a day to fill the heap. At 750 MB a day and 4 GB, it does. But leaks grow with traffic. If traffic becomes 5 times larger (a sale, a new customer), the leak grows to about 3.75 GB a day. The heap then fills in under a day (about 3.6 GB of room divided by 3.75 GB a day is 0.96 days), so the crash comes before the restart, at the busiest time.

**What to do instead.** Use the restart only to buy time, with an alert on the heap level after each collection (the floor). Then fix the leak.

**3. A "bounded" cache with a bad key.** A cache needs a limit, so you add one of 10,000 entries. Good. But look at the key. If it holds something unique per request, such as a timestamp, no request ever finds an old entry. Every call is a miss and goes to the database as before. The cache is always full of entries nobody will ask for again. Memory stops growing, so the leak looks fixed, but you now have a cache that does nothing and a database that gets just as much work.

**What to do instead.** Build the key only from what identifies the data, such as the product id. Then measure the hit rate, which is the share of lookups answered from the cache. Caffeine reports it when you enable `recordStats()`. A hit rate near zero means the key or the limit is wrong.

Smaller trap:

- **Capping a cache too high.** A limit of 50 million entries is a limit in name only. Size it from your memory budget: entries multiplied by average entry size.

## Which should you use?

| Situation | Reach for |
|---|---|
| A map used as a cache | **A bounded cache** (Caffeine or an LRU map), with a size limit and often an expiry |
| A component registers with something long-lived | **Unregister on close.** Tie it to a lifecycle |
| Per-thread state on a thread pool | **`ThreadLocal` with `remove()` in `finally`,** or avoid it and pass values explicitly |
| Extra data attached to objects owned elsewhere | **`WeakHashMap`,** after checking values do not refer to the keys |
| You cannot find the leak | **A heap dump and "Path to GC Roots".** Do not guess |

If you are not sure where to start, start with the heap dump. It shows who is holding the memory in a few minutes, and guessing can take days.

A queue that grows without limit is a close cousin of this leak. [The unbounded queue post](/posts/unbounded-thread-pool-queue/) shows the same slow death from a different source.

## The takeaway

1. The collector frees what **nothing can reach**. It does not know what you still need.
2. A Java leak is an unneeded object that something still **strongly references**.
3. The three usual suspects: **static maps** that only grow, **listeners** never removed, and **`ThreadLocal`** values on pooled threads.
4. The sign of a leak is the heap size **after each GC** rising over time, not a high peak.
5. Find it with a **class histogram** (what grows) and a **heap dump** (who holds it). Then fix the ownership, not the heap size.
