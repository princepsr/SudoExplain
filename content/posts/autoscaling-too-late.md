---
title: "Autoscaling too late: why spikes still cause outages"
date: 2026-11-01
description: Why autoscaling too late still causes outages when traffic spikes, how the Kubernetes autoscaler timeline adds up to minutes, and how to fix it.
tags: scaling, kubernetes, performance
draft: true
---

## The question

Your service runs on Kubernetes with an autoscaler. A marketing email goes out at 09:00, traffic triples in a minute, and the dashboard shows the autoscaler doing its job: 4 instances become 10. (The default scale-up limit takes it from 4 to 8 first, then to 10 at the next evaluation, and this post treats it as one step to keep the arithmetic simple.)

But the error graph tells another story. Users saw timeouts from 09:01 to 09:05. By the time the new instances were serving traffic, the worst was over.

> "We have autoscaling. Why did the spike still take us down?"

Because autoscaling is **reactive**. It notices a change, decides, and then builds capacity, and each of those steps takes time. A spike does not wait for the new instances.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why every autoscaler lags, and how the delays add up to minutes
> 2. How the Kubernetes **Horizontal Pod Autoscaler** decides, with its formula and defaults
> 3. Why CPU is often the wrong signal, and what reacts earlier
> 4. Five fixes, and the traps that make autoscaling worse

## First, what an autoscaler does

An **instance** is one running copy of your application. In Kubernetes it is a **pod**. **Autoscaling** means a controller changes the number of instances based on a measurement, such as average CPU use.

Think of a restaurant that calls in extra waiters when the queue at the door gets long. The waiters need time to arrive, put on an apron and learn the tables. During that time the queue keeps growing.

The analogy stops at one point: your extra instances also depend on machine space, downloads and warm-up, which are steps a waiter does not have.

## The chain of delays

The Kubernetes **Horizontal Pod Autoscaler** (HPA) is the built-in controller that adds or removes pods. It works in steps, and each step has a delay:

1. **Metrics collection.** The metrics server collects usage numbers; its documentation says every 15 seconds.
2. **Evaluation.** The HPA checks the metrics on a sync period, which defaults to 15 seconds.
3. **Scheduling.** The new pod must be placed on a machine (**node**) with free room. If none has room, a new node must be created first.
4. **Image pull.** The node downloads the container image if it does not have it.
5. **Startup and warm-up.** The app boots. A Java app also needs time for class loading and the JIT compiler (the part of the JVM that speeds up hot code) to warm up.
6. **Readiness.** The pod only gets traffic after its **readiness probe** passes. See [the readiness post](/posts/readiness-vs-liveness-probes/).

Here is an invented timeline, in seconds, for a spike that begins at second 0:

| Step | With free room on a node | Needs a new node |
|---|---|---|
| Metrics and evaluation, roughly (15 + 15, more with sampling windows) | 30 | 30 |
| Scheduling | 5 | 180 |
| Image pull | 20 | 20 |
| Startup and warm-up | 40 | 40 |
| Readiness check | 10 | 10 |
| **Total** | **105** | **280** |

105 seconds is about 1 minute 45 seconds. 280 seconds is 4 minutes 40 seconds. The numbers are made up, but the shape is real: even the good case costs nearly two minutes, and the bad case costs almost five.

```diagram
type: flow
alt: A traffic spike is followed by metric delay, scheduling, startup and readiness before new instances help, while users see errors.
caption: Figure 1. Users feel the whole chain, not just the last step.
Traffic triples -> Metrics and HPA notice (30 s) -> Pod placed on a node (5 s) -> Image, startup, readiness (70 s) -> Users saw errors meanwhile !
```

## How the HPA decides

The Kubernetes documentation gives this formula:

```text
desiredReplicas = ceil[ currentReplicas * ( currentMetricValue / desiredMetricValue ) ]
```

`ceil` rounds up. Say 4 pods ran at 50% average CPU, with a target of 60%. Traffic triples, so CPU use jumps to about 150% of what each pod requested (utilization is measured against the pod's CPU **request**, so it can pass 100%).

```text
desiredReplicas = ceil[ 4 * (150 / 60) ] = ceil[ 4 * 2.5 ] = 10
```

That matches the 4-to-10 jump in the story. The HPA ignores changes within a **tolerance**, 10% by default, to avoid reacting to noise. For scaling up, it has no stabilization window by default, and it may add the larger of 4 pods or 100% of the current pods every 15 seconds.

For scaling down, the default stabilization window is 300 seconds. The controller takes the highest recommendation from that window, so scale-down is slow and gradual on purpose.

## Why CPU is often the wrong signal

CPU only rises after requests are already being processed. If requests wait in a queue, or each one waits on a slow database, CPU can stay flat while latency climbs. A service that is mostly waiting looks idle to the autoscaler right up to the moment it falls over.

Signals that react earlier include:

- **Requests in flight** per instance: the number being handled right now.
- **Queue length** or message backlog: work waiting to start.
- **Latency**, such as the 95th percentile (the time under which 95 of 100 requests finish).

The HPA can scale on custom and external metrics through an adapter that exposes them to Kubernetes. This takes more setup than CPU.

## How to diagnose it

**1. Line up three timelines.** On one graph, plot request rate, error rate and replica count. If errors start before the replica count rises, you are late. If they continue after it rises, the new pods were not useful yet.

**2. Read the HPA's own view.**

```bash
kubectl describe hpa orders
kubectl get hpa orders --watch
```

The events show scaling decisions and their reasons, for example a `SuccessfulRescale` event reading "New size: 10; reason: cpu resource utilization (percentage of request) above target". Compare their timestamps with the first errors.

**3. Time a new pod.** Look at the pod's events: `Scheduled`, `Pulling`, `Pulled`, `Started`. The gaps show how long each step took. Then compare the `Started` time with when the pod first turned ready.

**4. Check what the autoscaler could not do.** Events such as `FailedScheduling` mean pods were waiting for room.

## Fix 1: keep headroom with a lower target

**What it is:** set the target below the level where you would be in trouble.

**How it works:** with a 50% CPU target, load can double before the instances hit 100% of their request. A 70% target leaves much less margin.

```yaml
metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
```

**What it costs:** more instances run at normal times, so a higher bill.

## Fix 2: scale on a better signal

**What it is:** use queue length, requests in flight or latency instead of CPU.

**How it works:** these rise first. Pick one that is proportional to load, and set the target from a load test, not a guess.

**What it costs:** an adapter or an extra tool to supply the metric, and more things to monitor.

## Fix 3: raise the minimum, or scale on a schedule

**What it is:** `minReplicas` is the floor the autoscaler never goes below. Raising it means a spike lands on capacity that already exists.

**How it works:** for known peaks, such as a daily email or a sale, raise the minimum ahead of time. The core HPA has no clock, so use a scheduled job that changes `minReplicas`, or a tool such as KEDA, which offers a cron-based scaler.

**What it costs:** paying for idle instances, and someone must remember to update the schedule.

## Fix 4: start faster

**What it is:** shrink steps 3 to 6 in the timeline.

**How it works:** use a smaller image, keep it cached on nodes, trim startup work, and warm caches in the background. A **startup probe** and a tuned readiness probe stop you from waiting longer than needed.

**What it costs:** engineering time, but it improves every deploy, not only scaling.

## Fix 5: protect the system while capacity arrives

**What it is:** shed load, which means refusing some requests on purpose, so the rest succeed.

**How it works:** a rate limiter returns a quick "try again later" instead of letting every request queue. See [the rate limiting post](/posts/rate-limiting-token-bucket/). A circuit breaker stops calls to a struggling dependency; see [the cascading failures post](/posts/cascading-failures-circuit-breaker/).

**What it costs:** some users see a refusal, but a quick refusal is better than a long timeout for everyone.

## When the fix goes wrong

Autoscaling can add pods and still make things worse. These three are the easiest to miss.

**1. The database becomes the bottleneck.** More pods looks like more room. But every pod brings its own pool of database connections (a pool is a fixed set of connections that the pod keeps open and reuses). Say each pod has 20. Four pods use 4 x 20 = 80 connections, which fits under a database limit of 100. Now the autoscaler jumps to 10 pods, and 10 x 20 = 200 connections are wanted. The database refuses the extra ones, and the new pods start failing too.

Work backwards from the database instead. Keep room for admin tools, say 20, which leaves 80. With `maxReplicas` at 10, each pod can have 80 / 10 = 8 connections. Set the pool size and `maxReplicas` together. [The connection pool post](/posts/connection-pool-exhausted/) shows this sum in more detail.

**2. Flapping.** Flapping means the autoscaler keeps adding and removing pods in a loop. Say traffic comes in waves 4 minutes apart. Each wave needs 10 pods, and between waves 4 are enough. If you shorten the scale-down window to 0 (the `behavior.scaleDown.stabilizationWindowSeconds` setting), the HPA removes pods soon after each wave. The next wave then finds 4 pods, and the whole delay chain starts again, 105 seconds or more in the timeline above. Users get the slow start every 4 minutes.

With the default 300-second window, the HPA uses the highest recommendation from the last 300 seconds. The waves are only 240 seconds apart, so it never sees a quiet window and keeps 10 pods. You pay for 6 extra pods for a few minutes, which is cheaper than the errors. Make the window longer than the gap between waves.

**3. Missing CPU requests.** A CPU request is the amount of CPU a container asks Kubernetes to reserve for it. "Percent of CPU" in the HPA means percent of that request. If a container has no request, the Kubernetes documentation says utilization is not defined and the autoscaler takes no action for that metric. The docs say this applies if *some* containers in the pod lack a request, so a sidecar (a helper container in the same pod) can switch off scaling for the whole pod.

Nothing fails loudly. The pod count stays at 4 through the whole spike. The target column in `kubectl get hpa` usually shows `<unknown>`, which is the clue. Set a CPU request on every container in the pod.

Smaller traps:

- **A metric that stays flat until too late.** If CPU does not move until the app is already overloaded, scaling on it is scaling on the damage.
- **New pods that never become ready.** A pod that fails its readiness probe adds no capacity, yet you still pay for it. Test your startup under load.
- **A max replica count that is too low.** The HPA stops at `maxReplicas`, however high the load.

## Which should you use?

| Situation | Reach for |
|---|---|
| Spikes you can predict | Scheduled minimum or a cron-based scaler |
| Spikes you cannot predict | Lower target, better metric, higher minimum |
| Slow scale-up even with room | Faster startup and a smaller image |
| Spike beyond any capacity | Rate limiting and load shedding |
| Pods ready but errors persist | Check the database and its connection limits |

If you are not sure, measure the full timeline of one new pod first. You cannot fix a delay you have not measured.

## The takeaway

1. Autoscaling is **reactive**: it measures, decides, then builds capacity, and the spike arrives first.
2. The delays add up: 30 seconds to notice plus scheduling, image pull, startup and readiness reach **minutes**.
3. The HPA computes `ceil[currentReplicas * current / desired]`, evaluates every **15 seconds**, and waits **300 seconds** before scaling down.
4. **CPU** reacts late. Queue length, requests in flight and latency react earlier.
5. Keep **headroom**, raise the minimum before known peaks, start faster, and shed load while capacity arrives.
