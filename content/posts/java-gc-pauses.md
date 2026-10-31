---
title: Java GC pauses: why latency spikes and how to find them
date: 2026-11-01
description: Java GC pauses make p99 latency spike every few minutes. Learn what a stop-the-world pause is, how to read GC logs, and how to fix it.
tags: java, jvm, performance
draft: true
---

## The doubt

The dashboard for a Java service looks fine. Average latency is 40 ms, CPU is low, and errors are rare. But the 99th-percentile latency, called **p99** (the time that 99 out of 100 requests beat), jumps to two seconds every few minutes. Then it drops again as if nothing happened.

Nothing in the logs explains it. The database is quiet. The spikes are regular, which is the clue.

> Why does a healthy service freeze for a second at a time, and how do I prove it is the garbage collector?

The answer is almost always a **garbage collection pause**. This post shows how to confirm that in ten minutes and what to do about it.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a stop-the-world pause is, and why it hits every request at once
> 2. How to read a GC log and match pauses to your latency spikes
> 3. The usual causes: small heap, allocation bursts, huge objects, leaks, CPU throttling
> 4. Which fix to try first, and why you should measure before you tune

## First, what the collector does

Java frees memory for you. The part of the JVM (the Java Virtual Machine, the program that runs your code) that does this is the **garbage collector**, or GC. It finds objects nothing refers to anymore and reclaims their space.

Most objects die young, such as a request object that lives for 20 ms. So the JVM splits its **heap** (the memory area for objects) into a **young generation** for new objects and an **old generation** for survivors. Cleaning the young generation is cheap and frequent. Cleaning the old generation is rarer and costs more.

To move objects safely, the collector sometimes has to freeze your application threads. That freeze is a **stop-the-world pause**. Think of a road crew closing a street to repaint the lines: everyone waits, whatever their destination. A request that arrives mid-pause simply waits.

On a modern JDK the default collector is **G1** (Garbage-First) on server-class machines, meaning at least 2 CPUs and about 1.8 GB of memory. In a container limited to 1 CPU or little memory, the JVM picks the simpler Serial collector instead. Check which one you have with `java -Xlog:gc -version`. It aims for a **pause-time goal** of 200 ms by default, set by `-XX:MaxGCPauseMillis`. I confirmed this default by printing the flags of a JDK 21 run. The goal is a target, not a promise. Oracle's documentation says G1 meets it "with high probability", not always.

## The failure: a pause lands on live traffic

Here is one spike, drawn out. A request is in flight when the heap fills and the collector needs to stop the application:

```diagram
type: sequence
alt: A request arrives while the garbage collector has stopped all application threads, so it waits.
caption: Figure 1. The request did nothing wrong. It arrived during the pause, so its latency includes the rest of the pause.
actors: Client | App threads | GC
Client -> App threads: request A (fast)
GC -> App threads: stop all threads
Client -> App threads: request B arrives
note App threads: frozen, request B waits !
GC --> App threads: done, resume
App threads --> Client: reply B (1.8 s) !
```

Every request in flight, and every request that arrives during the pause, waits until the pause ends. That is why GC pauses show up as a spike across **all** endpoints at once, even endpoints that do almost no work. The average hides it because most requests are still fast.

## What usually causes long or frequent pauses

- **A heap that is too small.** The young generation fills quickly, so collections run constantly. Each pause is short, but together they steal a large share of your time.
- **Allocation spikes.** A batch job or a large response can create objects faster than the collector clears them.
- **Very large objects.** In G1, an object that is half a region or larger (a fixed-size chunk of the heap) is called **humongous**. It needs contiguous space and is awkward to reclaim.
- **A leak.** Objects that never die fill the old generation until the collector works harder and harder. See [the Java memory leak post](/posts/java-memory-leak/).
- **CPU throttling in a container.** If the container has a small CPU limit, the kernel pauses the collector's own threads too. A pause that takes 50 ms on a laptop can take far longer.

## How to diagnose it

**1. Turn on GC logging.** It is cheap enough to leave on in production. Add this flag and restart:

```bash
java -Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=5,filesize=20m -jar app.jar
```

`-Xlog` is the JVM's unified logging switch. `gc*` means every message tagged `gc`. The text after the second colon chooses the timestamps and file rotation.

**2. Read the pause lines.** This is real output from a test program. It ran with a 64 MB heap and `-Xlog:gc`:

```text
[1.079s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 22M->3M(64M) 11.170ms
[1.097s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 33M->3M(64M) 9.208ms
[1.104s][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 40M->4M(64M) 2.130ms
[1.113s][info][gc] GC(3) Pause Young (Normal) (G1 Evacuation Pause) 40M->4M(64M) 1.533ms
```

Read `40M->4M(64M)` as: heap used before the pause, heap used after, and total heap size. The last number is the pause length. Here the collector ran about every 9 ms, with pauses near 1.5 ms. That is roughly a sixth of all time spent paused, which is what a too-small heap looks like.

Now look for lines such as these (illustrative, not from a real run):

```text
[612.4s][info][gc] GC(87) Pause Full (G1 Compaction Pause) 3900M->3700M(4096M) 2210.512ms
```

A **Full GC** collects the whole heap while everything is stopped. If the heap barely shrinks (3900M to 3700M) and the pause is seconds long, the old generation is nearly full of live data.

**3. Line up the timestamps.** Put the slow-request times next to the pause times. If they match, you have your culprit. If they do not, it is not the GC, and tuning it will waste your week.

**4. Check for throttling.** In a container, read the CPU statistics file. On cgroup v2 it is `/sys/fs/cgroup/cpu.stat`. A rising `nr_throttled` count means the kernel is pausing your processes to enforce the CPU limit.

**5. Watch it live.** `jstat -gcutil <pid> 1000` prints generation usage and collection counts every second.

## Fix 1: right-size the heap

If pauses are frequent but short, the heap is too small for your allocation rate. Give the JVM more room with `-Xmx` (maximum heap), or in a container with `-XX:MaxRAMPercentage`. A larger young generation means fewer collections.

The cost is memory. A bigger heap does not fix a leak, and an oversized heap can starve everything else on the machine (see the traps below).

## Fix 2: allocate less

The cheapest garbage is garbage you never create. Look at what your hot paths allocate: building big strings in loops, copying large lists per request, loading a whole result set into memory when you only need a page.

A profiler with an allocation view, such as JDK Flight Recorder (a recorder built into the JDK), shows which lines create the most objects. The cost is developer time, but the effect lasts. It also fixes the cause of humongous objects: stream or page large data instead of building one big array.

## Fix 3: fix the leak

If the old generation fills up and never drains, no setting helps. The collector is working correctly, because the objects are still reachable. Take a heap dump and find what holds them, as described in [the Java memory leak post](/posts/java-memory-leak/).

## Fix 4: try a low-pause collector

**ZGC** is a collector built for very short pauses. The JDK's own proposal for generational ZGC (JEP 439) says its pauses are typically shorter than a millisecond and independent of heap size, at the cost of some throughput.

In JDK 21 you enable the generational version with `-XX:+UseZGC -XX:+ZGenerational`. **Generational** means it keeps young and old objects apart, like G1 does, so short-lived garbage is cleaned cheaply. From JDK 23, `-XX:+UseZGC` alone uses the generational mode (JEP 474). JDK 24 removed the old non-generational mode (JEP 490).

The cost: ZGC can use more CPU and memory than G1 for the same work, and it does not remove the need to fix allocation or leaks. Test it with your real traffic before switching.

## When the fix goes wrong

- **Copying a flag list from the internet.** Flags tuned for another JDK version, heap size or workload can make things worse. Some no longer exist and are ignored or rejected.
- **Tuning before measuring.** Without a log that shows the pause, you are guessing. Change one thing at a time and compare logs.
- **Giving the heap all the memory.** The JVM also needs memory outside the heap, and the operating system needs some too. In a container this ends with a kill, as in [the OOMKilled post](/posts/java-docker-oomkilled/).
- **Setting an aggressive pause goal.** A very small `MaxGCPauseMillis` makes G1 collect more often to stay under it, which can reduce throughput.
- **Blaming the GC for slow code.** A slow database call also makes a latency spike. Match timestamps first.

## Which should you use?

| What the log shows | Try first |
|---|---|
| Many short pauses, heap always near full | **Bigger heap** |
| Pauses follow batch jobs or big responses | **Allocate less,** page the data |
| Full GCs, heap never shrinks | **Fix the leak** |
| Long pauses, healthy heap, small CPU limit | **Raise the CPU limit** |
| Pauses still too long after the above | **Test ZGC** |

If you are not sure, enable GC logging, wait for one spike, and match its timestamp to a pause line. That one step tells you whether the GC is even involved.

## See it yourself

Save a small program that allocates in a loop, then run it with `-Xmx64m -Xlog:gc`. Shrink the heap to `-Xmx32m` and watch the pauses become more frequent.

> [!WARNING]
> Run this on your own machine only. Do not add stress flags such as a tiny heap to a shared or production service.

## The takeaway

1. A **stop-the-world pause** freezes every application thread, so one pause delays all requests at once.
2. A p99 spike that repeats on a regular schedule is a strong hint of **GC pauses**.
3. Turn on **`-Xlog:gc*`**, read the pause lengths, and match their timestamps to slow requests.
4. Fix in this order: **right-size the heap, allocate less, fix leaks**, then consider ZGC.
5. **Measure before you tune,** and change one setting at a time.
