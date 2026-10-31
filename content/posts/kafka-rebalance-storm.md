---
title: Kafka consumer rebalance storm: why processing stalls
date: 2026-11-01
description: Why a Kafka consumer group keeps rebalancing so lag grows and nobody makes progress, how to diagnose a rebalance storm, and how to stop it.
tags: kafka, messaging, reliability
draft: true
---

## The doubt

A team runs six consumer instances reading an `orders` topic. After a deploy, the dashboard shows lag climbing. All six instances are up, CPU is low, and the broker is healthy. Yet the topic is barely being read.

The logs show the same lines over and over: joining the group, getting partitions, losing them, joining again.

> Every consumer is alive and nothing is crashing. Why is no one making progress?

The group is stuck in a loop. It spends its time **rebalancing**, which means reshuffling who reads what, and while it reshuffles, nobody reads.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **rebalance** is, and why the classic protocol pauses the whole group
> 2. The four things that trigger one, including the slow-processing trap
> 3. How to **diagnose** a storm from logs and `kafka-consumer-groups.sh`
> 4. The fixes (smaller batches, sane timeouts, cooperative rebalancing, static membership) and how each can backfire

## First, topics, partitions and groups

Kafka is a log-based messaging system. A **topic** is a named stream of messages, such as `orders`. A topic is split into **partitions**, which are separate ordered logs, so that many readers can work at once. Each message in a partition has a position called an **offset**.

A **consumer group** is a set of consumer processes that share one job. Kafka gives each partition to exactly one consumer in the group. With six partitions and three consumers, each consumer gets two. Think of a team splitting a stack of mail bins: each bin has one owner at a time. The analogy stops at ordering: Kafka only guarantees order inside one partition.

The **lag** of a partition is how far the group's committed offset is behind the newest message. Growing lag means consumers are not keeping up.

## The failure: the group keeps reshuffling

Who owns which partition is decided by a **rebalance**. One broker acts as the group's **coordinator** and tracks the members. When membership changes, the group stops, agrees on a new assignment and resumes.

In the classic (**eager**) protocol, every consumer gives up all its partitions at the start of a rebalance. Nobody reads until the new assignment arrives. One rebalance is a short pause. A storm is one rebalance after another.

A rebalance is triggered in these cases:

- It **joins or leaves**, including every restart in a rolling deploy.
- It **misses heartbeats**. A heartbeat is a small "I am alive" message sent in the background. If the coordinator hears none within `session.timeout.ms`, it removes the member.
- It **polls too slowly**. A consumer must call `poll()`, the method that fetches the next batch, regularly. If more than `max.poll.interval.ms` passes between two calls, the client leaves the group itself.
- A partition count or subscription change.

The third case causes most storms. Heartbeats come from a background thread, so a consumer can heartbeat happily while its main thread is stuck on one slow message.

```diagram
type: sequence
alt: A consumer takes too long between polls, leaves the group, and a rebalance pauses all consumers.
caption: Figure 1. One slow batch makes a consumer leave, and the whole group pauses.
actors: Consumer A | Coordinator | Consumer B
Consumer A -> Coordinator: poll() returns 500 records
note Consumer A: processing takes 6 minutes !
Consumer A -x Coordinator: no poll() within the limit !
Coordinator -> Consumer B: rebalance: give up partitions
note all: nobody reads until the new assignment
Consumer A -> Coordinator: rejoin the group
```

When A finally calls `poll()` again, it finds it has been removed. It rejoins, which triggers another rebalance. The partitions A receives have uncommitted work, so the next batch is slow again. That is the loop.

The defaults, from the Kafka source for recent versions: `session.timeout.ms` is 45000 (45 seconds), `heartbeat.interval.ms` is 3000, `max.poll.interval.ms` is 300000 (5 minutes) and `max.poll.records` is 500. Older versions used different values, so check the documentation for your own version.

## How to diagnose it

**1. Read the consumer logs.** Look for repeated joins and the poll timeout warning. The Kafka client logs `(Re-)joining group` and `Successfully joined group with generation N`, and the generation number keeps climbing. The most useful line is this warning:

```text
consumer poll timeout has expired. This means the time between subsequent
calls to poll() was longer than the configured max.poll.interval.ms ...
```

If you see it, your processing time per batch exceeds the limit.

**2. Ask Kafka about the group.** Use the tool that ships with Kafka:

```bash
bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group orders-service
```

The output has one row per partition, with the columns `GROUP`, `TOPIC`, `PARTITION`, `CURRENT-OFFSET`, `LOG-END-OFFSET`, `LAG`, `CONSUMER-ID`, `HOST` and `CLIENT-ID`. During a rebalance the tool prints `Warning: Consumer group 'orders-service' is rebalancing.` and shows `-` in the consumer columns. Run it several times. If you see that warning often, you have a storm.

```bash
bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group orders-service --state
```

This shows the group state. A healthy group is `Stable`. A group that keeps appearing as `PreparingRebalance` or `CompletingRebalance` is stuck reshuffling.

**3. Read lag per partition.** Lag that grows on every partition suggests a group-wide pause. Lag on one partition suggests one slow or poisonous message.

**4. Correlate with events.** Did the storm start with a deploy, a scale-out or a new slow dependency? Rebalance timestamps in the log usually line up with one of them.

## Fix 1: make each poll cycle short

Fix the cause, not the limit. Lower `max.poll.records` so one batch finishes well inside `max.poll.interval.ms`:

```properties
max.poll.records=50
max.poll.interval.ms=300000
```

If one record takes 2 seconds, 500 records take over 16 minutes, far beyond the 5 minute limit. With 50 records, a batch takes about 100 seconds. Size the batch so a slow batch still fits with room to spare.

For work that is slow by nature, hand it to a worker pool and keep calling `poll()`. The consumer class has `pause()` and `resume()` for this, so polling continues without fetching new records. The cost is complexity: you must commit offsets only after the workers finish, or you may lose messages on a crash.

## Fix 2: tune the timeouts sensibly

`session.timeout.ms` decides how fast a dead consumer is noticed. `heartbeat.interval.ms` must be lower than it, and the Kafka documentation says it should typically be no higher than one third of it. Raise the session timeout only if brief pauses (garbage collection, a network blip) are causing false alarms. The [garbage collection post](/posts/java-gc-pauses/) explains what stop-the-world pauses are.

## Fix 3: cooperative rebalancing

The `CooperativeStickyAssignor` changes how the shuffle works. Instead of everyone dropping everything, consumers keep the partitions that are not moving. Only the partitions that change owner are revoked, in a second round. Processing continues on the rest.

```properties
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

In recent versions the default list is `RangeAssignor` then `CooperativeStickyAssignor`, and the group uses an assignor that every member supports, which with the default list is `RangeAssignor`. If you did not set the list explicitly, removing `RangeAssignor` in a rolling restart switches the group over. All members must support cooperative rebalancing before it takes effect. Check the upgrade notes for your version if you set the list explicitly.

The cost: a rebalance can now take two rounds, and the assignor does not fix slow polling. If a consumer still leaves every few minutes, you get many small pauses instead of one big one.

## Fix 4: static membership for rolling deploys

Normally a restarted consumer is a new member, so a deploy of six instances causes up to about twelve membership changes (a leave and a join per instance), each of which can trigger a rebalance. With **static membership**, each instance sets a fixed `group.instance.id`:

```properties
group.instance.id=orders-consumer-3
session.timeout.ms=60000
```

If an instance with that ID goes away and returns before the session timeout, it gets its old partitions back with no rebalance. The Kafka documentation describes pairing it with a larger session timeout for exactly this case. Only one live instance per ID is allowed in the group.

The cost: a really dead instance is noticed only after the session timeout, and its partitions sit idle until then.

> [!NOTE]
> Kafka 4.0 made a second group protocol generally available. It is chosen with `group.protocol=consumer`, and the default is still `classic`. It is designed to avoid group-wide pauses, but its settings differ: some timeouts move to broker settings. Read the documentation for your version before using it.

## When the fix goes wrong

- **Timeouts raised too far.** A `max.poll.interval.ms` of two hours hides a stuck consumer for two hours. Real failures are detected late.
- **Autoscaling on lag.** Lag rises, so the autoscaler adds consumers, which triggers a rebalance, which raises lag again. [The autoscaling post](/posts/autoscaling-too-late/) explains stabilization windows for the Kubernetes autoscaler. For scaling on lag, add a cooldown and a minimum replica count.
- **One slow message.** A single message that takes ten minutes makes one consumer miss its deadline and pauses everyone. Park such messages in a retry or dead letter topic, as in [the poison message post](/posts/poison-message-dead-letter-queue/).
- **Mixed assignors.** One old instance without cooperative support keeps the whole group on the eager protocol.
- **Duplicate processing.** After a rebalance, uncommitted messages are read again. Make handlers idempotent (safe to run twice).
- **Reused instance IDs.** Two live instances with one `group.instance.id` fence each other out.

## Which should you use?

| Symptom | Reach for |
|---|---|
| Poll timeout warning in logs | **Smaller `max.poll.records`**, or work off the poll thread |
| Storm only during deploys | **Static membership** |
| Long pauses on every membership change | **Cooperative sticky assignor** |
| Short pauses causing false alarms | **A larger session timeout**, within reason |
| Lag-based autoscaling | **A cooldown**, and a minimum replica count |

If you are not sure, start by measuring how long one batch takes, and make sure it is far below `max.poll.interval.ms`. Most storms end there.

## The takeaway

1. A **rebalance** reassigns partitions, and in the classic protocol it pauses every consumer in the group.
2. A **storm** is rebalances triggered again and again: restarts, missed heartbeats, or slow gaps between `poll()` calls.
3. Diagnose with the **poll timeout warning**, a rising generation number, and `kafka-consumer-groups.sh --describe`.
4. Fix the cause first: **smaller batches**. Then add **cooperative rebalancing** and **static membership** to soften the rest.
5. Raising timeouts hides failures, and autoscaling on lag can feed the storm. Change one thing at a time.
