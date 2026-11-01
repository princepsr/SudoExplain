---
title: Saga pattern: when step 3 of 4 fails across services
date: 2026-11-01
description: What happens when an action spanning several services fails halfway, why you cannot just roll back, and how sagas and compensating actions restore consistency.
tags: system-design, microservices, reliability
draft: true
---

## The doubt

Placing an order touches four services, each with its own database: **inventory** reserves the stock, **payment** charges the card, **shipping** creates the delivery, and **notifications** sends the confirmation.

One day the payment succeeds and the shipping service rejects the address. The customer has been charged, there is no delivery, the stock is reserved for nobody, and the order sits in a half-finished state.

> In a normal database I would just roll the transaction back. Why can't I here?

Because there is no single transaction. Four services have four databases, and none of them can undo what another one did.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a database transaction does not stretch across services
> 2. What a **saga** is: local steps, each with a **compensating action**
> 3. How to **diagnose** half-finished actions in a running system
> 4. How to make sagas safe against crashes, retries and failed compensations

## First, the transaction you cannot have

Inside one database, a transaction makes several changes **all succeed or all fail**. If step 3 fails, the database undoes steps 1 and 2 as if they never happened.

That guarantee stops at the edge of one database. A distributed protocol called **two-phase commit** can coordinate several databases. But it holds locks on all of them while waiting, and it fails badly if the coordinator crashes. Many services and cloud APIs, such as a card processor, do not support it at all. In practice, services call each other and each commits on its own.

So when step 3 fails, steps 1 and 2 are **already committed**, and nobody is able to roll them back.

## The failure: a half-finished world

Think of booking a holiday with separate companies for the flight, the hotel and the car. If the car company says no, nobody cancels the flight for you. You have to call each company and undo your own bookings, in order.

```diagram
type: flow
alt: Stock is reserved, the card is charged, then the delivery is rejected, leaving a charged customer with no order.
caption: Figure 1. Steps 1 and 2 are already committed when step 3 fails, so the world is left half finished.
Stock reserved -> Card charged -> Delivery rejected -> Charged, no order, stock held !
```

It gets worse with crashes. If the service coordinating the steps crashes **between** step 2 and 3, nothing is left that knows the order was half done. No error is raised, because nothing ran to raise one.

## The idea: a saga

A **saga** replaces one big transaction with a **sequence of small local transactions**. Every step that can be undone gets a matching **compensating action**, a new step that reverses its effect:

| Step | Compensation |
|---|---|
| Reserve stock | Release the stock |
| Charge the card | Refund the card |
| Create the delivery | Cancel the delivery |

If step N fails, run the compensations for the steps that already finished, from N-1 down to 1, **in reverse order**:

```diagram
type: flow
alt: After the delivery is rejected, the saga refunds the card, releases the stock and marks the order failed.
caption: Figure 2. The compensations run in reverse order, then the order is marked FAILED.
Delivery rejected -> Refund the card -> Release the stock -> Order marked FAILED
```

This is the idea in simplified pseudocode:

```pseudocode
completed = []
for step in [reserveStock, chargeCard, createDelivery, sendConfirmation]:
    try:
        step.run()
        completed.push(step)
    catch failure:
        # a timeout is not a failure: the step may have worked, so undo it too
        step.compensate()              # must be safe even if the step never ran
        for done in reverse(completed):
            done.compensate()          # refund, release stock, ...
        mark order as FAILED
        return
mark order as COMPLETED
```

Two common ways to coordinate it:

- **Orchestration.** One service, the orchestrator, holds the script above, calls each step and decides what to do on failure. It is easy to follow and easy to see where an order is stuck.
- **Choreography.** There is no central script. Each service publishes an **event** (a message saying that something happened, such as "PaymentTaken") through a message broker like Kafka or RabbitMQ, and the next service reacts. It has fewer moving parts to start, and it gets hard to understand as the number of events grows.

## How to diagnose half-finished actions

**1. Store the saga's state, and look for stuck ones.** Each order should have a state (`STARTED`, `PAYMENT_STARTED`, `PAYMENT_DONE`, `COMPENSATING`, `COMPLETED`, `FAILED`). Anything that sits in a middle state too long is stuck. In PostgreSQL syntax (in MySQL use `NOW() - INTERVAL 15 MINUTE`):

```sql
SELECT id, state, updated_at
FROM sagas
WHERE state NOT IN ('COMPLETED', 'FAILED')
  AND updated_at < now() - interval '15 minutes';
```

**2. Reconcile across systems.** Compare the services' records. Payments with no matching order, or stock reservations older than an hour with no confirmed order, are leftovers of half-finished sagas.

**3. Check the compensation path.** Look for orders in `COMPENSATING` for a long time. A refund that keeps failing leaves the customer out of pocket.

**4. Follow one order through the logs** with a single ID that every service records (a correlation ID), so you can see which step stopped.

## Fix 1: keep the saga's state in a database

The coordinator must **write down what it has done** before and after each step, so it can pick up where it left off after a crash. The call uses an **idempotency key**, a unique ID sent with the request so the receiver can recognize a repeat. A step is **idempotent** when running it twice has the same effect as running it once:

```pseudocode
save state = PAYMENT_STARTED
call payment service (idempotency key = order id + ":charge")
save state = PAYMENT_DONE
```

On restart, it reads the unfinished sagas and **continues** them, or compensates them. The [retries and idempotency post](/posts/idempotency-key-double-charge/) explains the key in depth.

## Fix 2: make every step and compensation idempotent

Because steps are retried after timeouts and crashes, each one may run twice. A refund that runs twice refunds twice. Give every step and every compensation its own idempotency key, usually the order ID plus the step name (for example `order-42:refund`), and make a repeat harmless.

## Fix 3: order the steps so that failure is cheap

Some actions cannot truly be reversed: an email that has been sent, a parcel already collected. Others are costly to reverse: a refund takes days and may cost fees. So do the cheap, likely-to-fail checks **first**, and the hard-to-undo steps **last**.

In the example, the address was wrong and was found only after the card was charged. Validating the address before taking the money would have avoided the whole failure. A common pattern is to **authorize** the card (place a hold) early, and **capture** it (take the money) as late as possible. Cancelling a hold is cleaner than a refund. The step after which you must always push forward, never undo, is sometimes called the **pivot**.

For things that cannot be undone, a compensation is a **correction**, not an undo: you cannot unsend an email, but you can send a second one that says the order was cancelled.

## Fix 4: do not lose the event itself

A service often needs to "update my database **and** tell the others". Doing both separately can lose one: the update commits, the message fails to send, and the next step never starts. The **transactional outbox** pattern solves it. Write the event into an `outbox` table in the **same local transaction** as the data change, and have a separate process publish rows from that table.

The data change and the event record then succeed or fail together. The event is published at least once, and possibly twice, so receivers must handle duplicates, which is idempotency again. The publisher can poll the table, or use change data capture with a tool such as Debezium.

## When the fix goes wrong

A saga adds new ways to fail. These three are the easiest to miss.

**1. A timeout is not a failure.** The saga calls the payment service, waits 3 seconds and gets no answer. It looks like the charge failed, so the saga releases the stock and marks the order `FAILED`. But the payment service was only slow. It charged the card 4 seconds later. Now the customer paid 40 for an order that does not exist, and no error was ever raised.

A **timeout** only means "no answer yet". The real result is unknown. Retrying with a new request is just as bad, because it may charge twice.

**What to do instead.** Treat an unknown result as "maybe done". Retry with the **same** idempotency key, so the payment service returns the first result instead of charging again. Or run the compensation, and write it so it is safe even if the step never happened: a refund looks up the charge by its key, and does nothing if there is none. Also record that this key is cancelled, so a charge that arrives late is rejected.

**2. A compensation that fails, or runs twice.** The saga decides to refund 40, but the refund service is down. If the saga tries once and gives up, the customer stays charged, and the order is `FAILED`, so nothing looks wrong.

Retrying fixes this, but it brings the next problem. Say the refund went through, and only the reply was lost. A retry with no idempotency key refunds again, and the customer gets 80 back.

**What to do instead.** Keep the saga in `COMPENSATING` and retry with waits between tries, always with the same key such as `order-42:refund`. Raise an alert if it takes too long, and move it to a manual-review queue. A **dead-letter queue** (where a message broker puts messages it could not process) often feeds that queue. A compensation must never be "best effort".

**3. Users seeing the middle.** A database transaction hides half-finished work from other users. This is called **isolation**, and a saga does not have it. Say one item is left in stock. Order A reserves it. Two seconds later A's payment fails and the stock is released. In those two seconds, customer B sees "sold out" and leaves, and the item then sits unsold.

**What to do instead.** Do not show the middle state as if it were final. Show a **pending** state, such as "reserved for 10 minutes", and design the screens around it. The order is either confirmed or released.

Smaller pitfalls:

- **Forgotten timeouts.** A step that never answers leaves the saga waiting forever. Give every step a deadline, and have a background job that picks up stuck sagas.
- **Choreography that turned into spaghetti.** When five services react to each other's events, nobody can say what happens when step 3 fails. Switch to an orchestrator when the flow gets that complicated.
- **Treating compensation as a perfect undo.** A refund takes days to appear and may cost fees.
- **Building it all by hand.** Workflow engines such as Temporal, Camunda or AWS Step Functions store the saga's state, retries and timers for you. Consider one before writing your own.

## Which should you use?

| Situation | Reach for |
|---|---|
| One database owns all the data | **A normal transaction.** Do not build a saga |
| A flow across a few services | **An orchestrated saga** with persisted state |
| A simple chain of independent reactions | **Choreography** with events, kept small |
| Updating a database and publishing an event | **A transactional outbox** |
| An action that cannot be undone | **Put it last,** and use a corrective follow-up |

If you are not sure, first ask whether the data really needs to live in separate services. The simplest saga is the one you never have to write.

## The takeaway

1. A database transaction **cannot span services**. When step 3 fails, steps 1 and 2 are already committed.
2. A **saga** is a series of local transactions, each with a **compensating action**. After a failure, the compensations run in reverse order.
3. Diagnose with a **saga state table** and **reconciliation** between services, looking for stuck and orphaned records.
4. Persist the saga's state, make every step and compensation **idempotent**, and put the hardest-to-undo steps **last**.
5. Compensations can fail too, and a timeout is not a failure. Retry, alert, and keep a manual path. Use an **outbox** so an event is never lost.
