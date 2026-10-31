---
title: Slow SQL query: missing index, EXPLAIN and fixes
date: 2026-11-01
description: Why a query that was instant in testing takes seconds in production, how to read a query plan, and how indexes fix it, or quietly fail to.
tags: databases, performance, sql
draft: true
---

## The doubt

A page that lists a customer's orders was instant in development. Months later it takes four seconds, and the database CPU is high every time someone opens it. A colleague says "add an index", runs one command, and the page becomes instant again.

> Same query, same data, same database. What did an index change?

It changed how the database **finds** the rows. Without an index, it has to read all of them.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **full table scan** is and why it gets slower as data grows
> 2. How to **diagnose** a slow query by reading its query plan
> 3. How to create the right index, including multi-column ones
> 4. Why an index is sometimes ignored, and what indexes cost

## First, scan versus index

Think of a 500-page book with no index at the back. To find every mention of "Smith", you read all 500 pages. With an index, you look up "Smith" and turn straight to pages 12 and 340. A database table works the same way.

The query is simple:

```sql
SELECT * FROM orders WHERE customer_id = 42;
```

With no index on `customer_id`, the database has only one way to answer: read **every row** in the table and keep the ones that match. This is a **full table scan** (a *sequential scan* in PostgreSQL). With 1,000 rows, that is instant. With 10 million, it reads 10 million rows to return 15.

An **index** is a separate, sorted structure, usually a B-tree (a tree that keeps values in order, so a lookup takes a few steps), that maps a column's values to where the rows are. The database jumps straight to `customer_id = 42` and reads only those rows. The work no longer grows with the size of the table, only slowly with its depth.

```diagram
type: flow
alt: Without an index the database reads every row. With an index it jumps to the matching rows.
caption: Figure 1. The scan reads 10 million rows to find 15. The index lookup touches a handful.
Query: customer_id = 42 -> No index: read all 10M rows -> Keep 15, discard the rest !
```

## How to diagnose it

**1. Find the slow queries.** Turn on the slow-query log. In PostgreSQL, set `log_min_duration_statement = 500` (milliseconds). In MySQL, use `slow_query_log` and `long_query_time`. PostgreSQL's `pg_stat_statements` ranks queries by total time, but it is not on by default: it must be listed in `shared_preload_libraries` (which needs a server restart) and enabled with `CREATE EXTENSION pg_stat_statements;`. Often one or two queries account for most of the load.

**2. Ask the database how it runs the query.** `EXPLAIN ANALYZE` shows the **query plan** (the steps the database chose) and actually runs the query to measure it. Here is an illustrative PostgreSQL result before an index:

```text
Seq Scan on orders  (cost=0.00..250000.00 rows=12 width=64)
                    (actual time=0.1..4200.5 rows=15 loops=1)
  Filter: (customer_id = 42)
  Rows Removed by Filter: 9999985
Execution Time: 4201.2 ms
```

Three things to notice: **Seq Scan** on a big table, **Rows Removed by Filter** in the millions (it read them all and threw nearly all away), and an execution time in seconds. The `cost` numbers are the planner's own estimate in made-up units, so compare them only with each other. MySQL 8 also has `EXPLAIN ANALYZE`, but its output is a tree and looks different.

> [!WARNING]
> `EXPLAIN ANALYZE` really runs the statement. For an `UPDATE` or `DELETE`, the data changes. Wrap it so you can undo it: `BEGIN; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;`.

**3. Compare the estimate with reality.** Plans show the rows the database *expected* and the rows it *got*. A big gap, such as expecting 12 and getting 500,000, means its **statistics** (the database's notes on how values are spread in each table) are stale, and it may choose a bad plan. Running `ANALYZE` on the table refreshes them. This is a separate command from `EXPLAIN ANALYZE`, despite the shared word.

## Fix 1: create the index

```sql
-- PostgreSQL
CREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders (customer_id);
```

`CONCURRENTLY` builds the index without blocking writes to the table, which matters on a live system. Without it, inserts and updates wait while the index is built. It cannot be used inside a transaction block. It is also slower, because it scans the table twice.

The plan after the index:

```text
Index Scan using idx_orders_customer_id on orders
                    (actual time=0.03..0.09 rows=15 loops=1)
  Index Cond: (customer_id = 42)
Execution Time: 0.12 ms
```

From 4,201 ms to 0.12 ms, with no change to the query.

## Fix 2: match the index to the whole query

Real queries filter and sort on several columns:

```sql
SELECT * FROM orders
WHERE customer_id = 42 AND status = 'OPEN'
ORDER BY created_at DESC
LIMIT 20;
```

A **multi-column index** serves this in one pass, but **column order matters**. Put the columns you compare with `=` first, then the one you sort by:

```sql
CREATE INDEX idx_orders_customer_status_created
    ON orders (customer_id, status, created_at DESC);
```

An index works from the **left**. This one helps queries that filter on `customer_id`, or on `customer_id` and `status`. It usually cannot jump to the right place for `status` alone. Newer versions can use a skip scan (PostgreSQL 18 for B-tree indexes, MySQL 8.0.13 and later), but it only pays off when `customer_id` has few distinct values. MySQL also needs a covering index, a single table and a range condition on the later column, and PostgreSQL's planner decides by cost, so do not rely on it.

## Fix 3: write queries the index can use

An index is useless if the query hides the column from it. These all force a scan:

```sql
WHERE lower(email) = 'a@example.com'      -- function applied to the column
WHERE date(created_at) = '2026-03-01'     -- function applied to the column
WHERE name LIKE '%smith'                  -- leading wildcard
WHERE phone = 5551234                     -- phone is VARCHAR: MySQL converts every row
```

The last case is a **type mismatch**: a text column compared with a number. MySQL converts each stored value before comparing, so the index cannot be used. PostgreSQL raises an error instead, so the silent version usually comes from an application sending a parameter of the wrong type.

Rewrite so the column stands alone, or index the expression:

```sql
WHERE created_at >= '2026-03-01' AND created_at < '2026-03-02'    -- a range, index-friendly
CREATE INDEX idx_users_email_lower ON users (lower(email));       -- expression index
```

For a leading wildcard such as `LIKE '%smith'`, PostgreSQL's `pg_trgm` extension with a GIN index can help. Even `LIKE 'smith%'` needs a special operator class or collation to use a plain index in PostgreSQL.

## When the fix goes wrong

- **An index on a column where most rows share one value.** The **planner** (the part of the database that chooses how to run a query) prefers to scan when a match returns a large share of the table. For the rare value, a **partial index** helps: `CREATE INDEX ... ON orders (customer_id) WHERE status = 'OPEN'` stays small and fast.
- **Too many indexes.** Every index must be updated on every insert, update and delete, and takes disk space. A table with 15 indexes writes much slower than one with 3. In PostgreSQL, `SELECT relname, indexrelname, idx_scan FROM pg_stat_user_indexes WHERE idx_scan = 0;` lists indexes never used since the statistics were last reset. Check replicas and the reset date before you drop any. Never drop an index that backs a primary key or unique constraint, even if it shows no scans, because it enforces a rule.
- **Creating an index the unsafe way.** A plain `CREATE INDEX` on a big, busy table blocks writes for the whole build. Use `CONCURRENTLY` or your database's online option.
- **A failed concurrent build.** `CONCURRENTLY` can fail and leave an `INVALID` index behind. Drop it with `DROP INDEX CONCURRENTLY` and try again.
- **Migration tools.** Many tools run each migration inside a transaction, which makes `CONCURRENTLY` fail. Configure the migration to run outside one.
- **Wrong column order.** An index on `(status, customer_id)` usually does not help a query that only filters on `customer_id`.
- **The planner ignores it.** On small tables, or when most rows match, scanning is genuinely cheaper. Stale statistics can also mislead it. Check with `EXPLAIN`, never assume.
- **`SELECT *`.** Asking for every column forces a trip to the table for each row. Selecting only indexed columns can let the database answer from the index alone, called an **index-only scan**. PostgreSQL also needs a recent `VACUUM` for this to work.

## Which should you use?

| Situation | Reach for |
|---|---|
| Slow lookup by one column | **A single-column index** on it |
| Filter on several columns, plus sorting | **A multi-column index,** equality columns first, sort column last |
| A function in the `WHERE` clause | **Rewrite the condition,** or create an **expression index** |
| The plan shows a wildly wrong row estimate | **Run `ANALYZE`** to refresh statistics |
| A write-heavy table with many indexes | **Drop indexes** that queries never use |

If you are not sure, run `EXPLAIN ANALYZE` on the slow query first. The plan tells you what to do, and guessing at indexes can slow your writes for nothing.

## The takeaway

1. Without an index, the database **reads every row**, so the cost grows with the table. An index lets it jump to the matching rows.
2. A query that is fast on small data and slow on large data is most often a **missing index**. A bad plan from stale statistics, or [an N+1 pattern](/posts/n-plus-one-query-problem/), can look the same.
3. Diagnose with the slow-query log and **`EXPLAIN ANALYZE`**: look for a sequential scan and millions of rows removed.
4. Build indexes to fit the query: **equality columns first, sort column last**, and write conditions the index can use.
5. Indexes are not free: they slow writes and use space. Build them with `CONCURRENTLY` on live tables, and drop the ones nobody uses.
