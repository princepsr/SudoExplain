---
title: Java memory leak: strong references and heap dumps
date: 2026-11-03
description: Java has a garbage collector, yet services die with OutOfMemoryError. How strong references cause leaks, how to find them in a heap dump, and the fixes.
tags: java, jvm
---

## The question

A Java service runs fine after a deploy. Over a few days it gets slower. Then it dies with `OutOfMemoryError` (Java's "no memory left" error), someone restarts it, and the cycle begins again.

The confusing part is that Java has a garbage collector (GC), the part of the runtime that frees memory automatically. The code never calls anything like `free()`.

> If Java cleans up after me automatically, how can it run out of memory?

Think of a restaurant that takes table bookings. The manager marks a table as free only when there is no booking for it. If a booking made months ago was never cancelled, the table stays blocked, even though those guests will never come. Add enough forgotten bookings and the restaurant says "we are full" while half the tables sit empty.

The collector works the same way: it frees only what **nothing can reach any more**.

If something still points at an object, it stays, even if your code will never use it again. That is a memory leak in a language that has garbage collection.

> [!SUMMARY]
> By the end you will know:
>
> 1. What the garbage collector really frees, and what it can never free
> 2. Two common shapes of Java leaks: static maps and `ThreadLocal`
> 3. How to **diagnose** a leak from GC logs, a class histogram and a heap dump
> 4. How to fix it, and the tempting fix that does not work

## First, what "garbage" means

Java keeps its objects in the **heap**, the area of memory your program uses while it runs. Its maximum size is set by the `-Xmx` flag.

An object is **garbage** when nothing in your program can use it any more. The collector frees only garbage. Everything else is **live**.

How does Java know? Remember the restaurant. A table is free when no booking is attached to it. In Java, a **reference** is the booking: a variable that points at an object. If nothing points at an object, nobody can use it again, so it is garbage.

The normal kind of reference, such as `Foo f = new Foo();`, is called a **strong reference**. While one exists, the object stays live. The collector does not ask whether you still need it. It only asks whether something still points to it.

One more word, for later. Some things in your program are always in use: `static` variables, which last as long as the program runs, and the variables of code that is running right now. Java calls these **roots**. An object is live if a root points at it, directly or through other objects. You will meet the word again when we look at a heap dump.

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

The map is `static`, so it lives as long as the class is loaded, which is the life of the application. Every key that is ever requested stays in it forever.

With a few thousand products, that is fine. Then someone uses a key that is different on almost every request, such as a search phrase, a user ID or a timestamp. Each new key adds a new entry, and nothing ever removes one.

```text
Day 1:   200,000 entries     heap after GC:  400 MB
Day 3:   900,000 entries     heap after GC: 1.8 GB
Day 5: 1,700,000 entries     heap after GC: 3.4 GB   -> OutOfMemoryError
```

The service did not use more memory because it got busier. It used more because **nothing was ever allowed to leave**. It also got slower first: as the heap fills, the collector runs more often and works harder, so CPU goes to GC instead of requests.

```diagram
type: flow
alt: A static field holds a map, the map holds every product, so the collector can never free them and the heap fills.
caption: Figure 1. The collector can still reach every old entry from the static field, so it keeps them all.
Root: static field CACHE -> Map holds every key ever seen -> Old products are still reachable -> GC cannot free them !
```

**The fix: put a limit on the cache.** If something is meant to be a cache, give it a size limit, so old entries are evicted. A least-recently-used (LRU) map is enough for a start (this snippet needs Java 9 or later):

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

## One more shape you will meet: `ThreadLocal`

The static map is the classic. A second one is `ThreadLocal`, which many beginners have never used directly, but frameworks use it all the time. We will build it up step by step.

**Step 1: threads.** A **thread** is one line of work inside your program that runs code. A web server keeps a group of threads, called a **thread pool**. When a request arrives, a free thread takes it, runs your code from start to finish, then goes back to the pool and waits for the next request. The threads are created once and reused for the life of the server.

**Step 2: the problem.** Your code often needs to know who the logged-in user is. Many methods need it, and passing the user into every one of them is tedious.

**Step 3: what `ThreadLocal` is.** A `ThreadLocal` is a variable that holds a **different value for each thread**. One thread stores the current user in it. Any code running on that same thread can read it, without a parameter. A thread never sees what another thread stored.

Think of each thread as having a sticky note on its desk. It writes the user on the note at the start of the request, and anything that runs on that thread during the request can look at the note.

```java
static final ThreadLocal<UserContext> CURRENT =
        new ThreadLocal<>();

// at the start of a request
CURRENT.set(new UserContext(request));

// anywhere else, on the same thread
UserContext user = CURRENT.get();
```

**Step 4: the leak.** When the request ends, the thread goes back to the pool. But **the thread does not go away, so the sticky note stays on its desk** with the old user still written on it. Nothing removes it unless your code does. If you never call `remove()`, the thread still points at the object, and the thread is alive for as long as the server runs. So the object, and everything it holds, stays in memory.

**The fix: throw the note away when the request ends.** Call `remove()` in a `finally` block, so it happens even when the request fails:

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


## How to diagnose it

The key sign is not "memory is high". A healthy Java heap goes up and down, because the collector keeps freeing garbage. What matters is **how much is left after a collection**.

**1. Watch the floor, not the peak.** Turn on GC logging with `-Xlog:gc` (JDK 9 and later). Each `Pause` line shows the heap size before and after a collection, such as `640M->610M`. That means 640 MB was in use before the collector ran and 610 MB after, so it freed only 30 MB. The second number is what the program is still holding on to, so watch the number after the arrow. If it climbs steadily day after day, you have a leak. If it is flat and only the peaks are high, you have a sizing problem instead.

**2. Compare two class histograms.** A class histogram is a table of what is in memory right now: one row per class, with how many objects of that class exist and how much memory they use together. For example, `com.shop.Product` with 1,200,000 objects using 90 MB. Take one, wait ten minutes under load, take another:

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

Open it in a heap analyzer, such as Eclipse Memory Analyzer (MAT). It does two things for you:

- It shows which objects take the most memory. In our example, that is the map and the thousands of products inside it.
- For any object, it shows **who is holding it**: the chain of references from a root, such as a `static` variable, down to that object. That chain is the answer, because it shows exactly what stops the collector from freeing it. In the static map example it starts at `ProductService.CACHE`.

MAT calls this feature "Path to GC Roots", meaning the path from the object back to a root. Once you know who holds the object, you know what to fix.

> [!WARNING]
> A heap dump contains everything in memory: passwords, tokens, personal data. Treat the file like a secret. Do not attach it to a public ticket or upload it to an online tool.

## Another option: weak references, with care

Start with something that surprises many beginners. Put an object in a normal map, then stop using it:

```java
Map<User, Session> sessions = new HashMap<>();

User user = new User("asha");
sessions.put(user, new Session());

user = null;   // you are done with this user
```

You might expect Java to free the `User` now, because your variable is `null`. It does not. **The map still points at it**, and a map's reference is a strong one, so the object stays alive. Setting your own variable to `null` removes only your reference. The map's reference is still there, and that is the leak.

A **weak reference** is a reference that does not count. If the only references left to an object are weak ones, the collector is allowed to free it.
`WeakHashMap` is a map that holds its **keys** weakly. Use it in the same example and the entry cleans itself up:

```java
Map<User, Session> sessions = new WeakHashMap<>();

User user = new User("asha");
sessions.put(user, new Session());

user = null;   // nothing else points at the User
// after the next garbage collection, the entry is gone from the map
```

The key point: the entry is removed only when **nothing else** points at the key. While other code still uses `user`, the entry stays.

It is useful, but there are two traps:

**1. The value points at the key.** The map holds the value strongly. If the value holds the key, the key stays alive through it, and the entry never goes away:

```java
sessions.put(user, new Session(user));   // the Session holds the user
```

**2. It is not a cache.** The entry disappears as soon as nothing else holds the key, which can be a few seconds after you add it. Use `WeakHashMap` only to attach extra data to an object that something else owns, so the data goes away together with that object.

## When the fix goes wrong

**Raising `-Xmx`.** It looks right because the crash said "out of memory". But a leak does not stop growing when you give it more room. In our example the heap grew about 750 MB a day, so doubling it from 4 GB to 8 GB only buys about five more days.

**What to do instead.** Treat a bigger heap as a short delay while you find what holds the memory, using a heap dump.

## Which should you use?

| Situation | Reach for |
|---|---|
| A map used as a cache | **A bounded cache** (Caffeine or an LRU map), with a size limit and often an expiry |
| Per-thread state on a thread pool | **`ThreadLocal` with `remove()` in `finally`,** or avoid it and pass values explicitly |
| Extra data attached to objects owned elsewhere | **`WeakHashMap`,** after checking values do not refer to the keys |
| You cannot find the leak | **A heap dump and "Path to GC Roots".** Do not guess |

If you are not sure where to start, start with the heap dump. It shows who is holding the memory in a few minutes, and guessing can take days.

A queue that grows without limit is a close cousin of this leak. It is the same slow death from a different source. So is a leaked database connection: [the connection pool post](/posts/connection-pool-exhausted/) shows the same pattern with connections instead of memory.

## The takeaway

1. The collector frees what **nothing can reach**. It does not know what you still need.
2. A Java leak is an unneeded object that something still **strongly references**.
3. Two usual suspects: **static maps** that only grow, and **`ThreadLocal`** values never removed on pooled threads.
4. The sign of a leak is the heap size **after each GC** rising over time, not a high peak.
5. Find it with a **class histogram** (what grows) and a **heap dump** (who holds it). Then fix the ownership, not the heap size.
