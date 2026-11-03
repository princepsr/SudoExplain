---
title: Zero-downtime database migration: add a column safely
date: 2026-11-01
description: How a routine ALTER TABLE can stall a busy app, and how lock_timeout, expand and contract, and batched backfills give a zero-downtime migration.
tags: databases, migrations, deployment
draft: true
---

## The question

It was a small change: add one column to the `users` table. The migration passed on a laptop in 20 milliseconds, and passed in staging. In production, the deploy started, and within seconds every page that touched `users` hung. Connections piled up, and the app fell over.

The migration itself was tiny. It never even ran for long.

> Why can adding one column freeze the whole application?

The statement needs a strong lock on the table. If it has to wait for that lock, everything behind it waits too.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why some schema changes take a strong lock, and why a **waiting** change blocks even plain reads
> 2. The **expand and contract** pattern, and why old and new app versions must both work during a deploy
> 3. How to **diagnose** a migration that is blocking others
> 4. The safe tools: `lock_timeout`, concurrent indexes, two-step constraints, and batched backfills

## First, schema changes and locks

A **schema change** (a migration) alters the structure of a table: adding a column, adding an index, adding a constraint. A **lock** is a marker that makes other transactions wait so they do not see a half-changed table.

In PostgreSQL, many forms of `ALTER TABLE` take an `ACCESS EXCLUSIVE` lock, the strongest one. The manual says it conflicts with every other lock mode, including the `ACCESS SHARE` lock that an ordinary `SELECT` takes. Only that mode blocks plain reads.

If nobody is using the table, the lock is granted instantly and released in milliseconds. The trouble starts when someone is using it.

## The failure: the lock queue

Suppose a report query has been reading `users` for 40 seconds. The migration starts and asks for its strong lock. It cannot get it, because the report holds a weaker lock that conflicts. So the migration waits. Then normal traffic arrives:

```diagram
type: sequence
alt: A long read holds a lock, an ALTER waits for it, and a new read queues behind the ALTER.
caption: Figure 1. The waiting ALTER does nothing, yet it blocks every later query.
actors: Reader A | ALTER | Reader B | Table
Reader A -> Table: SELECT (runs 40 seconds)
ALTER -> Table: wants strong lock, waits
Reader B -> Table: SELECT, queued behind ALTER !
note all: every new query waits: the app stalls !
```

Reader B asks for a lock that would normally be fine next to Reader A. But the lock request in front of it, the ALTER, is waiting, and a request that conflicts with a waiting request has to wait in line behind it. PostgreSQL's lock manager works this way (its source documentation says conflicting requests are granted in order of arrival), although the manual does not spell it out. This is called the **lock queue** effect. MySQL documents the same behavior for online DDL: a pending exclusive metadata lock blocks later transactions on the table.

So the damage is not caused by the migration's work. It comes from **waiting** while holding a place at the front of the line. One long query or one forgotten open transaction is enough.

## How to diagnose it

**1. See who is waiting.** In PostgreSQL:

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY xact_start;
```

Look for many sessions with `wait_event_type = 'Lock'`, and for the oldest transaction at the top. The oldest one is usually the one the migration is waiting for.

**2. Find the blocker.** `pg_blocking_pids(pid)` lists which sessions block a given one. Follow the chain: later queries are blocked by the ALTER, and the ALTER is blocked by the long transaction.

**3. In MySQL**, `SHOW FULL PROCESSLIST` shows the state "Waiting for table metadata lock" for the DDL and for the sessions behind it. The Performance Schema table `metadata_locks` shows who holds what.

**4. Stop the bleeding.** Cancel the migration, with `pg_cancel_backend(pid)` in PostgreSQL or `KILL QUERY` in MySQL. The queue drains at once. Retry later, in a quiet moment, with the protections below.

> [!WARNING]
> Never run a locking migration against a production database to "see what happens". Rehearse on a copy with realistic data and realistic traffic.

## Fix 1: give up instead of blocking everyone

Set a lock timeout, so the migration fails fast when it cannot get its lock, instead of waiting forever:

```sql
SET lock_timeout = '3s';
ALTER TABLE users ADD COLUMN display_name text;
```

PostgreSQL's `lock_timeout` aborts any statement that waits longer than the limit for a lock. The default is 0, which disables it. The manual advises against setting it globally in `postgresql.conf`, because it would affect all sessions. Set it per session or per migration.

If the statement fails, the app only suffered 3 seconds of queueing. Run the migration again, in a loop with a pause, until it gets through. MySQL's equivalent is `lock_wait_timeout`, which controls how long DDL waits for a metadata lock.

## Fix 2: expand and contract

A change that needs more than one step should be shipped in steps that are each safe. This pattern has two halves. **Expand** adds the new structure next to the old. **Contract** removes the old one later. Say you want to replace `name` with `display_name`:

```diagram
type: flow
alt: Five steps: add the column, write to both, backfill, switch reads, drop the old column.
caption: Figure 2. Each step ships on its own, and each can be rolled back.
Add nullable column -> Deploy: write both columns -> Backfill in small batches -> Deploy: read new column -> Drop old column later
```

1. **Add** the column, nullable and without constraints. It is a fast change.
2. **Deploy** code that writes both columns.
3. **Backfill** old rows in small batches (Fix 4).
4. **Deploy** code that reads the new column.
5. **Drop** the old column in a later release, once nothing uses it.

Why so slow? Because of **rolling deploys**. While you deploy, old and new versions of the app run at the same time, both against the same database. The old version knows nothing about `display_name`. So every schema state must work for both versions, or the old servers fail during the deploy.

## Fix 3: constraints and indexes the safe way

Adding a constraint normally scans the whole table while holding a strong lock. In PostgreSQL, split it into two steps:

```sql
ALTER TABLE orders
  ADD CONSTRAINT orders_total_ck CHECK (total >= 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_ck;
```

`NOT VALID` skips the scan, and the rule applies to new and changed rows at once. The `ADD CONSTRAINT ... NOT VALID` step itself still needs a brief `ACCESS EXCLUSIVE` lock, so run it under `lock_timeout` too. `VALIDATE CONSTRAINT` then checks the old rows. The manual says it takes a `SHARE UPDATE EXCLUSIVE` lock, which does not block normal reads and writes. Fix any bad rows first, or the validation fails.

For `SET NOT NULL`, the manual says the table scan is skipped when a valid `CHECK` constraint already proves there are no nulls. So add `CHECK (display_name IS NOT NULL) NOT VALID`, validate it, run `SET NOT NULL`, then drop the check.

For indexes, a plain `CREATE INDEX` blocks writes while it builds. Use:

```sql
CREATE INDEX CONCURRENTLY idx_users_display_name
  ON users (display_name);
```

It does not block inserts, updates, or deletes. It scans the table twice and takes longer. It cannot run inside a transaction block. If it fails, it leaves an `INVALID` index behind, which you must drop and retry. See [the missing index post](/posts/slow-query-missing-index/) for why the index matters.

## Fix 4: backfill in small batches

Filling the new column for every row in one `UPDATE` holds locks on millions of rows, bloats the table, and floods the replicas. Do it in small pieces, each its own transaction:

```sql
UPDATE users SET display_name = name
WHERE id IN (
  SELECT id FROM users WHERE display_name IS NULL AND name IS NOT NULL
  ORDER BY id LIMIT 1000
);
-- repeat until it updates 0 rows, with a short pause between runs
-- (the name IS NOT NULL test stops rows with no name from matching forever)
```

Each batch commits quickly, so locks are short. The pause gives the database and its replicas time to breathe.

## What changed in recent versions

Older advice said adding a column with a default rewrote the whole table. Since PostgreSQL 11, adding a column with a constant default does not rewrite it, and the manual says the default is stored in metadata. A volatile default, such as `clock_timestamp()`, an identity column, or a stored generated column, still rewrites the table.

In MySQL, `ADD COLUMN` uses `ALGORITHM=INSTANT` by default as of 8.0.12, and as of 8.0.29 the column can go in any position. If you name `ALGORITHM` or `LOCK` explicitly, MySQL fails the statement when it cannot honor it, instead of silently falling back to something slower.

Even "instant" changes need a brief exclusive metadata lock. They still queue behind a long transaction, as Figure 1 shows.

## When the fix goes wrong

These fixes protect you only when used with care. Three traps catch people most often.

**1. Retrying `lock_timeout` while an old transaction is still open.** `lock_timeout` makes the migration give up, and the retry loop tries again. That works when the blocker is a 40-second report. It fails when the blocker is a transaction that someone left open, such as a script that started a transaction and then stopped. PostgreSQL shows it as `idle in transaction`. It can stay open for hours.

Each retry then queues for the 3-second timeout, and during those 3 seconds the app stalls, as in Figure 1. Say the loop waits 10 seconds between tries. Each cycle is 3 seconds of stall and 10 seconds of calm, so the app is stalled for 3 out of every 13 seconds, about 23% of the time, and the migration never succeeds.

Find the old transaction with the `pg_stat_activity` query above. Ask its owner to finish it, or end it with `pg_terminate_backend(pid)`, which rolls its work back. Then run the migration. To stop this from happening again, you can set `idle_in_transaction_session_timeout`. Its default is 0, which means off.

**2. A migration tool that wraps everything in one transaction.** A lock taken inside a transaction is held until the transaction ends, according to the PostgreSQL manual. Say one migration file adds a column (a brief strong lock) and then backfills 10 million rows, which takes 10 minutes. The strong lock from the first line is held for all 10 minutes, and the table is frozen. `lock_timeout` does not help, because it limits only the **waiting**, not the holding.

The same wrapping breaks `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block. Put each step in its own migration, so each commits and lets go of its locks. For the index step, turn off the tool's transaction wrapping. Most migration tools have a setting for that, so check yours.

**3. A backfill that is too fast for the replicas.** A **replica** is a copy of the database that serves reads. Every batch you write must be replayed on each replica. If you write batches faster than a replica can replay them, it falls behind. Users then save a change and still see the old data, because their read goes to the replica.

Do not pause for a fixed time and hope. Between batches, check how far the replicas are behind. In PostgreSQL, `pg_stat_replication` has a `replay_lag` column for this. If the lag is above your limit, wait. Small batches with a lag check keep the backfill from running ahead of the copies. See [the replica lag post](/posts/read-replica-lag/).

Smaller traps, in short:

- **Skipping the expand step.** Dropping or renaming a column in one release breaks old servers still running mid-deploy.
- **Forgetting the contract step.** Unused columns and double writes linger for years. Put the cleanup in the backlog.
- **Never rehearsing.** A migration that takes 20 milliseconds on a laptop can scan a table for minutes in production.

## Which should you use?

| Situation | Reach for |
|---|---|
| Any `ALTER TABLE` on a busy table | **`lock_timeout`** and a retry loop |
| New column that replaces an old one | **Expand and contract**, in separate deploys |
| New constraint on existing data | **`NOT VALID`, then `VALIDATE`** |
| New index on a large table | **`CREATE INDEX CONCURRENTLY`** |
| Filling a column for many rows | **Small batches** with pauses |

If you are not sure, assume the table is busy, set a short `lock_timeout`, and split the change into steps that each take a brief lock or none.

## The takeaway

1. Many schema changes need the **strongest table lock**, and it conflicts even with plain reads.
2. A change **waiting** for its lock blocks everything queued **behind** it, so one long query can stall the app.
3. Set **`lock_timeout`** so a migration gives up instead of blocking everyone, and retry.
4. Use **expand and contract**, because old and new app versions run side by side during a deploy.
5. Add constraints in **two steps**, build indexes **concurrently**, and backfill in **small batches**.
