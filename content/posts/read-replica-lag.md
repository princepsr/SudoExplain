---
title: Read replica lag: why users do not see their own writes
date: 2026-11-01
description: Why a read replica shows old data right after a save, how to measure replication lag, and how read-your-own-writes routing fixes the confusion.
tags: databases, replication, scaling
draft: true
---

## The doubt

A user edits their profile name and clicks Save. The page reloads and shows the old name. They assume the save failed and click Save again. Now support tickets arrive about duplicate comments, double orders, and "my changes disappear, then come back."

Nothing is broken in the code. A few seconds later the new value appears everywhere.

> Why does the database forget what I just saved, and then remember it again?

The write went to one server, and the read came from another server that had not heard about it yet.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a primary and a read replica are, and why the replica can be behind
> 2. What **replication lag** is, and the guarantee users silently expect: reading their own writes
> 3. How to **measure** lag in PostgreSQL and MySQL
> 4. How to route reads so users see their own changes, and which traps to avoid

## First, primary and replica

A **primary** is the database server that accepts writes. A **replica** (also called a standby or follower) is a copy that receives every change from the primary and replays it. Teams add replicas so that reads, which are usually the bulk of the traffic, can be spread over several machines.

The copying is usually **asynchronous**: the primary confirms a write to the application first, and sends it to the replicas afterward, without waiting for them. That keeps writes fast. The price is that a replica is always a little behind. The gap is called **replication lag**.

Think of a newspaper. The head office prints the news, and the branch offices receive copies by delivery truck. A branch can only show what has arrived. Usually that is minutes old and nobody cares. It matters when you just told the head office something and then ask the branch about it.

## The failure: a read that arrives too early

Here is one save and one reload, on a small setup with one primary and one replica:

```diagram
type: sequence
alt: A write commits on the primary, but the reload is answered by a replica that still has the old value.
caption: Figure 1. The reload reads from the replica before the change has been copied to it.
actors: Browser | App | Primary | Replica
Browser -> App: save name = Ana
App -> Primary: UPDATE name (committed)
Primary --> App: ok
App --> Browser: saved
Browser -> App: reload page
App -> Replica: SELECT name
Replica --> App: returns old name Ann !
note Replica: the change is still on its way
```

The save really happened. The reload simply asked a server that was a few hundred milliseconds behind. With a healthy network the lag is often small, but it is never zero, and a user reloads in less than a second.

Users expect a guarantee called **read your own writes**: after I change something, I must see my change. Replicas do not give it for free. Other users seeing the old value for a moment is usually fine. The author of the change seeing it is not.

When the lag grows, the effect gets worse. A large batch job, a long-running query on the replica, or a busy network can push lag from milliseconds to minutes. Then "my changes disappear" becomes "my changes disappeared for ten minutes."

## How to diagnose it

**1. Confirm it is lag, not a lost write.** Read the same row from the primary and from the replica a few seconds apart. If the primary has the new value and the replica gets it later, it is lag.

**2. Ask the primary how far behind each replica is.** In PostgreSQL, the `pg_stat_replication` view has one row per connected replica:

```sql
SELECT application_name, replay_lag, replay_lsn, sent_lsn
FROM pg_stat_replication;
```

`replay_lag` is the time between the primary flushing recent changes and learning that the replica has applied them, so it approximates how long a new change takes to become visible there. It can be empty (NULL) when the replica is fully caught up and nothing is being written. An LSN (log sequence number) is a position in the change log, so comparing `sent_lsn` with `replay_lsn` shows the gap in position.

**3. Ask the replica itself.** On a PostgreSQL standby:

```sql
SELECT now() - pg_last_xact_replay_timestamp() AS replay_delay;
```

This function returns the commit time of the last change the standby replayed. If the primary is idle, no new commits arrive, so this number grows even though the replica is fully caught up. Do not alert on it alone.

**4. In MySQL**, run this on the replica:

```sql
SHOW REPLICA STATUS\G
-- look at Seconds_Behind_Source
```

From MySQL 8.0.22, `SHOW REPLICA STATUS` replaces `SHOW SLAVE STATUS`, which is deprecated from that release. Before that, the statement is `SHOW SLAVE STATUS` and the field is called `Seconds_Behind_Master`. The value is `NULL` when the applier thread is not running, and it can show 0 on a slow network even when the replica is behind. Treat it as a hint, not a measurement.

**5. Count the bytes.** In PostgreSQL, compare positions, which stays meaningful when the primary is idle:

```sql
SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(),
                       pg_last_wal_replay_lsn()) AS replay_backlog_bytes;
```

Run it on the standby. It shows how much received change data is waiting to be applied.

## Fix 1: read from the primary after a write

The simplest rule: for a short time after a user writes, send that user's reads to the primary. Pick a window longer than your normal lag, such as 5 to 10 seconds, and remember when the user last wrote, for example in their session.

```pseudocode
on write by user U:
    do the write on the primary
    store U.last_write_time = now

on read by user U:
    if now - U.last_write_time < 5 seconds:
        read from the primary
    else:
        read from a replica
```

It costs a little primary load, only for users who just wrote, and it is simple to build. It works well when most requests are reads by users who have not just written.

## Fix 2: route by position, not by time

A time window guesses how long lag lasts. A position check knows. After a write, record where the primary's change log stood. Send the user to a replica only when that replica has replayed past that point, and otherwise use the primary.

In PostgreSQL, right after the commit returns, read `pg_current_wal_insert_lsn()` on the primary (or `pg_current_wal_lsn()` when `synchronous_commit` is on) and save the value. On a replica, a read is safe when this is true:

```sql
SELECT pg_last_wal_replay_lsn() >= '0/3000148'::pg_lsn;  -- illustrative value
```

MySQL with GTIDs (global transaction IDs, a name for each committed transaction) has `WAIT_FOR_EXECUTED_GTID_SET()`, which waits until the server has applied a given set, with an optional timeout in seconds. This is more precise than Fix 1, but needs more plumbing: the token must travel with the user's session, and the router must ask the replica.

## Fix 3: stop using replicas that are too far behind

Separately from per-user routing, protect everyone from a badly lagging replica. Have the router or load balancer check lag, and take a replica out of rotation when it exceeds a limit, such as 10 seconds. Put it back when it catches up. If all replicas exceed the limit, reads fall back to the primary, so make sure it can take that load.

## Fix 4: synchronous replication, and its cost

In PostgreSQL you can make commits wait for a standby. With `synchronous_standby_names` set and `synchronous_commit = remote_apply`, a commit returns only after the standby has applied the change and made it visible to queries. The manual says this causes much larger commit delays, because it waits for replay.

This gives the strongest guarantee, but every write now depends on the standby being up and fast. A slow or dead standby slows or blocks writes. Many teams use it for one standby only, or only for selected transactions, since `synchronous_commit` can be set per transaction.

## Fix 5: make the page show what was saved

Often the cheapest fix is in the user interface. After a save, the server returns the saved record, and the page shows that, instead of reloading from a replica. The user sees their own change right away. The next navigation may still show old data briefly, but the user already got confirmation.

Pair it with a guard against double submission, such as disabling the button until the reply arrives. If a duplicate is dangerous, also make the write safe to repeat, as in [the idempotency post](/posts/idempotency-key-double-charge/).

## When the fix goes wrong

Three pitfalls matter most, because each one passes testing and fails later in production.

**1. Sticky routing that never expires.** After a user writes, you pin that user to the primary, for example with a flag "use_primary" saved on the user. It fixes the stale read, so it looks done.

The problem is that the flag is never cleared. Every active user writes sooner or later: a login updates "last seen", a profile edit saves a name. After a few weeks most users are pinned. Say 9,000 of 10,000 active users have written at least once (illustrative). Then about 90% of reads go to the primary, and the replicas sit idle. You are back to the load you wanted to avoid, and it looks fine until traffic grows.

Give the rule an end. Save the time of the user's last write, as in Fix 1, and use the primary only while that time is recent.

**2. A window shorter than the lag.** A time window assumes the replica catches up inside it. Say your window is 5 seconds, and normal lag is 0.2 seconds. Then a batch job raises the lag to 30 seconds. A user saves at 12:00:00. The window ends at 12:00:05, so a read at 12:00:06 goes to a replica that is still 30 seconds behind, and the old data appears.

This is the cruel part: the fix works in every test, and fails exactly when the system is under stress. Use the position check from Fix 2, which waits for the real change. Or combine the window with Fix 3, so a replica that is too far behind leaves rotation and reads fall back to the primary.

**3. Reads that cross requests.** One page may run several queries. Say a confirmation page reads the order, then its items. The user saved at time 0, and your window is 5 seconds. The page starts at 4.9 seconds, so the first query goes to the primary. The window ends, and the second query, at 5.1 seconds, goes to a replica that has not caught up. The page shows an order with a total of $50 and an empty list of items.

Decide once, at the start of the request, where it will read, and use that same choice for every query in the request. Do not decide per query.

The smaller pitfalls, in short:

- **Lag spikes you did not plan for.** Large batch writes, schema changes, and long queries on the replica can all raise lag. See [the migration post](/posts/zero-downtime-migration/) for backfills that overload replicas.
- **Time versus bytes.** A time-based lag number can read zero or look huge on an idle system. A byte-based number does not tell you how many seconds a user waits. Watch both.
- **Caches in front of the database.** A stale cache causes the same symptom as lag. See [the stale caches post](/posts/stale-caches-explained/).
- **Mistaking lag for a lost update.** Two users saving over each other is a different bug, covered in [the optimistic locking post](/posts/lost-update-optimistic-locking/).

## Which should you use?

| Situation | Reach for |
|---|---|
| Users complain right after saving | **Primary for a short window** after writes |
| You need a hard guarantee for some reads | **Position-based routing** with a log position token |
| One replica sometimes falls far behind | **A lag threshold** that removes it from rotation |
| A few critical writes must be visible on the synchronous standby | **Synchronous replication** for those transactions |
| The only problem is a confusing page | **Show the saved value** from the write response |

If you are not sure, start with Fix 1 plus Fix 3, and add the saved-value display from Fix 5. Move to position-based routing only when a time window proves too blunt.

## The takeaway

1. A **replica copies the primary asynchronously**, so it is always a little behind.
2. That gap is **replication lag**, and it can break the "read your own writes" expectation.
3. **Measure it** with `pg_stat_replication` in PostgreSQL or `SHOW REPLICA STATUS` in MySQL, and know the limits of each number.
4. **Route the author's reads to the primary** for a short time, or by log position, and drop lagging replicas from rotation.
5. **Show the saved value** in the UI, and give every special routing rule an expiry.
