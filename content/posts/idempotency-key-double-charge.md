---
title: Idempotency keys: stop retries from charging twice
date: 2026-11-01
description: How a timeout and a harmless-looking retry charge a customer twice, how to find the duplicate, and how idempotency keys make retries safe.
tags: reliability, apis, payments
draft: true
---

## The question

A customer clicks "Pay" once. Their card is charged twice. Support finds two identical requests in the logs, a few seconds apart, and the payment provider shows two charges. Nobody pressed the button twice, and the code does not loop.

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

**Idempotent** means doing it many times has the same effect as doing it once. In HTTP, `GET`, `PUT` and `DELETE` are meant to be idempotent, and so are `HEAD` and `OPTIONS`. `POST`, which usually creates something, is not. "Meant to be" is a promise the server code must keep.

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

The retry is often not in your code:

- **The client or app** retries after a timeout, as good libraries do.
- **A proxy or load balancer** (a server that sits in front and forwards requests) retries silently. Nginx can pass a failed request to another upstream server, though for `POST` only when configured to. Envoy and many cloud gateways have retry rules. Your code never sees it.
- **A message queue** delivers **at least once**. If a consumer (the program reading messages) crashes before it **acknowledges** a message, meaning it tells the queue "done", the broker sends the message again.
- **The user** double-clicks, refreshes after a slow page, or taps "Pay" again. Disabling the button after the first click helps, but it does not replace a server-side check.

## How to diagnose it

**1. Find the two requests.** Search the logs by order ID or user. Two requests with the same payload and a short gap point to a retry.

**2. Compare timings.** Look at how long the server took for request one. If it finished after the client's timeout, the client had already given up. That is the smoking gun.

**3. Look just before the second one.** A timeout, a 502/503/504, a connection reset, a deploy or a slow database spike usually sits right before it. That is the event that made someone retry.

**4. Check the layers in between.** Look at the retry settings of every proxy, gateway and HTTP client between the user and your service. Use a request ID to see whether the second request came from the same client or was created in between.

**5. Check the delivery guarantee.** If the work comes from a queue, assume duplicates will happen. "At least once" is the normal setting. Also check the payment provider's dashboard to see whether an idempotency key was sent.

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
    user_id      bigint NOT NULL,
    idem_key     text   NOT NULL,
    request_hash text   NOT NULL,        -- fingerprint of the request body
    status       text   NOT NULL,        -- 'in_progress' or 'done'
    response     text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, idem_key)
);
```

The order of steps matters:

```pseudocode
on request with key K:
    try INSERT (user, K, hash(body), 'in_progress')
    if the insert hit the unique constraint:             # seen before
        row = SELECT where user = user and key = K
        if row.request_hash != hash(body):  reject (4xx: same key, different request)
        if row.status == 'done':            return row.response
        else:                               return 409 "still being processed"

    try:
        result = chargeCard(..., idempotencyKey = K)     # do the work once
    on failure:
        DELETE the key row (so a retry can try again), then rethrow
    UPDATE keys SET status = 'done', response = result WHERE key = K
    return result
```

```diagram
type: flow
alt: A retry arrives with the same key, the unique insert fails, and the stored result is returned without charging.
caption: Figure 2. The key table stops the second charge.
Retry with same key -> Unique insert fails -> Stored result returned -> No second charge
```

Notice two details. The key is **recorded before the work starts**, so two simultaneous requests cannot both pass. That is the check-then-act race from [the race conditions post](/posts/race-condition-check-then-act/), and a unique constraint solves it.

The **same key is passed on** to the payment provider, since many providers, Stripe among them, accept an idempotency key and deduplicate on their side too. That also makes recovery safe. If the server crashes after charging but before marking the key done, the row stays in progress until its timeout. A later retry then reaches the provider with the same key, and the provider does not charge again.

## Other ways to get the same safety

- **Use a natural unique ID.** An order has an ID. A unique constraint on `payments(order_id)` makes a second payment for the same order impossible, with no extra table.
- **Make the operation "set", not "add".** "Set status to PAID" is safe to repeat. "Increase the paid amount" is not.
- **Deduplicate in consumers.** Record the message IDs you have processed, and skip any you have seen. [The poison message post](/posts/poison-message-dead-letter-queue/) covers queues in more depth.

## When the fix goes wrong

A key table is easy to add and easy to get subtly wrong. Three mistakes matter most.

**1. Recording the key after the work.** The natural order feels logical: look the key up, charge the card, then save the key. The check is "have I seen this key?", and the save is "now I have".

The trouble is the gap between the charge and the save. Say the server charges $50 and crashes before it saves the key. The retry arrives, finds no key, and charges another $50. The same gap exists with no crash at all. Two copies of one request that arrive together both look the key up, both find nothing, and both charge. This is the check-then-act race from the earlier section.

**What to do instead.** Insert the key row first, with status `in_progress`, and rely on the unique constraint. Only one request can insert it. The loser sees the row and does not charge. Mark the row `done` after the work.

**2. A key that is generated per attempt.** A common version: the retry code builds a fresh UUID each time it sends. Every attempt looks like a new action, so the table never sees a repeat. Attempt 1 charges $50, the reply is lost, and attempt 2 arrives with a different key. The server charges again.

**What to do instead.** The key belongs to the action, not the attempt. Create it once, when the user starts the action, such as when the checkout page loads. Keep it, and send the same value on every retry of that action. Only a new action, such as a second purchase, gets a new key.

**3. A stuck "in progress" row, and the timeout that fixes it.** Record-first has a price. If the server crashes after inserting the row, the row says `in_progress` forever. Every retry then gets "still being processed", and the user can never finish.

The usual fix is a timeout: after some time, an `in_progress` row may be taken over. But a timeout that is too short is dangerous. Suppose a payment can take up to 40 seconds, and the timeout is 30. At second 31 a retry takes over the row while the first request is still working. Now two requests charge at once.

**What to do instead.** Set the timeout longer than the slowest normal run of the work. Also pass the same key on to the payment provider, as shown earlier. Then even if two requests do run, the provider charges once.

The smaller ones:

- **Keys that expire too early.** If you keep keys for an hour and a client retries after a day, the key is gone. Keep them at least as long as a client may retry, often a day or more. Providers expire keys too (Stripe may prune them after 24 hours), so your own table must cover longer retry windows.
- **Other side effects.** A **side effect** is anything the action does besides its main result. The payment is safe now, but the confirmation email may still go out twice. Each side effect needs its own protection.
- **One key shared between users.** Scope the key by user, as the primary key above does, or one user's key can block another's request.

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
