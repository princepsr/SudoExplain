---
title: Transactional outbox: fix the dual write problem
date: 2026-11-01
description: Why saving to a database and publishing an event can disagree, and how the transactional outbox pattern fixes the dual write problem step by step.
tags: distributed-systems, messaging, databases
draft: true
---

## The question

A service saves a new order in its database, then publishes an `OrderPlaced` event so the shipping service can react. It works for months. Then one evening the service is restarted at the wrong moment. The order is in the database. The event was never sent. Shipping never hears about it, and a customer waits for a package that nobody packs.

Nothing crashed in a visible way, and no error reached a user. The two systems simply disagree.

> The save succeeded and the publish failed. How do I make both happen, or neither?

Most message brokers, Kafka among them, cannot join a database transaction, so two separate systems cannot be made to commit together with a simple trick. But you can change the problem so that only **one** system has to commit.

> [!SUMMARY]
> By the end you will know:
>
> 1. What the **dual write problem** is, and what can go wrong in each order
> 2. How the **outbox pattern** turns two writes into one local transaction
> 3. How a **relay** publishes outbox rows, by polling or by change data capture
> 4. Why consumers must be **idempotent**, and the traps that make an outbox lose or flood events

## First, a database transaction

A **transaction** groups several changes so that they all succeed or all fail. If the process dies halfway, the database undoes the partial work. This guarantee covers **one database**. It does not reach a message broker, which is a separate server that passes messages between services, such as Kafka or RabbitMQ.

Think of posting a letter and updating your diary. You do two things, and nothing ties them together. If you are interrupted between them, the diary and the mailbox disagree. The analogy stops at repair: software can make the second step retry safely, as this post shows.

## The failure: two writes, no shared commit

Writing to the database and then to the broker is a **dual write**. Look at each order:

| Order | What can go wrong | Result |
|---|---|---|
| Save, then publish | The publish fails, or the process dies after the commit | Order exists, **event lost** |
| Publish, then save | The save fails after the event went out | Event exists, **no order** (a ghost event) |
| Publish inside the open transaction | The commit fails after publish | Same ghost event |
| Retry the publish in a loop | The process dies during the loop | Event lost, and a retry can duplicate it |

There is no safe order. The gap between the two writes is the problem, and a crash, a network error or a deploy can land in it.

```diagram
type: sequence
alt: A service commits an order to the database, then crashes before publishing the event, so the event is lost.
caption: Figure 1. The commit succeeds, the process dies, and the event is never sent.
actors: Service | Database | Broker
Service -> Database: INSERT order 501, COMMIT
Database --> Service: committed
note Service: process crashes here !
Service -x Broker: OrderPlaced never sent !
note all: shipping never hears about order 501
```

## The idea: write the event to your own database first

The **transactional outbox** keeps the event in the **same database** as the data. You add a table, usually called `outbox`, and insert the event into it inside the same transaction as the order:

```sql
BEGIN;
INSERT INTO orders (id, customer_id, total_cents) VALUES (501, 42, 1999);
INSERT INTO outbox (id, aggregate_id, type, payload)
VALUES ('a1b2c3', '501', 'OrderPlaced', '{"orderId":501,"totalCents":1999}');
COMMIT;
```

Now the database guarantees both rows exist or neither does. A second component, the **relay**, reads unpublished outbox rows and sends them to the broker. If the relay crashes, the rows are still there, and it resumes later.

```diagram
type: flow
alt: The service writes the order and the outbox row in one transaction, and a relay publishes the row to the broker.
caption: Figure 2. Only the local database must commit. The relay does the risky step later.
Order + outbox row in one transaction -> Relay reads new rows -> Relay publishes to broker -> Row marked as sent
```

The risky network call has moved out of the request. A broker outage no longer fails the order. Events just wait in the table.

## Relay option 1: a polling publisher

The simplest relay is a loop that asks for unsent rows. With several relay instances, you need each row claimed by only one. PostgreSQL has `FOR UPDATE SKIP LOCKED` for this. It locks the rows it returns, and other transactions skip rows that are already locked.

```sql
BEGIN;
SELECT id, aggregate_id, type, payload
  FROM outbox
 WHERE published_at IS NULL
 ORDER BY created_at, id
 LIMIT 100
   FOR UPDATE SKIP LOCKED;
-- publish each row to the broker and WAIT for the broker's confirmation
UPDATE outbox SET published_at = now() WHERE id IN ('a1b2c3', ...);
COMMIT;
```

The SQL is illustrative. The PostgreSQL documentation says skipping locked rows gives an inconsistent view of the data, so it suits queue-like tables like this one, but not general queries. MySQL 8.0 and later also support `SKIP LOCKED`. The cost of polling is delay (up to one polling interval) and constant light load on the database.

## Relay option 2: change data capture

**Change data capture (CDC)** reads the database's own change log instead of querying the table. Debezium is a widely used CDC tool. For PostgreSQL it uses logical decoding, which extracts committed changes from the write-ahead log (the file where the database records every change before applying it). It reads that stream through a replication slot and, after a restart, resumes from the last recorded log position. Debezium also ships an outbox event router that turns outbox inserts into broker messages, routed by an `aggregatetype` column by default. The column names are configurable, so map your own columns in the connector settings.

CDC gives low delay and no polling load. It costs more to run: a connector service, a Kafka Connect cluster in the common setup, and a replication slot that holds back log cleanup if the connector stops. Monitor the slot, or the log files it retains can fill the database disk. [The disk full post](/posts/disk-full-outage/) shows how to diagnose a full disk in general.

## At-least-once means duplicates

Both relays can fail between "broker accepted the message" and "row marked as sent". On restart, the relay sends the row again. So an outbox gives **at-least-once delivery**: every event arrives, and some arrive twice.

Do not try to hide this in the relay. Make consumers **idempotent**, meaning that handling the same event twice has the same effect as handling it once. The usual method is to store the event `id` and skip IDs already seen. The [idempotency post](/posts/idempotency-key-double-charge/) shows the technique.

## How to diagnose it

**1. Look for missing events.** Compare counts: orders created in the last hour against `OrderPlaced` events seen downstream. A gap means events are lost or stuck.

**2. Check the backlog.** Unpublished rows should be near zero:

```sql
SELECT count(*), min(created_at) AS oldest
  FROM outbox
 WHERE published_at IS NULL;
```

A growing count, or an old `oldest` value, means the relay is stuck or too slow. That age is your relay lag. Alert on it.

**3. Watch for duplicates.** If consumers log the same event `id` twice, the relay is retrying. A few are normal. A flood means the relay keeps failing before it marks rows.

**4. Check the table size.** A table that only grows slows every scan.

## Ordering and cleanup

Events for one order should arrive in order: created, paid, shipped. Use the aggregate ID (here, the order ID) as the broker message key, so Kafka puts one order's events in one partition. Order across different orders is rarely needed.

With several polling relays, two instances may take consecutive events of the same order and publish them in the wrong order. Either run one relay, or split the work by aggregate ID so one aggregate always goes to one instance.

Avoid a relay that remembers "the last ID I saw". Sequence IDs are handed out before commit, so a lower ID can become visible after a higher one, and the relay would skip it forever. The `published_at IS NULL` check above does not have this problem.

For cleanup, delete or archive rows a safe time after they are published, in small batches, and keep an index on the unpublished rows.

## When the fix goes wrong

An outbox only helps if the relay is careful. Two relay mistakes cause most real losses.

**1. Marking rows as sent before the broker confirms.** It looks harmless. The relay sets `published_at`, then publishes, and the code reads in a natural order. The trap is that "marked" now means "I will try", not "it arrived".

Say the relay marks order 501's row, and then the broker is down, or the relay crashes. The row says it was sent. The relay never looks at it again, and the event is gone for good. This is the original problem again, now hidden inside your own table.

A second form is quieter. Many broker clients send in the background. In Kafka's Java client, `send()` adds the message to a buffer and returns at once with a `Future`. A call that returns without an error only means "queued", not "the broker has it". So the relay must **wait** for the acknowledgement, by waiting on that `Future` or by using the callback, and only then mark the row. If a crash lands between the acknowledgement and the mark, the row is sent twice. That is fine, because consumers are idempotent. A duplicate is cheap, and a lost event is not.

**2. A poison row.** A **poison row** is one the broker will always refuse, for example a payload over the size limit. The relay takes the next 100 unsent rows in order. If row 3 fails and the code gives up on the whole batch, the same 100 rows come back on the next loop, and row 3 fails again. Rows 4 to 100 never go out, and every new event queues behind them. One bad row has stopped the pipeline.

Add an `attempts` column and count each failure. After a set number, such as 5, move the row aside by marking it failed, so the relay skips it. Then raise an alert so a person looks at it. [The dead letter queue post](/posts/poison-message-dead-letter-queue/) covers this idea. One caution: if you set a row aside, later events for the **same order** should wait too, or they will arrive without the earlier one.

Smaller traps, in short:

- **Deleting rows too early.** Deleting at publish time removes your only evidence when a consumer says it never got the event. Keep rows for a retention period.
- **An unbounded table.** Without cleanup, the outbox grows until queries slow down.
- **Writing the event outside the transaction.** If the code inserts the outbox row on a different connection, you have a dual write again.
- **Treating one outbox as a whole workflow.** The outbox delivers events. It does not undo earlier steps when a later one fails. For multi-step processes, see [the saga post](/posts/saga-pattern/).

## Which should you use?

| Situation | Reach for |
|---|---|
| Small system, modest volume | **A polling publisher** with `SKIP LOCKED` |
| High volume or low delay needed | **CDC** such as Debezium, with slot monitoring |
| Consumers may see repeats | **Idempotent consumers**, always |
| Strict order per entity | **Aggregate ID as the message key** |
| Table keeps growing | **Scheduled cleanup** after a retention period |

If you are not sure, start with polling. It is easy to read, easy to debug, and you can move to CDC when the delay or load becomes a problem.

## The takeaway

1. **Dual writes** to a database and a broker cannot be made atomic, because most brokers cannot join a database transaction. A crash between them loses the event or creates a ghost.
2. The **outbox pattern** inserts the event into a table in the same transaction as the data.
3. A **relay** publishes outbox rows later, by polling (`FOR UPDATE SKIP LOCKED`) or by reading the change log.
4. Delivery is **at-least-once**, so consumers must be **idempotent**.
5. Watch for **piling rows**, relay lag and poison rows, mark rows sent only after the broker confirms, and clean up on a schedule.
