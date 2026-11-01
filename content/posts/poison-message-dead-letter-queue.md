---
title: Poison message: how one bad message blocks a queue
date: 2026-11-01
description: How one malformed message can stop a whole queue consumer, how to spot it from lag and repeating errors, and how retries and dead-letter queues fix it.
tags: messaging, reliability, backend
draft: true
---

## The doubt

A service reads messages from a queue and processes them. It has run fine for months. One afternoon the queue starts growing. The consumer is up, its CPU is quiet, and nothing has crashed. But no new messages are being processed, and the logs show the **same error, over and over**, every few seconds.

> The consumer is running, so why has the queue stopped moving?

One message cannot be processed, and the consumer keeps trying to process it, forever.

Picture a conveyor belt with one box the worker cannot open. The worker refuses to put it down, so every box behind it waits.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **poison message** is and why one is enough to block everything behind it
> 2. How to **diagnose** it from consumer lag and a repeating error
> 3. How retries, backoff and a **dead-letter queue** fix it
> 4. Why a dead-letter queue nobody watches is just a slower way to lose data

## First, how a queue delivers messages

A **broker** is the server that stores the queue. A **consumer** is the program that reads messages from it. The consumer reads a message, processes it, and then **acknowledges** it, telling the broker "done, you can remove this".

If the consumer fails before acknowledging, the message is delivered again. This is called *at-least-once delivery*, and it is the normal setting because it never loses a message.

Brokers differ in how this works. In SQS, a message you have received is hidden for a **visibility timeout** (30 seconds by default). If you do not delete it in that time, it reappears. That is why the same error repeats every so often.

Kafka has no acknowledge call. Messages sit in **partitions** (ordered lanes), and the consumer remembers its place with an **offset**, a number saying how far it has read. "Acknowledging" means committing that offset. If processing fails, the committed offset does not move. After a restart or a rebalance, the consumer starts again from the last committed offset. Frameworks such as Spring Kafka also seek back to the failed record, so it is retried at once. Either way, the consumer cannot skip a failing record without losing it.

## The failure: a message that can never succeed

Most failures are temporary. The database was briefly down, so try again and it works. A **poison message** is different: it will fail **every** time, however often you retry. For example:

- a field is `null` where the code assumes a value
- a number is too large for the column
- an enum value arrived that this version of the code does not know about
- the JSON is malformed or does not match the expected shape

The consumer reads it, throws an exception, does not acknowledge, and the message comes back. The consumer fails again, and so on:

```text
14:02:01  ERROR processing order-8841: NullPointerException (customer.address)
14:02:03  ERROR processing order-8841: NullPointerException (customer.address)
14:02:05  ERROR processing order-8841: NullPointerException (customer.address)
...
```

```diagram
type: flow
alt: A consumer fails on one message, never acknowledges it, gets it again, and the messages behind it never move.
caption: Figure 1. The loop never reaches the next message.
Consumer reads the message -> Handler throws, no ack -> Same message comes back -> Messages behind it wait !
```

In an ordered queue, every message **behind** the poisoned one is stuck, because the consumer will not move past it. SQS FIFO queues are ordered within a message group, so the bad message blocks its group.

In an unordered queue, such as standard SQS, the bad message keeps returning and wastes capacity. A few of them can use up all your workers.

Kafka has a version that surprises people. If the message cannot even be **deserialized** (turned from bytes into an object), the failure happens while the consumer is fetching, before your handler or error handler runs. The consumer then fails on the same offset forever.

Spring for Kafka avoids this with `ErrorHandlingDeserializer`, a wrapper that turns the failure into a normal error the handler can route. With Spring Boot it looks like this:

```properties
spring.kafka.consumer.value-deserializer=org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
spring.kafka.consumer.properties.spring.deserializer.value.delegate.class=org.springframework.kafka.support.serializer.JsonDeserializer
```

## How to diagnose it

**1. Look at the lag.** Consumer lag is how far the consumer is behind the newest message. A lag that grows steadily while the consumer is healthy is the signature. In Kafka, `kafka-consumer-groups.sh --bootstrap-server <host:port> --describe --group <group>` shows lag per partition. If only **one partition** is stuck while the others drain, one record is blocking it, and its current offset does not move.

**2. Read the repeating error.** The same message ID, offset or payload appears in the logs again and again. That repetition is the key evidence.

**3. Look at the delivery count.** Queues track how many times a message has been delivered. SQS exposes `ApproximateReceiveCount`. A message delivered dozens of times is poisoned. The SQS metrics for the age of the oldest message and for messages in flight also point at it.

**4. Fetch the message and inspect it.** In Kafka, `kafka-console-consumer.sh` can read one record at a given partition and offset without running your handler. In SQS, the console's poll feature shows a message, but it raises the receive count. The problem is usually visible at once: a missing field, a surprise value, a broken encoding.

## Fix 1: stop retrying forever, and set the message aside

Limit the retries, wait between them, and after the last try move the message to a **dead-letter queue** (DLQ). A DLQ is a separate queue that holds messages which could not be processed, together with the reason. The main queue moves on.

```pseudocode
for attempt in 1..maxAttempts:          # for example 3 to 4 tries in total
    try:
        process(message)
        acknowledge(message)
        return
    catch error:
        wait(backoff(attempt))

send message + error details to dead-letter queue
if that send succeeded:
    acknowledge(message)         # only now remove it from the main queue
```

Never acknowledge before the dead-letter send succeeds. Otherwise a failed send loses the message.

Brokers have this built in. SQS has a **redrive policy** with a `maxReceiveCount`. In Spring for Kafka, an error handler does it:

```java
DefaultErrorHandler handler = new DefaultErrorHandler(
        new DeadLetterPublishingRecoverer(kafkaTemplate),     // publishes to <topic>-dlt (3.3 and later; older versions use <topic>.DLT)
        new FixedBackOff(1000L, 3));                          // retry 3 times, 1 second apart

factory.setCommonErrorHandler(handler);   // factory is your listener container factory
```

With this setting a record is tried four times in total: the first attempt plus three retries.

## Fix 2: do not retry what cannot succeed

Some errors are worth retrying, and some are not:

| Kind of error | Example | What to do |
|---|---|---|
| **Temporary** | Database timeout, network blip, 503 | Retry with backoff |
| **Permanent** | Missing field, bad format, unknown value | Go **straight to the DLQ**. Retrying wastes time |

Tell the framework which exceptions are permanent, so a validation error is not retried three times:

```java
handler.addNotRetryableExceptions(IllegalArgumentException.class);
```

```diagram
type: flow
alt: A message that keeps failing is moved to a dead-letter queue so the main queue continues.
caption: Figure 2. The dead-letter queue lets the main queue move on.
Message fails 3 times -> Copied to dead-letter queue -> Acknowledged on main queue -> Next message is processed
```

## Fix 3: be careful about what you accept

Prevent poison at the source. Check the shape of a message when it arrives, and reject bad ones early with a clear error. Be **tolerant of unknown fields and values**, so a producer adding a new field or enum value does not break an older consumer. Jackson, the common Java JSON library, has settings for ignoring unknown fields and mapping unknown enum values to null.

Many outages begin when a producer deploys a change before its consumers are ready.

## Fix 4: make the dead-letter queue useful

A DLQ is only a holding area. To make it a safety net:

- **Alert** when it is not empty, or when its depth grows.
- **Keep the error** with each message: the exception, the time, which consumer and which version.
- **Build a replay step.** After the bug is fixed, move the messages back to the main queue, so the work is not lost.
- **Check retention.** In standard SQS queues, the retention clock counts from when the message was first sent, so a message can expire from the DLQ sooner than you expect (FIFO queues reset it when the message moves). Give the DLQ a longer retention than the source queue. A DLQ for a FIFO queue must itself be FIFO.

## When the fix goes wrong

The first three are the ones that bring the problem back.

**1. A DLQ nobody watches.** Once the DLQ exists, it feels like the problem is solved. But a DLQ is a queue, and queues can have a **retention period**: how long the broker keeps a message before it deletes it. If nobody looks, the messages age out and the business data in them is gone, with no error.

AWS gives an example for SQS standard queues. A message spends 1 day in the source queue before it moves to the DLQ. The DLQ keeps messages for 4 days, counted from the original send time, so the message is deleted after 3 more days. Alert when the DLQ is not empty, give it a longer retention than the source queue, and make someone responsible for reading it.

**2. Replaying before fixing.** After an incident the natural step is to move every message from the DLQ back to the main queue. If the bug is still in the code, each message fails again, runs through all its retries, and lands in the DLQ again. You have rebuilt the loop, now on a bigger pile. Fix and deploy first. Replay a few messages and watch them succeed. Then replay the rest.

**3. Sleeping in the handler.** To wait between retries, some code simply pauses the thread (`Thread.sleep`). In Kafka, the consumer must call `poll()` regularly to show it is alive. If it does not within `max.poll.interval.ms`, which is 5 minutes by default, Kafka decides the consumer has failed. The group then does a **rebalance**: it takes the partitions away and gives them to other consumers.

Say the handler waits 1 minute, then 2, then 4 between retries. After the third wait it has paused 1 + 2 + 4 = 7 minutes, more than 5. The message is handed to another consumer and processed again, which causes duplicates. Instead, use non-blocking retries. The failed message goes to a retry topic and the consumer carries on with the next one. Spring for Kafka offers `@RetryableTopic` for this.

Shorter ones:

- **Retrying everything.** Treating permanent errors as temporary only delays reaching the DLQ and slows the queue.
- **Losing order.** A DLQ breaks strict ordering for that message. If order is essential, the consumer needs a different strategy, and some systems prefer to stop and alert.
- **No idempotency.** At-least-once delivery means a message can legitimately arrive twice, so handlers must tolerate duplicates, as in [the double charge post](/posts/idempotency-key-double-charge/).

Without a limit on how much waits, a stuck consumer also lets the queue grow until memory or disk runs out. [The unbounded queue post](/posts/unbounded-thread-pool-queue/) covers that side.

## Which should you use?

| Situation | Reach for |
|---|---|
| Unordered messages, occasional bad ones | **Max retries then a DLQ** (SQS redrive, or a Kafka dead-letter topic) |
| Errors that are clearly never going to pass | **Send straight to the DLQ,** skipping retries |
| Slow retries needed (minutes, not seconds) | **Retry topics or delay queues,** not sleeping |
| Strict ordering that must not skip | **Stop and alert,** then repair by hand |
| Producers change often | **Schema checks** and tolerant readers |

If you are not sure, give every consumer a retry limit and a DLQ, and put an alert on the DLQ. A consumer with unlimited retries is a consumer waiting to block.

## The takeaway

1. Queues redeliver anything not acknowledged, so a message that **always fails** is redelivered **forever**: a poison message.
2. In an ordered queue it **blocks everything behind it**. In others it burns capacity.
3. Diagnose with **growing lag**, the **same error repeating**, and a high delivery count.
4. Fix it with **limited retries with backoff**, then a **dead-letter queue**. Do not retry errors that cannot succeed.
5. The DLQ needs an **alert** and a **replay path**, or you have only moved the failure out of sight.
