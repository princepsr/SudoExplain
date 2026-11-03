---
title: "Spring @Scheduled job runs twice on multiple servers"
date: 2026-11-01
description: Why a nightly job fires once per server after you scale out, how to confirm it, and how to make sure it runs exactly once.
tags: scaling, backend, java, spring-boot
draft: true
---

## The question

A nightly job sends a summary email to every customer. It ran perfectly for a year. Then the team scaled the service from one server to three to handle more traffic. The next morning every customer had **three** identical emails.

The code did not change. The schedule did not change.

> I only changed how many servers run the app. Why did the job run three times?

Because the schedule lives **inside** the application, and so there is one copy of it in every server.

Imagine giving the same sticky note, "email everyone at 2 a.m.", to one employee, and then hiring two more and handing each a copy. All three act on it.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why scheduled tasks multiply when a service is scaled out
> 2. Four more ways a job runs twice: deploys, overlapping runs, restarts and extra environments
> 3. How to **diagnose** it from logs
> 4. How to make a job run once: a lock, a single scheduler or an external trigger

## First, where the schedule lives

In most frameworks, a scheduled task is just code in the application. In Spring, with scheduling switched on by `@EnableScheduling`:

```java
@Scheduled(cron = "0 0 2 * * *")      // every day at 02:00
public void sendNightlySummary() {
    // ...
}
```

The `cron` text is a compact schedule: seconds, minutes, hours, day, month, weekday. Each running **instance** of the application (one running copy) has its own scheduler that reads this line. The scheduler does not know that other instances exist. It only knows the time.

With one server, that is one job. With three servers, **all three schedulers fire at 02:00**, and the work happens three times. The servers are copies. The schedule was copied along with them.

```diagram
type: sequence
alt: Three app instances each fire the same schedule at 02:00 and each sends the summary email.
caption: Figure 1. Every copy of the app has its own clock and its own schedule.
actors: App 1 | App 2 | App 3 | Email
note all: all three schedulers fire at 02:00
App 1 -> Email: send nightly summary
App 2 -> Email: send nightly summary !
App 3 -> Email: send nightly summary !
```

## More ways to get a double run

Scaling is the obvious cause. These are quieter:

- **A rolling deploy.** A **rolling deploy** replaces old copies with new ones a few at a time. While it runs, old and new versions are both up. If the job's time falls in that window, both fire.
- **A job that outlasts its interval.** If the method hands its work to another thread, for example with `@Async`, a `fixedRate` run that takes longer than its interval can pile up, because the scheduler thinks the first run already finished. Otherwise Spring queues late runs and starts them late, even with several scheduler threads. `fixedDelay` avoids the pile-up as long as the method does its work on the scheduler thread.
- **A restart that replays.** Some schedulers, Quartz for example, can run a missed job at startup ("catch up"). A crash loop can then run it repeatedly.
- **A scheduler in every environment.** A staging copy pointing at the production database sends the same emails.

## How to diagnose it

**1. Check the logs for the start time.** Search for the job's log line across all servers. If the same job starts within the same second on three hosts, the schedules are duplicated:

```text
02:00:00.012  host=app-1  Starting nightly summary
02:00:00.015  host=app-2  Starting nightly summary
02:00:00.021  host=app-3  Starting nightly summary
```

**2. Compare the count to the number of servers.** Check how many instances were running, for example with `kubectl get pods`. If the number of duplicates equals the number of instances, it is the schedule. If it is irregular, think deploys and restarts.

**3. Check what changed.** Did the instance count change? Was there a deploy at that time?

**4. Look at the data.** Duplicate rows, duplicate emails or doubled totals with timestamps inside the same second all confirm it.

## Fix 1: let only one instance take the job (a database lock)

Make instances compete for a **lock** that lives in the database, which they all share. Only the winner runs the job. The lock row is inserted once at setup:

```sql
UPDATE job_locks
SET locked_by = 'app-2', locked_until = now() + interval '10 minutes'
WHERE name = 'nightly-summary'
  AND locked_until < now();
-- rows affected: 1 -> I hold the lock, run the job
-- rows affected: 0 -> another instance has it, skip
```

The single conditional `UPDATE` is **atomic**, meaning it happens as one indivisible step, so only one instance can win. It is the same idea as the coupon example in [the race conditions post](/posts/race-condition-check-then-act/).

```diagram
type: sequence
alt: Two instances try to take the same lock row; the first gets one row updated and runs, the second gets zero and skips.
caption: Figure 2. One conditional update decides the winner.
actors: App 1 | App 2 | Database
App 1 -> Database: UPDATE lock row
Database --> App 1: 1 row, you hold it
App 2 -> Database: UPDATE lock row
Database --> App 2: 0 rows, skip the job
```

In Java, the ShedLock library does this for you. It needs three things beyond the annotation: `@EnableSchedulerLock(defaultLockAtMostFor = "10m")` on a configuration class, a `LockProvider` bean, and a `shedlock` table in your database. Its table uses the columns `name`, `lock_until`, `locked_at` and `locked_by`, not the ones in the SQL above.

```java
@Scheduled(cron = "0 0 2 * * *")
@SchedulerLock(name = "nightlySummary", lockAtMostFor = "PT30M", lockAtLeastFor = "PT1M")
public void sendNightlySummary() {
    // runs on one instance only
}
```

`lockAtMostFor` is a safety net: if the winner crashes, the lock expires after 30 minutes anyway. `lockAtLeastFor` stops another instance from re-running the job the moment it finishes, if clocks differ slightly.

The JDBC lock provider can be told to use the database's clock instead of each server's clock. Turn that on, for the reason given under "Comparing local clocks" below.

## Fix 2: run the scheduler in one place

Move scheduled work out of the web servers. Run a separate deployment with **one** copy that does only scheduled jobs. Or use an **external scheduler**, such as a Kubernetes `CronJob` or a cloud scheduler, that starts one run at the right time:

```yaml
apiVersion: batch/v1
kind: CronJob
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid       # never start a run while another is running
  # jobTemplate omitted: it describes the container to run
```

Without a `timeZone`, a `CronJob` reads its schedule in the controller manager's local time zone, which is frequently UTC but not guaranteed. Set `spec.timeZone` (stable since Kubernetes 1.27) to be explicit. [The time zones post](/posts/time-zones-off-by-one-day/) shows why that matters.

This is simple and clear. The cost is a **single point of failure**, one part whose failure stops the whole job: if that one instance is down at 02:00, the job does not run unless something starts it.

## Fix 3: make the job safe to run twice

Locks reduce duplicates, but they cannot guarantee exactly one. A lock can expire while a slow job is still running. So also make the **work** idempotent: doing it twice has the same effect as doing it once, as in [the double charge post](/posts/idempotency-key-double-charge/). Each unit of work is claimed or recorded, and a second run finds nothing left to do.

```sql
-- inside one transaction: each instance takes different rows
SELECT id FROM pending_emails
WHERE sent = false
ORDER BY id
LIMIT 100
FOR UPDATE SKIP LOCKED;
-- then mark the rows as sent and commit
```

`FOR UPDATE SKIP LOCKED` lets several workers share a table of work without colliding, because a row locked by one is skipped by the others. It needs an open transaction to hold the locks.

Be careful about sending the email inside that transaction. It holds row locks during slow network calls, and an email cannot be rolled back. A crash after sending but before the commit sends it again. Marking rows as "claimed" first, or using the email provider's own duplicate protection, narrows that gap.

## When the fix goes wrong

A lock is only as good as its timing. These are the two ways it most often lets a second run in.

**1. A lock that expires before the job ends.** A lock must expire, or a crashed instance would block the job forever. So you give it a time limit, such as 10 minutes. It looks safe, because normal runs take 3 minutes.

Then one night the table is bigger and the job takes 15 minutes. At minute 10 the lock expires, while the first instance is still working. A second instance takes the lock and starts the job. For the last 5 minutes, both are running, and every customer can get two emails. The ShedLock documentation warns about exactly this: if a task runs longer than `lockAtMostFor`, it can be executed more than once.

**What to do instead.** Set the time limit well above your slowest real run. Then also make the work idempotent (running it twice has the same effect as once), as in Fix 3, because a long enough run can always outlast any limit. Log how long each run takes, so you see it growing before it passes the limit.

**2. Comparing local clocks.** The lock stores a time, `locked_until`. Each instance decides whether the lock is free by comparing that time with its own clock. Clocks on different servers are never exactly equal.

Say the lock lasts 1 minute. Server A takes it at 02:00:00 by its clock, so `locked_until` is 02:01:00. Server B's clock is 90 seconds fast. At that same moment it reads 02:01:30, which is later than 02:01:00, so B decides the lock has expired and runs the job too. With a 10-minute lock, the clocks would have to differ by more than 10 minutes, so this hurts most with short locks and badly set clocks. But nobody notices it until it happens.

**What to do instead.** Let the database be the only clock. In the SQL above, `now()` runs on the database server, so every instance is compared against the same time. The JDBC lock provider in ShedLock has an option to use the database time too.

Smaller pitfalls:

- **A lock that is never released.** With a very long `lockAtMostFor`, a crash can block the job for hours. Choose a value that is long enough for a normal run and no longer.
- **A single scheduler instance that dies.** One copy means no duplicates but also no backup. Make sure something restarts it, and alert if the job is missed.
- **Trusting the external scheduler fully.** The Kubernetes documentation says a `CronJob` creates a Job about once per scheduled time, and in some cases two Jobs are created, or none. Idempotent work and a missed-run alert are still needed.

## Which should you use?

| Situation | Reach for |
|---|---|
| A job inside a service that scales out | **A database lock** (ShedLock or similar), or a clustered scheduler such as Quartz |
| Heavy or long-running jobs | **A separate worker or external scheduler,** run once |
| Work that can be split into rows | **Claim rows** with `SKIP LOCKED`, so it also scales |
| Anything that sends email or moves money | **Idempotent work,** whatever else you use |
| You are not sure | **Lock plus idempotent work.** Two guards beat one |

If you are not sure, assume the job will sometimes run twice, and ask what harm that would do. If the answer is "customers get two emails", fix the work, not just the schedule.

## The takeaway

1. A scheduled task in application code exists in **every instance**, so scaling out multiplies it.
2. Deploys, overlapping runs and restarts can also cause a second run.
3. The signature is the **same job starting within the same second** on several hosts.
4. Fix it with a **database lock**, a **single scheduler**, or an **external trigger**.
5. No lock is perfect, so also make the job **idempotent**: a second run should find nothing left to do.
