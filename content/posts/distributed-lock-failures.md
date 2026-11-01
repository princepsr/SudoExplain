---
title: Distributed lock failures: why Redis locks need fencing
date: 2026-11-01
description: How a Redis lock with an expiry lets two workers run the same job after a pause, and how fencing tokens, idempotency, or a database make it safe.
tags: distributed-systems, redis, concurrency
draft: true
---

## The doubt

A team runs a nightly job on three servers and uses a Redis lock so only one runs it at a time. For months it works. One night, customers get two invoices. The logs show worker A and worker B both processing the same batch, about 25 seconds apart.

Both of them had successfully taken the lock. The code was correct, and the lock worked as designed.

> If only one worker can hold the lock, how did two of them run the job?

The lock expired while the first worker was paused. It woke up still believing it owned the lock.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a lock inside one program does not work across servers, and what a Redis lock looks like
> 2. Why the **expiry** every such lock needs is exactly what lets two holders exist
> 3. How a **fencing token** lets the protected resource reject the stale holder
> 4. What else to use (database locks, leases, idempotency), and what the Redlock debate is about

## First, why a lock in one process is not enough

A **lock** makes sure only one piece of code at a time works on something. In Java, `synchronized` or a `ReentrantLock` does this, but only inside one running program (a process). Two servers run two separate programs, and neither can see the other's lock.

So the lock has to live somewhere both can reach, such as a Redis key or a database row. The race this prevents is the one in [the check-then-act post](/posts/race-condition-check-then-act/). It is also the usual cure when [a scheduled job runs on several servers at once](/posts/scheduled-job-runs-multiple-times/).

The common Redis recipe is one command. Redis is an in-memory data store, and this command sets a key only if it does not exist yet:

```bash
redis-cli SET job:42:lock 7f3a9c NX PX 30000
```

`NX` means "only if the key does not exist". `PX 30000` makes the key expire after 30,000 milliseconds. The value, `7f3a9c`, is a random string unique to this worker. The reply is `OK` if the worker got the lock, and nil if somebody else has it.

To release the lock, the worker must delete the key only if the value is still its own. The Redis documentation gives this Lua script (Redis runs it as one step, so nothing can sneak in between the check and the delete):

```text
if redis.call("get",KEYS[1]) == ARGV[1] then
    return redis.call("del",KEYS[1])
else
    return 0
end
```

The documentation notes that Redis 8.4 added a `DELEX` command that does the same with `IFEQ`. Without the value check, a slow worker could delete a lock that now belongs to someone else.

## Why the lock needs an expiry

If a worker crashes while holding the lock, nobody can ever release it. Everyone else would wait forever. So the lock expires on its own, after a time-to-live (TTL): a set lifetime after which Redis deletes the key. Expiry guarantees the system recovers from a crash.

It also creates the failure. The expiry is a **guess** about how long the work takes. Redis cannot tell a crashed worker from a worker that is just very slow.

## The failure: the paused worker

A worker can stop for many reasons without crashing. One is a long garbage collection pause, when the Java runtime halts your code to clean memory (see [the GC pauses post](/posts/java-gc-pauses/)). Others are a stalled network call, a busy machine, or a virtual machine paused by its host.

```diagram
type: sequence
alt: Worker A takes the lock and pauses, the lock expires, worker B takes it, then both write the result.
caption: Figure 1. After the pause, worker A writes with a lock it no longer holds.
actors: Worker A | Worker B | Redis | Storage
Worker A -> Redis: SET lock NX PX 30000 (ok)
note Worker A: freezes for 40 s (GC pause)
note Redis: lock expires after 30 s
Worker B -> Redis: SET lock NX PX 30000 (ok)
Worker B -> Storage: write result
Worker A -> Storage: write result (stale) !
```

Worker A does not know it was paused. Its own clock says nothing happened, and its last check said "I hold the lock." It writes, and the damage is done. Checking "do I still hold the lock?" just before writing does not fix it, because the pause can happen right after the check.

Here is the same timeline as plain steps:

```pseudocode
t=0    A: acquires lock (expires at t=30)
t=5    A: starts job, then pauses (GC)
t=30   lock expires
t=31   B: acquires lock, starts job
t=45   A: wakes up, thinks it holds the lock, writes result   <-- wrong
t=46   B: writes result                                       <-- also writes
```

## How to diagnose it

- **Look for overlapping work in the logs.** Log the lock holder's id with every job start and end, with timestamps. Two jobs for the same key with overlapping time ranges is the signature.
- **Compare job duration with the TTL.** If the slowest runs come close to the expiry time, you are one pause away from this failure.
- **Check for pauses.** Look at GC logs, CPU throttling in containers, and long network timeouts around the time of the overlap.
- **Check Redis itself.** A restart or failover can lose the key. The Redis documentation notes that replication is asynchronous, so a replica promoted after the master crashes may not have the lock key yet.

## Fix 1: fencing tokens

A **fencing token** is a number that increases every time the lock is granted. The lock service hands it out together with the lock. The worker sends the token with every write. The **resource being protected** (the database or the storage) remembers the highest token it has seen and rejects anything older.

```diagram
type: sequence
alt: Worker B writes with token 34, then worker A's late write with token 33 is rejected by the storage.
caption: Figure 2. The storage, not the lock, has the last word, so the stale write is refused.
actors: Worker A | Worker B | Storage
Worker B -> Storage: write result, token 34
Storage --> Worker B: accepted (highest = 34)
Worker A -> Storage: write result, token 33
Storage -x Worker A: rejected: 33 is below 34 !
```

In a database it can be one condition on the update:

```sql
UPDATE job_results
SET result = ?, fence = ?
WHERE job_id = ? AND (fence IS NULL OR fence <= ?);
-- if 0 rows were updated, the token is stale: stop working
```

The cost is that the resource must take part. A third-party API that cannot check tokens cannot be protected this way. The token must also come from a source that only ever goes up. Examples are a counter in a database, or a consensus-based system such as ZooKeeper or etcd. A consensus system is a group of servers that agree on one order of events. Martin Kleppmann points out that Redlock has no way to generate such tokens.

## Fix 2: let the database be the lock

If the work ends in a database anyway, use the database. A unique constraint on a "job run" row means a second insert fails:

```sql
INSERT INTO job_runs (job_name, run_date) VALUES ('invoices', '2026-11-01');
-- a second worker's identical insert fails on the unique key
```

Or lock a row inside the same transaction as the work, with `SELECT ... FOR UPDATE`. The lock is released automatically if the connection drops. When the work and the lock live in one transaction, they commit or fail together, and there is no gap for a stale holder to slip through.

## Fix 3: leases with renewal

A **lease** is a lock with a deadline. Instead of one long expiry, the worker takes a short lease (say 10 seconds) and **renews** it while it works, only if the value is still its own. A crash is noticed within seconds, and a long job is never cut off while it is healthy. The cost is a renewal thread and more traffic. It shrinks the window of the failure. It does not close it.

## Fix 4: make the work idempotent

An operation is **idempotent** when running it twice has the same effect as once. Give each unit of work a stable key and record that it was done. If a second worker repeats the work, the second write is a harmless no-op. See [the idempotency key post](/posts/idempotency-key-double-charge/). The lock then becomes what it should be, an optimization that avoids wasted work.

## The Redlock debate

Redlock is a lock algorithm the Redis documentation proposes for several independent Redis servers. A client tries to take the same key on 5 separate masters, and counts the lock as held if it got a majority (at least 3) within less time than the lock's validity.

Two well-known articles disagree about it. Martin Kleppmann's "How to do distributed locking" (February 2016) argues that Redlock depends on bounded pauses, delays, and clock errors. He argues it is unnecessary for efficiency-only locks and unsafe for correctness-critical ones, and recommends fencing tokens with a consensus system or a database with strong guarantees. The Redis author, antirez, replied in "Is Redlock safe?". He argues that clocks need to agree only on elapsed time rate, that pauses after acquisition affect all auto-expiring locks, and that a random token can support check-and-set. He agreed Redis should use a monotonic clock.

The Redis documentation links to both and says to "implement fencing tokens" if you care about correctness. Read both before you decide.

## When the fix goes wrong

Two of these are easy to believe, so they come first. The short ones follow.

**1. Treating the lock as a guarantee.** You take the lock, check that you still hold it, and then write. It looks safe: nobody else can hold the lock at the same time. But the check and the write are two steps, and a pause can fall between them.

Take a lock with a 30 second expiry. Worker A gets the lock, then freezes for 40 seconds, for example in a long garbage-collection pause or because the virtual machine was paused. At 30 seconds the lock expires. Worker B takes it and writes its result. At 40 seconds A wakes up. Nothing told it the time passed, so it still believes it holds the lock, and it writes. A's old result replaces B's newer one.

**What to do instead.** Do not rely on the lock alone. Make the resource refuse the stale write, as in Fix 1. A fencing token does it: B holds token 34, so when A sends token 33, the database sees that 33 is lower than 34 and rejects it. Where tokens are not possible, use a database constraint or an idempotent write, so a second run does no harm. The lock then only reduces duplicate work, and the resource guarantees correctness.

**2. Renewing the lock from a thread that freezes too.** Another idea is to extend the expiry while the work runs, with a background renewal thread. That helps with a slow job. It does not help with a frozen process. A pause that stops the worker usually stops the renewal thread too, because both live in the same process. The lock expires anyway, as in the case above. Renewal is fine for long jobs, but it is not a safety net, so the resource still has to check.

Smaller traps:

- **Clock jumps.** The Redis documentation notes that Redis does not use a monotonic clock for TTL expiry, so a wall-clock shift can let two processes hold the lock. Set up time sync carefully.
- **Treating the lock as a guarantee.** A lock with an expiry is a best-effort tool. If a double run causes real harm, the resource must check, using tokens, constraints, or idempotency.
- **Token from the wrong place.** A counter that can go backward after a failover is not a fencing token.
- **Lock key without an owner check.** Releasing with plain `DEL` can delete someone else's lock.

## Which should you use?

| Situation | Reach for |
|---|---|
| Duplicate work only wastes time | **A simple Redis lock** with owner-checked release |
| Work ends in your own database | **A unique constraint** or row lock in the same transaction |
| A stale write would corrupt data | **Fencing tokens** checked by the resource |
| Jobs can run twice safely | **Idempotent work**, with the lock as an optimization |
| Long jobs | **Short leases with renewal**, plus one of the above |

If you are not sure, assume a double run will happen someday, and make the second run harmless.

## The takeaway

1. A lock inside one process cannot stop a second server, so the lock must live in a shared place.
2. A lock needs an **expiry** to survive crashes, and expiry lets a **paused** worker keep acting after it lost the lock.
3. A **fencing token** lets the resource refuse writes from a stale holder.
4. Prefer a **database constraint**, a **lease with renewal**, or **idempotent work** when they fit.
5. Treat a distributed lock as an **optimization**, not a guarantee, unless the resource checks it.
