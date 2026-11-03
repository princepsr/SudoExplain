---
title: Java weak vs strong references: why WeakHashMap leaks
date: 2026-11-03
description: Strong, soft and weak references in Java explained, why a WeakHashMap cache can leak or empty itself, and what to use instead.
tags: java, jvm
draft: true
---

## The question

A colleague finds a memory leak in a static `HashMap` that is used as a cache. The fix in the pull request is one word: `HashMap` becomes `WeakHashMap`. "Weak means the garbage collector can clean it up," they say, and the review is approved.

In production one of two things happens. Either the cache stops helping, or the memory still climbs.

> If a weak reference lets the collector free an object, why didn't switching to WeakHashMap fix my cache?

The answer only makes sense after a few basics, so we start there. I won't assume you know any of the words. If the idea of a leak in Java is new to you, read [Java memory leak: strong references and heap dumps](/posts/java-memory-leak/) first.

> [!SUMMARY]
> By the end you will know:
>
> 1. The four kinds of reference in Java, and when the collector clears each one
> 2. The two ways a `WeakHashMap` "cache" goes wrong
> 3. How to **diagnose** each one
> 4. What to use instead, and when a weak reference is the right tool

## First, the basics

A **strong reference** is the normal kind: `Foo f = new Foo();`. As long as a strong reference points to an object, the garbage collector (GC), the part of the runtime that frees memory, keeps it.

A **weak reference** does not keep its object alive. Think of a library book. A strong reference is holding the book in your hand. A weak reference is a note that says "I saw this book on shelf 3". The note does not stop the library from removing the book. When it is gone, your note tells you so.

Java has four kinds in total:

| Kind | Class | The collector clears it when |
|---|---|---|
| Strong | a normal reference | never, while it can be reached |
| Soft | `SoftReference` | memory is getting short (it decides when) |
| Weak | `WeakReference` | the next collection, once only weak references reach the object |
| Phantom | `PhantomReference` | the object is already unreachable (used for cleanup) |

You can see a weak reference work in a few lines:

```java
Object data = new Object();
WeakReference<Object> ref = new WeakReference<>(data);

// Nothing strong points at the object now.
data = null;

// A request to collect; in a demo it usually does.
System.gc();
System.out.println(ref.get());   // usually prints null
```

`WeakHashMap` is a map built on this idea. Its **keys** are held weakly. When a key is collected, the entry is removed. Its **values** are held strongly, like in any map. That one difference causes both failures below.

## Failure 1: a weak cache that empties itself

Here is the "fixed" cache. The key is built from the report id:

```java
private static final Map<String, Report> CACHE =
        Collections.synchronizedMap(new WeakHashMap<>());

Report find(long id) {
    // A new String object on every call.
    String key = "report:" + id;
    return CACHE.computeIfAbsent(
            key, k -> loadFromDatabase(id));
}
```

Look at who holds the key. The method creates it, and when the method returns, nothing holds it any more. Only the map points to it, and that reference is weak. So the entry can be removed at the next collection.

In testing it looks perfect, because no collection happens during a short test. In production a young-generation collection, the frequent small one, may run every few seconds:

```text
Report requested every 30 seconds by each dashboard
A collection runs about every 5 seconds
Entry lifetime: at most 5 seconds

Result: almost every request is a cache miss.
```

The memory stops growing, so the leak seems fixed. But the cache now does nothing, and the database gets as much work as before.

## Failure 2: the value points back to the key

Now a cache that does keep its keys alive, but in the wrong way:

```java
Map<User, Session> sessions = new WeakHashMap<>();

// Session keeps a field that refers to its own user.
sessions.put(user, new Session(user));
```

The map holds the **value** strongly. The value holds the **key** strongly. So the key can be reached from the map, and a weak reference to an object that can still be reached strongly is never cleared. The entry stays forever, and you have the original leak again.

```diagram
type: flow
alt: A static map holds a value strongly, the value holds the key, so the key is never freed.
caption: Figure 1. The weak key is kept alive through its own value.
Root: static WeakHashMap -> Value (Session) held strongly -> Value points to the key -> Key stays reachable, entry is never removed !
```

Two more keys that are never cleared:

- **String literals** such as `"report"`. They stay alive as long as the class that contains them.
- **Small boxed numbers** such as `Integer` values from -128 to 127. Java reuses the same objects.

## How to diagnose it

**1. Measure the hit rate.** The hit rate is the share of lookups answered from the cache. Count hits and misses yourself, or use a cache library that reports it. A rate near zero, with database queries almost equal to requests, means entries vanish before they are used.

**2. Compare entry lifetime with collection frequency.** Turn on GC logging with `-Xlog:gc`. If a collection runs every few seconds and your entries are expected to live for minutes, a weak cache cannot work.

**3. For a leak that persists, take a heap dump.** The memory leak post shows how. Open it in Eclipse Memory Analyzer (MAT) and find the `WeakHashMap` in the dominator tree. Pick one key, run **Path to GC Roots**, and exclude weak and soft references. If a path remains and it goes through the map's value, then the value is holding its own key.

> [!WARNING]
> A heap dump contains everything in memory, including passwords and personal data. Keep the file private.

## Fix 1: use a real cache

If the data can be reloaded, you do not need weak references. You need a cache that decides what to drop. A library such as Caffeine does this with a size limit and a time limit:

```java
Cache<Long, Report> cache = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofMinutes(10))
        .recordStats()
        .build();

Report find(long id) {
    return cache.get(id, this::loadFromDatabase);
}
```

Entries now live for a time **you** choose, not for however long the next collection allows. `recordStats()` lets you read the hit rate that the diagnosis above asks for.

## Fix 2: use weak references only for what they are for

Weak references are right when you want to **attach extra data to an object that something else owns**. For example, a small piece of information about a connection, which should disappear when the connection does.

If you use `WeakHashMap`, follow four rules:

1. The key must be held strongly **somewhere else** for as long as the entry should live.
2. The value must **not** refer to the key.
3. Do not use string literals or small numbers as keys.
4. It is not thread-safe. Wrap it with `Collections.synchronizedMap`, as in the example above.

## When the fix goes wrong

**1. Using soft references as the cache.** A `SoftReference` is cleared only when memory is short, which sounds ideal for a cache: free memory when needed, keep data otherwise. The catch is the word "only". The heap sits nearly full, the collector works harder and harder, and when memory finally runs short it clears many entries at once. The database then receives all those misses in one burst. Caffeine's own documentation advises size-based eviction over reference-based eviction.

**What to do instead.** Give the cache a size limit chosen from your memory budget.

**2. Calling `System.gc()` to make weak entries clear on time.** It can start a full collection that pauses the whole application, and it is only a request. It also treats the symptom: the design still depends on collection timing.

**What to do instead.** Measure, then change the design so nothing depends on when the collector runs.

**3. Holding listeners weakly to avoid unregistering.** A forgotten listener keeps leaking, so keeping the list weak looks like a clean fix. Then someone registers a lambda directly:

```java
bus.register(event -> refresh());   // nothing else holds this lambda
```

No other variable points to the lambda, so it is collected at the next GC and the listener silently stops receiving events. It works in tests and fails in production.

**What to do instead.** Unregister when the owner closes, or keep the listener in a field of the owner so its lifetime is clear.

## Which should you use?

| Situation | Reach for |
|---|---|
| A cache of data you can reload | **A bounded cache** (Caffeine), with a size limit and expiry |
| Extra data attached to objects owned elsewhere | **`WeakHashMap`,** keeping the rules in Fix 2 |
| A cleanup action when an object is gone | **`Cleaner`,** not finalizers |
| Listeners that are never removed | **Unregister** when the owner closes |
| You are not sure | **A bounded cache,** and measure the hit rate |

If you are tempted to use weak or soft references to make a cache "manage itself", use a cache library instead. It is shorter and more predictable.

## The takeaway

1. A weak reference does not keep an object alive. It is cleared at the next collection once only weak references reach the object.
2. `WeakHashMap` holds its **keys** weakly and its **values** strongly.
3. A weak map **empties itself** if nothing else holds the key, and **leaks** if the value points back to the key.
4. For a cache, use a **bounded cache** with a size limit and expiry. Keep weak references for attaching data to objects someone else owns.
5. Check the **hit rate**. A cache with a hit rate near zero is a leak fix that broke the cache.
