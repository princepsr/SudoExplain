---
title: "Slow SQL query: find a missing index with EXPLAIN"
date: 2026-11-02
description: Your SQL query was fast in testing but takes seconds in production. Find out why, how to read EXPLAIN, and how to add an index that works.
tags: databases, performance, sql
---

## The question

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

## Full table scan versus index

Think of a 500-page book with no index at the back. To find every mention of "Smith", you read all 500 pages. With an index, you look up "Smith" and turn straight to pages 12 and 340. A database table works the same way.

The query is simple:

```sql
SELECT * FROM orders WHERE customer_id = 42;
```

With no index on `customer_id`, the database has only one way to answer: read **every row** in the table and keep the ones that match. This is a **full table scan** (a *sequential scan* in PostgreSQL). With 1,000 rows, that is instant. With 10 million, it reads 10 million rows to return the 15 orders that customer 42 has.

An **index** is a separate, sorted structure, usually a B-tree (a tree that keeps values in order, so a lookup takes a few steps), that maps a column's values to where the rows are. The database jumps straight to `customer_id = 42` and reads only those rows. The work no longer grows with the size of the table, only slowly with its depth.

```diagram
type: flow
alt: Without an index the database reads every row. With an index it jumps to the matching rows.
caption: Figure 1. The scan reads 10 million rows to find customer 42's 15 orders. The index lookup touches a handful.
Query: customer_id = 42 -> No index: read all 10M rows -> Keep 15 orders, discard the rest !
```

## Why the index is so much faster

Think of looking up a name in a phone book. You do not read from page one. You open the middle, see you are too early in the alphabet, and jump forward. Each jump throws away most of the remaining pages.

A B-tree index does the same, in levels. Each level is a short, sorted list of **directions**, like "ids 1 to 100: go this way". Start with a tiny example: customer ids 1 to 1,000, and lists of 10 directions each.

1. The **top level** has 10 directions: "ids 1 to 100 are down this branch, 101 to 200 down that one," and so on up to 1,000.
2. Inside the branch for 1 to 100, the **middle level** has 10 more directions: "1 to 10, 11 to 20, 21 to 30," and so on.
3. The **bottom level** holds the 10 exact ids of one range, each with the location of its rows in the table.

To find customer 42, the database picks the branch for 1 to 100, then the one for 41 to 50, then finds 42 in a list of 10. That is **3 small lists**, about 30 directions at most. Without the index it would read up to 1,000 rows.

```diagram
type: flow
alt: A lookup for customer 42 follows one branch per level and reaches its rows after three steps.
caption: Figure 2. A tiny index of 1,000 ids. Looking up customer 42 takes three steps.
Find 42 -> Top level: 1 to 100 is the first branch -> Middle level: 41 to 50 is the fifth branch -> Bottom level: 42 points to its rows !
```

Now grow the table. Each extra level multiplies the reach by 10. Four levels cover 10,000 ids, five cover 100,000. A thousand times more ids costs only 3 more steps, while a scan would read a thousand times more rows.

Real lists are bigger than 10. A typical one holds hundreds of directions (500 is a fair guess, depending on the column size). Three levels then reach 500 x 500 x 500 = 125 million rows. So the 10-million-row table from Figure 1 needs only about three steps, and so does a table ten times bigger.

That is the whole fix. The scan read 10 million rows, and the index reads three small lists and then the 15 matching orders.

## How to find a slow query and read EXPLAIN

**1. Find the slow queries.** Turn on the slow-query log. In PostgreSQL, set `log_min_duration_statement = 500`, which logs every query that takes longer than 500 milliseconds. `pg_stat_statements` is an extension, an add-on module that ships with PostgreSQL. It ranks queries by total time, but it is not on by default. First add its name to the `shared_preload_libraries` setting, which lists the extensions loaded when the server starts, and restart the server. Then enable it with `CREATE EXTENSION pg_stat_statements;`. Often one or two queries account for most of the load. If no single query is slow but one page runs hundreds of them, that is [the N+1 query problem](/posts/n-plus-one-query-problem/), not a missing index.

**2. Ask the database how it runs the query.** Put the word `EXPLAIN ANALYZE` in front of your query:

```sql
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 42;
```

The database does not return the orders. It runs the query, measures it, and prints its **query plan**: the steps it took to find the rows. Here is an illustrative result for our table with no index:

```text
Seq Scan on orders  (cost=0.00..250000.00 rows=12 width=64)
                    (actual time=0.1..4200.5 rows=15 loops=1)
  Filter: (customer_id = 42)
  Rows Removed by Filter: 9999985
Execution Time: 4201.2 ms
```

Read it from the top, one line at a time:

- **`Seq Scan on orders`:** the database read the `orders` table from start to end. This is the full table scan from earlier. On a big table, it is the warning sign.
- **`Filter: (customer_id = 42)`:** for each row, it checked whether `customer_id` is 42.
- **`Rows Removed by Filter: 9999985`:** it threw away almost 10 million rows. Only 15 matched (`rows=15`). This is the wasted work.
- **`Execution Time: 4201.2 ms`:** the whole query took about 4 seconds.

You can ignore the `cost` numbers for now. They are the database's own guess in made-up units, useful only for comparing plans with each other.

> [!WARNING]
> `EXPLAIN ANALYZE` really runs the statement. For an `UPDATE` or `DELETE`, the data changes. Wrap it so you can undo it: `BEGIN; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;`.

**3. Compare the estimate with reality.** The plan shows two row counts: how many rows the database *expected* (`rows=12` in the first line) and how many it *got* (`rows=15`). Here they are close, which is good.

Why check this? Before running a query, the database cannot know how many rows will match. It **guesses**, using **statistics** (its notes on how values are spread in each table), and picks the plan that looks cheapest for that guess. If the guess is wrong, the plan can be wrong too.

For example, suppose the notes are out of date and the database expects 12 rows, but 500,000 come back. A plan that is perfect for 12 rows can be very slow for 500,000. Adding an index will not fix that, because the real problem is the bad guess.

So a big gap between expected and actual rows tells you the statistics are stale. Running `ANALYZE` on the table refreshes them. This is a separate command from `EXPLAIN ANALYZE`, despite the shared word. If the two counts are close and you still see a `Seq Scan` on a big table, the index is what is missing.

## Fix 1: create the index

```sql
-- PostgreSQL
CREATE INDEX CONCURRENTLY idx_orders_customer_id
    ON orders (customer_id);
```

`CONCURRENTLY` builds the index without blocking writes to the table, which matters on a live system. Without it, inserts and updates wait while the index is built. On a busy table with a 5-minute build (illustrative), nobody can place an order, and the waiting requests can drain [the connection pool](/posts/connection-pool-exhausted/). The price is time: it reads the table twice and waits for running transactions to finish, so it takes longer than a plain `CREATE INDEX`. That is a fair trade on a live system. (It also has one catch, covered in "When the fix goes wrong".)

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

An index works from the **left**, like a phone book sorted by last name, then first name. You can look up "Smith", or "Smith, Anna", but not every "Anna" without reading the whole book. In the same way, this index helps queries that filter on `customer_id`, or on `customer_id` and `status`. It usually cannot help a query on `status` alone. PostgreSQL 18 can sometimes skip over the first column, but only when it has few distinct values, so do not rely on it.

## Fix 3: write the query so the index can be used

An index on `created_at` is sorted by the **stored** values. If your query changes the column first, the database cannot use that order.

```sql
-- the index cannot help: date() changes every value first
WHERE date(created_at) = '2026-03-01'
```

Think of the phone book again. It is sorted by name. If you ask for "everyone whose name has 5 letters", the book cannot help. You must read every entry and count. The database does the same here. `date()` turns each raw timestamp, such as `2026-03-01 14:25:09`, into a plain date, `2026-03-01`. The index holds the raw timestamps, not these dates, so the database must convert every row first and then compare.

Leave the column alone and compare it with a range instead:

```sql
-- the index can jump straight to this range
WHERE created_at >= '2026-03-01'
  AND created_at < '2026-03-02'
```

The same applies to `lower(email) = 'a@example.com'`. If you must query that way, create an index on the same expression:

```sql
CREATE INDEX idx_users_email_lower
    ON users (lower(email));
```

A search that starts with a wildcard, such as `name LIKE '%smith'`, has the same problem, because the index cannot jump to "anything ending in smith". That needs a different kind of index, a **GIN index** with PostgreSQL's `pg_trgm` extension, which we leave for another post.

## When the fix goes wrong

An index is not free, and it is not always used. These three cause the most surprises.

**1. A failed `CONCURRENTLY` build.** To avoid making inserts and updates wait while the index is built, you used `CONCURRENTLY`, so building on a live table feels safe. But the build can still fail halfway, for example because of a deadlock (two operations waiting on each other) or a duplicate value in a unique index.

When it fails, PostgreSQL does not clean up. It leaves a half-built index behind, marked **invalid**. The planner ignores an invalid index, so your query stays slow. Worse, every insert, update and delete still has to keep that useless index up to date. You pay the cost and get nothing back.

To spot it, run `d orders` in `psql`. It lists the table's indexes and marks the broken one `INVALID`. Remove it with `DROP INDEX CONCURRENTLY idx_orders_customer_id;`, which does not block writes, then run the build again.

One more trap comes from **migration tools**, the tools that apply your database changes (such as a new index) when you deploy. Many wrap each migration in a transaction, a group of steps that either all succeed or all roll back together. That is usually helpful, but `CONCURRENTLY` cannot run inside one. It does its work in several separate steps and waits for other running queries between them, so it cannot be rolled back as a single unit. If you try, PostgreSQL stops with an error, and your deploy fails.

The fix is to mark that one migration as "do not use a transaction". Most tools have an option for it: `executeInTransaction=false` in Flyway, `runInTransaction: false` in Liquibase, and `disable_ddl_transaction!` in Rails.

**2. Wrong column order.** Your query filters only on `customer_id`. A colleague builds the index as `(status, customer_id)`, because both columns appear in other queries. It looks fine: `customer_id` is in the index.

But Fix 2 showed that an index works from the left, so it is sorted by `status` first. Say `status` has 3 values: `NEW`, `OPEN` and `DONE`. The index then has three groups, and customer 42's orders are scattered, a few in each group. The database has no single place to jump to. It usually ignores the index and scans the whole table, so the page stays slow.

Build it as `(customer_id, status)` instead. Now all of customer 42's entries sit together. Either way, run `EXPLAIN` after creating any index, to confirm the database really uses it.

**3. An index on a column where most rows share one value.** Take a `status` column where 95% of 10 million orders are `DONE` (illustrative). Querying `status = 'DONE'` matches 9.5 million rows. Using the index means 9.5 million lookups, each followed by a read of the table. Reading the table once from start to end is cheaper, so the **planner** (the part of the database that chooses how to run a query) scans anyway. The index is never used, but it slows every write and uses disk.

The rare value is different. If only 1% of orders are `OPEN`, an index helps a lot for those. A **partial index** covers only those rows, so it stays small:

```sql
CREATE INDEX idx_orders_open
    ON orders (customer_id) WHERE status = 'OPEN';
```

The query must include `status = 'OPEN'`, or the database cannot use it.

Indexes like that cost you on every write. To find indexes that queries never use, PostgreSQL keeps a count of how often each one was used:

```sql
-- indexes never used since the statistics were last reset
SELECT relname, indexrelname
FROM pg_stat_user_indexes
WHERE idx_scan = 0;
```

Never drop an index that backs a primary key or unique constraint, even if it shows no uses, because it enforces a rule.

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
