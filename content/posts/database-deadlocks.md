---
title: Database deadlocks: two transactions waiting on each other
date: 2026-11-01
description: Why a database sometimes aborts a transaction with a deadlock error under load, how to read the evidence, and how consistent lock order and retries fix it.
tags: databases, concurrency, sql
draft: true
---

## The doubt

Under load, a few requests fail with an error such as this:

```text
ERROR: deadlock detected
DETAIL: Process 4127 waits for ShareLock on transaction 9183; blocked by process 4131.
        Process 4131 waits for ShareLock on transaction 9179; blocked by process 4127.
```

Retrying the same request works. It never happens in testing, and it seems random.

> Why would a database kill my transaction when nothing is broken?

Two transactions each hold something the other one needs, and neither can continue. The database picks one to abort, to free the other.

> [!SUMMARY]
> By the end you will know:
>
> 1. How transactions lock rows, and how two of them can wait on each other forever
> 2. The most common cause: the same rows locked in a different order
> 3. How to **diagnose** a deadlock from the database's own report
> 4. How to prevent it with consistent ordering, shorter transactions and retries

## First, locks inside a transaction

A **transaction** is a group of statements that succeed or fail together, such as taking money out of account A and putting it into account B. When a transaction updates a row, the database **locks** that row until the transaction finishes (commits or rolls back). Any other transaction that wants the same row has to wait.

This is what keeps data consistent, and most of the time the waits are short and nobody notices. Waiting is harmless on its own. It becomes a problem when waiting forms a **circle**.

Picture two people at a narrow door, each holding a pen the other needs to sign the form. Each waits politely for the other to hand over the pen first, so nobody signs. A deadlock is that standoff. The difference is that a database can end it by sending one person away.

## The failure: a circle of waiting

Two people transfer money at the same moment, one from account A to B, the other from B to A:

```diagram
type: sequence
alt: Transaction 1 locks account A and transaction 2 locks account B, then each waits for the other's account.
caption: Figure 1. Each transaction holds one lock and waits for the other's. Neither can ever move.
actors: Txn 1 | Txn 2 | Account A | Account B
Txn 1 -> Account A: lock A (granted)
Txn 2 -> Account B: lock B (granted)
Txn 1 -> Account B: lock B ... waits
Txn 2 -> Account A: lock A ... waits
note all: circle: both wait forever !
```

Transaction 1 holds A and wants B. Transaction 2 holds B and wants A. Neither can ever proceed. The database detects the circle and **aborts one transaction**, called the **victim**, with a deadlock error. The other then continues.

How long detection takes depends on the database. PostgreSQL checks only after a transaction has waited `deadlock_timeout`, which is 1 second by default. InnoDB (the MySQL storage engine) detects deadlocks automatically by default and rolls back one transaction.

The code that causes it often looks perfectly reasonable:

```java
@Transactional
void transfer(long from, long to, long amount) {
    Account a = accounts.lockById(from);     // SELECT ... FOR UPDATE
    Account b = accounts.lockById(to);       // SELECT ... FOR UPDATE
    a.withdraw(amount);
    b.deposit(amount);
}
```

The rows are locked in the order the **arguments** arrive. Two transfers in opposite directions lock them in opposite orders.

## Other ways to get one

- **Different code paths touching the same tables in different orders.** One method updates `orders` then `inventory`, another updates `inventory` then `orders`.
- **Batch updates in no particular order.** Two jobs each update rows 1 to 1,000 in whatever order the query returns, which may differ.
- **Long transactions.** The longer locks are held, the more likely a circle forms.
- **Missing indexes in InnoDB.** Under its default isolation level, InnoDB locks the index records it **scans**, not only those it changes. A slow, unindexed update locks far more rows than it needs to. PostgreSQL does not do this.
- **Gap locks in InnoDB.** To prevent new rows appearing in a range, InnoDB can lock the gap between rows. Two transactions inserting into the same range can then deadlock even though they touch different rows.
- **Foreign keys in PostgreSQL.** Inserting a child row takes a light lock on the parent row it points to. Many children of the same parent, mixed with updates to that parent, can form a circle.

## How to diagnose it

**1. Read the database's report.** It says who waited for whom, with the queries involved. PostgreSQL writes it to the server log. Setting `log_lock_waits = on` also logs any wait longer than `deadlock_timeout`, which shows trouble before it becomes a deadlock. In MySQL InnoDB, run:

```sql
SHOW ENGINE INNODB STATUS;
-- see the section "LATEST DETECTED DEADLOCK"
```

This shows only the **latest** deadlock, and needs the `PROCESS` privilege. To write every deadlock to the error log, set `innodb_print_all_deadlocks=ON`. Find the two statements. Almost always, they touch the same rows in opposite order.

**2. Look at who is blocked right now.** A deadlock clears in about a second, so this rarely catches one. It does show ordinary blocking. In PostgreSQL:

```sql
SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type, state, query
FROM pg_stat_activity
WHERE wait_event_type = 'Lock';
```

In MySQL, the `sys.innodb_lock_waits` view shows the same thing.

**3. Find both code paths.** Search the codebase for the two statements in the report. Compare the order in which they lock tables and rows.

**4. Reproduce with two clients.** Open two database sessions and run the two sequences by hand, interleaved, as in the diagram above.

## Fix 1: always lock in the same order

If every transaction takes locks in one agreed order, a circle cannot form. For accounts, lock the **lower ID first**, whatever the direction of the transfer:

```java
@Transactional
void transfer(long from, long to, long amount) {
    long first  = Math.min(from, to);
    long second = Math.max(from, to);
    Account a = accounts.lockById(first);
    Account b = accounts.lockById(second);
    Account src = (from == first) ? a : b;    // a and b are in lock order, not in money order
    Account dst = (src == a) ? b : a;
    src.withdraw(amount);
    dst.deposit(amount);
}
```

For batch work, lock the rows in sorted order first, then update. In PostgreSQL:

```sql
WITH locked AS (
    SELECT id FROM accounts WHERE id IN (3, 9, 12) ORDER BY id FOR UPDATE
)
UPDATE accounts SET balance = balance + 10
FROM locked WHERE accounts.id = locked.id;
```

PostgreSQL's documentation warns that at the default isolation level (READ COMMITTED), `ORDER BY` with `FOR UPDATE` can return rows out of order if the ordering columns change while the query waits for a lock. Order by a value that never changes, such as `id`, keep the locking query simple, and check the `SELECT` documentation for your version.

## Fix 2: keep transactions short, and lock less

- Do slow work (remote calls, file operations) **outside** the transaction.
- Where you can, replace "read, then write" with a **single statement** that does both, so there is less to lock and nothing to get stuck between:

```sql
UPDATE accounts SET balance = balance - 50
WHERE id = 7 AND balance >= 50;
```

Check that one row was affected. Zero rows means the balance was too low. This helps for a single row. A transfer still updates two rows, so it still needs the fixed order from Fix 1.

- In InnoDB, index the columns you filter on, so the database locks only the rows it needs.

## Fix 3: be ready to retry

Even careful systems still hit deadlocks occasionally. The database aborts one transaction **safely**, and it expects the application to try again. Treat the deadlock error as retryable:

```java
// This loop lives OUTSIDE the @Transactional method, in a different bean.
for (int attempt = 1; attempt <= 3; attempt++) {
    try {
        transferService.transfer(from, to, amount);   // each call is a fresh transaction
        return;
    } catch (PessimisticLockingFailureException e) {  // plain JDBC: DeadlockLoserDataAccessException; JPA/Hibernate: CannotAcquireLockException
        if (attempt == 3) throw e;
        sleepWithJitter(attempt);                     // placeholder: a short, random pause
    }
}
```

The loop must sit outside the transaction. After a deadlock the transaction is already aborted, so retrying inside it cannot work. It must also call `transfer` through another bean, so that Spring's `@Transactional` proxy applies. Spring Retry's `@Retryable` does the same job with an annotation.

The underlying SQL state is `40P01` for PostgreSQL's deadlock and `40001` for serialization failures and MySQL deadlocks. Whether your stack maps it to the exception above depends on the driver and JPA provider, so test it by forcing a deadlock once.

## When the fix goes wrong

- **Retrying without limit.** A tight infinite retry loop makes contention worse. Cap the attempts and add a random pause.
- **Retrying work that has side effects.** If the transaction also sent an email or called a payment API, a retry repeats it. Keep side effects out of the retried block, or make them idempotent (safe to run twice). The [retries and idempotency post](/posts/idempotency-key-double-charge/) explains how.
- **Ordering inside a method but not across them.** Locking by ID in `transfer()` does not help if another method locks the same accounts in a different order. The order must be a **team rule**.
- **Confusing a deadlock with a lock timeout.** "Lock wait timeout exceeded" in MySQL means someone held a lock for too long. PostgreSQL has a similar `lock_timeout` setting. It is a different problem, usually a long transaction.
- **Higher isolation levels.** `SERIALIZABLE` prevents more anomalies but can raise the number of conflicts, reported as serialization failures. Use it knowingly.
- **A hot row.** If thousands of transactions update the same row, such as a global counter, they queue up behind each other. Spread the counter across several rows, or move it elsewhere.

## Which should you use?

| Situation | Reach for |
|---|---|
| Two rows locked together | **A fixed order,** such as lowest ID first |
| Batch updates | **Sort the rows** before locking or updating |
| Read-then-write on one row | **One atomic `UPDATE`** with a condition |
| A rare deadlock remains | **A bounded retry** with a short random pause |
| Long transactions | **Move slow work outside,** and keep the transaction minimal |

If you are not sure, read the deadlock report first. It names the two statements, and the fix is nearly always to make them lock in the same order.

## The takeaway

1. A transaction **locks the rows it changes** until it ends. Others wait.
2. A **deadlock** is a circle of waiting: each holds what the other needs. The database aborts one transaction to break it.
3. The usual cause is **the same rows locked in different orders** by different transactions.
4. Diagnose with the **deadlock report** in the logs, which shows both statements.
5. Prevent it with a **consistent lock order**, short transactions and single-statement updates, and **retry** the rare ones that remain.
