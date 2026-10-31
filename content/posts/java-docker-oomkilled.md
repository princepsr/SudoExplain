---
title: Java OOMKilled in Docker: heap is fine, container dies
date: 2026-11-01
description: Java OOMKilled in Docker means the kernel killed the container (exit code 137) while the heap looked healthy. Here is how to find and fix it.
tags: java, docker, kubernetes
draft: true
---

## The doubt

A Java service in a container restarts every few hours. The heap graph is calm, sitting at 60% with no climb. The application log ends mid-sentence, with no stack trace and no `OutOfMemoryError`. Then the orchestrator reports this:

```text
Last State:   Terminated
  Reason:     OOMKilled
  Exit Code:  137
```

> The heap was never full, so why did something run out of memory?

Because the heap is only part of what a Java process uses. The container limit counts all of it, and the kernel enforces that limit without warning.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a Java process uses more memory than its heap
> 2. The difference between a Java `OutOfMemoryError` and a kernel kill
> 3. How to **diagnose** the kill with `kubectl`, `docker` and Native Memory Tracking
> 4. How to size the heap and the container so there is room for the rest

## First, three layers of memory

A **container** is a process (or group of processes) that the operating system isolates and limits. One limit you can set is **memory**. The Linux kernel enforces it with **cgroups** (control groups, the kernel feature that tracks and caps a group of processes). If the group goes over its limit and the kernel cannot free memory, its **OOM killer** (out-of-memory killer) ends a process with signal 9, SIGKILL. A process cannot catch that signal, so it cannot log anything. Exit code 137 is 128 plus 9.

Inside the container runs the **JVM** (Java Virtual Machine, the program that runs your Java code). It limits only its own heap, the area for objects. When the heap is full, the JVM throws `java.lang.OutOfMemoryError` and you get a stack trace.

So there are two different deaths. A Java `OutOfMemoryError` comes from the JVM and leaves evidence. An `OOMKilled` comes from the kernel and leaves almost none.

## The failure: everything outside the heap

The heap is the largest part of a JVM's memory, but not the only part:

- **Metaspace:** where class definitions live. It is not capped by default.
- **Thread stacks:** each thread gets its own stack. The default is typically 1 MB per thread on 64-bit Linux, and 200 threads reserve about 200 MB of address space. The memory actually used depends on how deep each stack grows, so 200 MB is the worst case.
- **Direct buffers:** memory allocated outside the heap, used by network and file code.
- **Code cache:** compiled machine code, which can reserve up to about 240 MB on a JDK 21 machine I checked.
- **GC structures:** bookkeeping the collector keeps, which can be tens of MB.

Here is an illustrative sum with invented numbers. The container limit is 1024 MB, and the heap was set to 75% (768 MB):

```diagram
type: flow
alt: A heap of 768 MB plus 520 MB of other JVM memory adds up to more than the 1024 MB container limit, so the kernel kills it.
caption: Figure 1. The heap graph shows only the first box. The kernel counts all of them.
Heap 768 MB (graph looks fine) -> Other JVM memory 520 MB -> Total 1288 MB, limit 1024 MB -> Kernel kills it, exit 137 !
```

The other memory adds up, in this invented worst case, as 120 MB metaspace, 200 MB stacks, 40 MB code cache, 100 MB direct buffers and 60 MB of GC structures. That is 520 MB. Add the 768 MB heap and you reach 1288 MB, which is 264 MB over the limit.

The default heap would not have caused this. Modern JVMs are **container-aware**: they read the cgroup limit instead of the host's memory. The default `-XX:MaxRAMPercentage` is 25, which I confirmed by printing the flags of a JDK 21 run. The trouble starts when someone raises it, or sets `-Xmx` to match the limit.

## How to diagnose it

**1. Confirm the kill.** In Kubernetes:

```bash
kubectl describe pod my-service-7d9f
kubectl get pod my-service-7d9f -o jsonpath='{.status.containerStatuses[*].lastState}'
```

Look for `Reason: OOMKilled` and `Exit Code: 137`. The Kubernetes documentation shows the same pair in its memory-limit example. For plain Docker:

```bash
docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' my-container
```

On the node, the kernel log also names the victim. `dmesg | grep -i "killed process"` shows it if you have access.

**2. Rule out a Java error.** Search the application log for `OutOfMemoryError`. Messages such as `Java heap space` or `Metaspace` mean the JVM failed on its own and this post does not apply. For a heap that only grows, read [the Java memory leak post](/posts/java-memory-leak/).

**3. Measure native memory.** Restart with **Native Memory Tracking** (NMT, a JVM feature that counts memory by category):

```bash
java -XX:NativeMemoryTracking=summary -jar app.jar
jcmd <pid> VM.native_memory summary
```

Oracle's documentation says NMT costs about 5 to 10 percent performance, so use it to investigate, not to run forever. This is trimmed real output from an idle test program, started with `-Xmx128m`:

```text
Total: reserved=1597559KB, committed=229575KB
-       Java Heap (reserved=131072KB, committed=131072KB)
-           Class (reserved=1048802KB, committed=1442KB)
-          Thread (reserved=20533KB, committed=905KB)
-            Code (reserved=247980KB, committed=7784KB)
-              GC (reserved=56476KB, committed=56476KB)
```

Compare **committed** (really in use) with your heap. Here the heap is 128 MB of a 224 MB total. Even an idle program carries almost as much outside the heap as inside it. Note that NMT does not count memory allocated by native libraries outside the JVM itself.

**4. Watch the trend.** Set a baseline with `jcmd <pid> VM.native_memory baseline`, then run `jcmd <pid> VM.native_memory summary.diff` later. The category that grows is your suspect.

## Fix 1: size the heap as a share, with headroom

Use a percentage of the container limit, and leave a large gap for the rest:

```bash
java -XX:MaxRAMPercentage=60 -jar app.jar
```

For a 1024 MB limit, 60% gives a 614 MB heap (1024 times 0.6, rounded). That leaves about 410 MB for metaspace, stacks and the rest. The right number depends on your NMT report. The cost is a smaller heap, which can mean more garbage collection, so watch pause times too.

## Fix 2: cap the pieces that grow

- **Threads:** set a maximum in your web server or executor, and lower the stack size with `-Xss` only if you know the code is shallow.
- **Direct memory:** it defaults to the same size as `-Xmx`, so a big heap allows just as much direct memory on top. Set a smaller `-XX:MaxDirectMemorySize`. An overrun then becomes a Java `OutOfMemoryError`, such as `Cannot reserve N bytes of direct buffer memory` on JDK 21 (older JDKs say `Direct buffer memory`), which is easier to debug than a silent kill.
- **Metaspace:** `-XX:MaxMetaspaceSize` does the same for classes. An overrun then throws `OutOfMemoryError: Metaspace`.

The cost: a cap that is too low causes a Java error. That is a better failure than a kill, because it comes with a stack trace.

## Fix 3: right-size the container

If the numbers say the process truly needs 1.3 GB, give it a limit above 1.3 GB. A limit is a budget, not a goal to be squeezed. Use the NMT total plus a margin, and set the heap percentage to match.

The cost is real memory on the node, so check that you are not just hiding a leak. A total that keeps climbing after warm-up needs a fix, not a bigger limit.

## When the fix goes wrong

- **Setting `-Xmx` equal to the container limit.** The heap alone can then fill the whole budget before any other memory is counted. Always leave headroom.
- **Raising `MaxRAMPercentage` to "use the memory we paid for".** The same trap, stated as a percentage. Values above about 75 leave little room on small containers.
- **Forgetting that sidecars use memory too.** A helper container in the same pod has its own limit and uses node memory. Check which container was killed, because `kubectl describe pod` lists each one.
- **Reading only the heap graph.** Add container memory (the working set the orchestrator reports) to the same dashboard.
- **Leaving NMT on forever.** It adds overhead. Turn it on to investigate, then off.
- **Fixing the wrong layer.** A growing heap needs [the memory leak post](/posts/java-memory-leak/). A restart loop after the kill is covered by [the CrashLoopBackOff post](/posts/crashloopbackoff/).

## Which should you use?

| Situation | Reach for |
|---|---|
| Kill right after someone raised heap settings | **Lower the percentage** |
| One category grows in NMT | **Cap that category** |
| Total is steady but above the limit | **Raise the container limit** |
| Total keeps climbing | **Find the leak** |
| Many threads | **Cap thread counts** |

If you are not sure, measure first. Run NMT for one day and compare the committed total with the container limit before you change anything.

## See it yourself

Run a small Java program in a container with a 256 MB limit and `-Xmx256m`. Allocate direct buffers in a loop with `ByteBuffer.allocateDirect`. Watch the container die with exit code 137 while the heap stays small.

> [!WARNING]
> Do this on your own machine only. A memory-limit test in a shared cluster can evict neighbors or trigger paging alerts.

## The takeaway

1. A Java process uses **more than its heap**: metaspace, stacks, direct buffers, code cache and GC data.
2. A Java `OutOfMemoryError` has a stack trace. A **kernel kill** (`Reason: OOMKilled`, exit code 137) has none.
3. The container limit counts **everything**, so the heap must be a share of it, not all of it.
4. Diagnose with `kubectl describe pod` and **Native Memory Tracking**.
5. Fix by **leaving headroom**, capping growing pieces, and sizing the container from measurements.
