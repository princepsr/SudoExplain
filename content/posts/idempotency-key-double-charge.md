---
title: "Idempotency key: stop a retry from charging twice"
date: 2026-11-07
description: A timeout and a retry can charge a customer twice. See how to find the duplicate and how an idempotency key makes a retry safe.
tags: apis, payments
---

## The question

A customer clicks "Pay" once, but their card is charged twice. In the logs, support finds the same payment request two times, a few seconds apart.

> I clicked once. Why did the server do it twice?

Because the first attempt might have worked, and nobody could tell.

Think of pressing a lift button twice, which does no harm, and ordering a taxi twice, which sends two cars. Some actions can safely repeat and some cannot.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a timeout leaves the caller **unable to tell** whether the work happened
> 2. Where the silent second request comes from (clients, proxies, queues)
> 3. How to **diagnose** a duplicate from logs
> 4. How **idempotency keys** make a retry safe, and how to build them without new races

## First, the problem with a timeout

When you send a request over a network and get no answer, three different things could have happened:

```text
1. The request never arrived.            -> work NOT done
2. The server crashed halfway.           -> work maybe done
3. The server finished, the reply got lost. -> work DONE
```

From the caller's side, all three look **identical**: silence, then a timeout. The honest answer to "did it work?" is "I do not know."

The caller can only guess. If it does nothing, a payment may never be made. If it retries, a payment may be made twice. For some operations, a retry is harmless. For others, it is not:

- "Set the balance to 100": running it twice gives the same result. This is **idempotent**.
- "Add 100 to the balance": running it twice adds 200. This is **not** idempotent.

**Idempotent** means doing it many times has the same effect as doing it once.

Reading a page (`GET`), setting a value (`PUT`) and deleting something (`DELETE`) are safe to repeat. Creating something, such as "charge $50", is usually a `POST`, and it is **not**: each call can create another charge.

## The failure: the lost reply

```diagram
type: sequence
alt: A payment succeeds but the reply is lost, so the client retries and the card is charged a second time.
caption: Figure 1. The server did the work, but the client never heard.
actors: Client | Server | Provider
Client -> Server: POST /charge
Server -> Provider: charge $50
Provider --> Server: ok
Server -x Client: reply lost
note Client: it sees a timeout, so it retries
Client -> Server: POST /charge (retry)
Server -> Provider: charge $50 again !
```

The server did exactly what it was asked, twice. Nothing is broken in the usual sense.

## Where the second request comes from

The retry is often not in your code. Any of these can send it:

- **The app or client.** After a timeout, many HTTP libraries try again on their own.
- **A server in the middle.** A proxy or load balancer, which forwards requests to your server, can resend a request when the first try fails. Your code never sees it. Nginx, for example, does not retry a `POST` unless you configure it to.
- **A message queue.** A queue hands a message to a program that does the work. If that program crashes before it says "done", the queue sends the same message again. This is called **at-least-once delivery**.
- **The user.** They click again because the page is slow. Disabling the button after the first click helps, but the server must still protect itself.

## How to diagnose it

**1. Find the two requests.** Search your logs for the order ID or the user. If you see the same request twice, a few seconds apart, it is probably a retry.

**2. Compare the timings.** Check how long your server took to answer the first request. Say the client waits 10 seconds, but your server needed 12. The client gave up at second 10 and sent the request again, even though the first one finished later. That is the proof.

**3. Look at what happened just before the second request.** Something usually went wrong right before it: a timeout, an error, or a slow moment in the database. A slow query ([find a missing index](/posts/slow-query-missing-index/)) or a [full connection pool](/posts/connection-pool-exhausted/) can cause this. That slowness is what made someone retry.

**4. Find who sent it.** The retry may not come from your code. Check every place between the user and your server, such as the app, a proxy or a load balancer, and see which one has retry turned on. Each request has an ID in the logs, so you can follow it step by step.

**5. Check if a queue sent it twice.** If the payment started from a message queue, a repeat is normal, because queues deliver a message at least once. Then open the payment provider's dashboard and compare the two charges. If they have different idempotency keys (the unique ID we add below), the provider could not tell they were the same payment.

## Fix: an idempotency key

The client creates a unique **idempotency key** for each logical action, such as one UUID (a long random identifier) per checkout, and sends it with every attempt of that action:

```text
POST /charge
Idempotency-Key: 7f3a9c1e-5b2d-4c8a-9e61-0d4f2a8b7c13
```

The server remembers the key. The first request does the work and records the result. Any later request with the same key gets the **recorded result back** without doing the work again.

Store the keys in a table with a **unique** constraint (a rule the database enforces, rejecting a second row with the same value):

```sql
CREATE TABLE idempotency_keys (
    user_id  bigint NOT NULL,
    idem_key text   NOT NULL,
    -- 'in_progress' or 'done'
    status   text   NOT NULL,
    response text,
    PRIMARY KEY (user_id, idem_key)
);
```

The primary key is the unique rule: one row per user and key. The server follows these steps for every request:

```pseudocode
on request with key K:
    # a second row with the same key is rejected
    try to INSERT K with status 'in_progress'

    if the insert was rejected (K was seen before):
        if K is 'done':
            return the saved response
        return "still being processed"

    # the key is new, so do the work once
    result = charge the card, passing K on

    if the charge failed:
        # remove K so a retry can try again
        DELETE K and report the error

    save result and mark K as 'done'
    return result
```

```diagram
type: flow
alt: A retry arrives with the same key, the unique insert fails, and the stored result is returned without charging.
caption: Figure 2. The key table stops the second charge.
Retry with same key -> Unique insert fails -> Stored result returned -> No second charge
```

Two details matter here. First, the key is **saved before the work starts**. Say two requests arrive at the same moment. If each one only checks "have I seen this key?", both see "no", and both charge the card. This problem is called the check-then-act race. Saving first, with a unique rule, fixes it: the database lets only one request save the key, and the other is rejected.

Second, the **same key is passed on** to the payment provider. Many providers, Stripe among them, accept an idempotency key and ignore a repeat. This helps when the server crashes after charging but before marking the key `done`. The row stays `in_progress` until its timeout. A later retry then reaches the provider with the same key, and the provider does not charge again.

Keep each key for as long as a client might still retry, often a day or more. If you delete it after an hour, a retry that arrives later looks like a new action. Providers delete keys too (Stripe may after 24 hours), so your own table must keep them longer.

The key protects only the charge. Anything else the action does, such as sending a confirmation email, can still happen twice. Protect each of those the same way.

## Other ways to get the same safety

- **Use an ID you already have.** Every order has an ID. Make the order ID unique in the `payments` table, and the database refuses a second payment for the same order. No extra table is needed.
- **Use "set", not "add".** "Set status to PAID" is safe to repeat. "Add $50 to the paid amount" is not.
- **Skip messages you have already handled.** If your program reads from a queue, save the ID of each message it finishes, and ignore a message whose ID is already saved. Queues, and the messages that keep failing in them, are a topic of their own.

## When the fix goes wrong

A key table is easy to add and easy to get wrong. Two mistakes cause most of the trouble.

**1. A new key for every attempt.** Some retry code makes a fresh random ID each time it sends. Then every attempt looks like a new action, and the table never sees a repeat. Attempt 1 charges $50, the reply is lost, and attempt 2 arrives with a different key. The server charges again. The key must stay the same on every retry of one action.

**2. A row stuck at "in progress".** Saving the key first has a cost. If the server crashes after saving the row, it says `in_progress` forever. Every retry gets "still being processed", and the user can never finish. The usual fix is a timeout: after some time, a retry may take over the row. But a short timeout is dangerous. Say a payment can take 40 seconds and the timeout is 30. At second 31 a retry takes over while the first request is still working, and both charge.

**What to do instead.** Set the timeout longer than the slowest normal run. Also pass the same key to the payment provider, as shown earlier. Then even if two requests run, the provider charges once.

## Which should you use?

| Situation | Reach for |
|---|---|
| An API that creates things or moves money | **Idempotency keys,** recorded before the work |
| Something that happens once per business object | **A unique constraint** on the natural ID |
| A queue consumer | **Deduplicate by message ID,** and make handlers idempotent |
| An update to a value | **"Set to X"** instead of "add Y" |
| You do not control the client's retries | **Assume duplicates.** Design so repeats are harmless |

If you are not sure, assume every request can arrive twice, and ask what would happen. If the answer is "bad", the operation needs a key.

## The takeaway

1. After a timeout, a caller **cannot know** whether the work happened, so retrying is a gamble unless the operation is safe to repeat.
2. **Idempotent** means doing it twice equals doing it once. `POST` usually is not.
3. The second request may come from a **client, a proxy, a queue or the user**. Check every layer.
4. Fix it with an **idempotency key per action**, recorded in a unique-constraint table **before** the work, and passed on to the provider.
5. Protect every side effect, not just the payment, and expire keys only after clients have stopped retrying.
