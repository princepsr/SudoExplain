---
title: Integer ID overflow: when the primary key runs out
date: 2026-11-01
description: Why inserts suddenly fail when an auto-increment INT primary key hits 2147483647, how to check your headroom, and how to move to bigint safely.
tags: databases, java
draft: true
---

## The question

On a quiet Tuesday, every attempt to create an order starts failing. The error mentions a sequence, or a duplicate key. The database is healthy, disk is fine, and nothing was deployed.

Someone counts the rows in the `orders` table: 410 million. That is nowhere near the 2 billion everyone remembers as "the limit."

> Why did the primary key run out when the table is only a fifth full?

The id counter does not count rows. It counts every id it has ever handed out, including ids for inserts that failed.

> [!SUMMARY]
> By the end you will know:
>
> 1. The exact limits of a 32-bit integer, signed and unsigned
> 2. How sequences and auto-increment columns hand out ids, and why they leave **gaps**
> 3. How to **check your headroom** before it hits zero
> 4. How to fix it with `bigint`, and the traps in Java, JavaScript, and other tables

## First, how ids are handed out

A **primary key** is the column that identifies each row. Most tables let the database generate it: an **auto-increment** column in MySQL, or a **sequence** in PostgreSQL (what `serial` creates behind the scenes). Both are a counter. Each new row asks the counter for the next number.

A 32-bit integer uses 32 bits (binary digits) of storage. **Signed** means one bit marks negative numbers, so the largest value is 2^31 − 1 = **2,147,483,647**. **Unsigned** (MySQL only) uses all 32 bits for size, so the largest is 2^32 − 1 = **4,294,967,295**.

The counter is a ticket machine at a deli. Tickets are never returned to the machine, even when a customer leaves. The line gets gaps, and the machine runs out sooner than the number of customers suggests.

## The failure: ids are used up, not just used

The counter must be fast and must not block concurrent inserts. So it never takes a number back. If the insert that received the number fails, the number is gone:

```diagram
type: sequence
alt: An insert gets id 101 from the sequence but fails, so the next insert gets 102 and id 101 is never used.
caption: Figure 1. A failed insert still burns its id, so ids run out faster than rows are stored.
actors: App | Sequence | Table
App -> Sequence: give me the next id (101)
App -> Table: INSERT id 101 ... duplicate email
Table -x App: insert rejected
note Sequence: 101 is not given back !
App -> Sequence: give me the next id (102)
```

PostgreSQL documents this: the value from `nextval` is not reclaimed if the calling transaction aborts, so "gapless" sequences cannot be built from sequences. MySQL says the same for InnoDB: if a transaction that generated auto-increment values rolls back, those values are lost and are not reused.

Other sources of gaps: `INSERT ... ON CONFLICT` in PostgreSQL computes the id before it detects the conflict. MySQL's `INSERT ... ON DUPLICATE KEY UPDATE` can allocate a value it never uses. Bulk inserts in MySQL can overestimate how many ids they need.

Now do the arithmetic. Say an app retries a rejected insert, and on average 3 of every 4 attempts fail and roll back. Each real row then costs 4 ids:

```text
real rows: 500,000,000
ids used : 500,000,000 x 4 = 2,000,000,000
limit    : 2,147,483,647
```

Half a billion rows is enough to be at the edge. Even without failures, a table that takes 1,000 inserts per second reaches the limit in 2,147,483,647 / 1,000 seconds, which is about 25 days.

```diagram
type: flow
alt: Failed inserts and rollbacks use ids, the counter reaches the limit, and the next insert fails.
caption: Figure 2. The counter, not the row count, decides when inserts stop.
Inserts and retries draw ids -> Failed attempts burn ids -> Counter reaches 2147483647 -> Next insert fails !
```

## What the error looks like

Exact wording depends on the database and version. In PostgreSQL, a sequence of type `integer` that is exhausted raises this error (the format comes from the PostgreSQL source; the sequence name is made up):

```text
ERROR:  nextval: reached maximum value of sequence "orders_id_seq" (2147483647)
```

Inserting an explicit value above the limit into an `integer` column raises `integer out of range`. In MySQL, the manual says that when an `AUTO_INCREMENT` integer column runs out of values, a subsequent insert returns a duplicate-key error. It also says the behavior is undefined past the maximum of the type. So expect something like a duplicate entry error on the largest id, rather than a friendly "out of ids" message.

## The same bug in Java and JavaScript

The database is not the only place that holds an id. In Java, an `int` that passes its maximum **wraps around silently**, with no error:

```java
int id = Integer.MAX_VALUE;
System.out.println("max int      = " + id);
id = id + 1;                         // wraps, no error
System.out.println("max int + 1  = " + id);
long big = Integer.MAX_VALUE;
System.out.println("as long + 1  = " + (big + 1));
try {
    Math.addExact(Integer.MAX_VALUE, 1);  // throws instead of wrapping
} catch (ArithmeticException e) {
    System.out.println("addExact     = " + e.getMessage());
}
long wide = 3_000_000_000L;
System.out.println("(int) 3000000000 = " + (int) wide);
```

Real output from a run on Java 21:

```text
max int      = 2147483647
max int + 1  = -2147483648
as long + 1  = 2147483648
addExact     = integer overflow
(int) 3000000000 = -1294967296
```

A negative id then flows through the code like any other value. A `long` has 64 bits, with a maximum of 9,223,372,036,854,775,807, so use it everywhere an id appears: fields, method parameters, `Map` keys, and generated columns.

JavaScript has a different limit. Its numbers are 64-bit floating point, and whole numbers are exact only up to 2^53 − 1, which is `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991). Above that, values silently lose precision. Running `JSON.parse('{"id":9007199254740993}').id` in Node prints `9007199254740992`, which is a different id. If your ids can pass 2^53, send them to browsers as **strings**.

## How to diagnose it

**1. Check the sequence in PostgreSQL.** The `pg_sequences` view shows each sequence's type, last value, and maximum:

```sql
SELECT sequencename, data_type, last_value, max_value,
       round(100.0 * last_value / max_value, 1) AS pct_used
FROM pg_sequences
ORDER BY pct_used DESC NULLS LAST;
```

`last_value` is NULL for a sequence that has not been used, that you may not read, or that is unlogged and viewed on a standby. If caching is configured, it can be ahead of the last id handed out.

**2. Check the table in MySQL.** `information_schema.TABLES` has an `AUTO_INCREMENT` column with the next value. In MySQL 8.0 and later these values may be cached for a while. The cache time is set by `information_schema_stats_expiry`, so check its default in the manual for your version. Run `ANALYZE TABLE` first, or set that variable to 0 for the session or server:

```sql
SELECT TABLE_NAME, AUTO_INCREMENT
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'shop'
ORDER BY AUTO_INCREMENT DESC;
```

Compare each value to the limit of the column's type, shown in `COLUMN_TYPE` in `information_schema.COLUMNS`. A column typed `int unsigned` has the higher limit.

**3. Find the other copies.** Search for columns that hold the id: foreign keys in other tables, history and audit tables, message payloads, and caches.

## Fix 1: use bigint

The real fix is a bigger type. `bigint` holds up to 9,223,372,036,854,775,807, which at 1,000 ids per second lasts about 292 million years. In PostgreSQL, new tables can use `bigint generated always as identity`, or `bigserial`. In MySQL, use `BIGINT UNSIGNED AUTO_INCREMENT` when the key is never negative.

## Fix 2: migrate an existing huge table

Changing the type in place is a table rewrite. In MySQL, the manual says changing a column data type is supported only with `ALGORITHM=COPY`, which rebuilds the table and blocks concurrent writes. In PostgreSQL, `ALTER COLUMN ... TYPE bigint` also rewrites the table under a strong lock. For a large busy table, that is an outage. Use the steps from [the zero-downtime migration post](/posts/zero-downtime-migration/):

1. Add a nullable `id_big bigint` column.
2. Keep it in sync for new rows, using a trigger or code that writes both.
3. Backfill old rows in small batches.
4. Build a unique index on it concurrently, then switch the primary key over in a short step.
5. Do the same for every foreign key column that points at the id.

Start this long before the counter is close to the limit. The copy and backfill steps take days on a big table, and the counter keeps moving the whole time.

## Fix 3: alert early

Run the headroom queries daily and alert at 50 percent, and again at 70. At 50 percent you have time to schedule the work calmly. At 90 percent you are working during an incident. Alert on the rate too: if the table grows faster than expected, the dates move closer.

## When the fix goes wrong

The type change is easy to start and easy to leave half done. Three gaps matter most.

**1. The sequence is still `integer`.** You run `ALTER TABLE orders ALTER COLUMN id TYPE bigint`. The column now says `bigint`, so the job looks finished. But in PostgreSQL the counter is a separate object, the sequence, and a `serial` column created it as `integer`. Changing the column does not change the sequence. Its maximum stays at 2,147,483,647, and the next insert after that fails with `nextval: reached maximum value of sequence`, even though the column could hold far more.

**What to do instead.** After the column change, look at the sequence itself. The `data_type` and `max_value` columns of `pg_sequences` show what it really allows. If it is still `integer`, run `ALTER SEQUENCE orders_id_seq AS bigint`. PostgreSQL then raises the maximum to the `bigint` limit, as long as the old maximum was the default one for `integer`. Check `pg_sequences` again to confirm.

**2. Foreign keys elsewhere are still `int`.** A **foreign key** is a column in one table that stores the id of a row in another table. Say `order_items.order_id` is an `int` and points at `orders.id`. The day `orders` hands out id 2,147,483,648, the order itself is stored fine. Then the code inserts its first item, and the database rejects the value with `integer out of range`. Every new order now fails halfway.

The same happens wherever a copy of the id lives: history tables, audit tables, message payloads, search indexes, other services. Any 32-bit field breaks at the same moment.

**What to do instead.** Make a list of every place that stores the id, and ask each owner. Widen the child columns and the other systems first, and the parent table last. A wider child can already hold small ids, so nothing breaks during the change. A narrow child cannot hold a big parent id.

**3. JavaScript clients.** After the move to `bigint`, the API starts sending ids as JSON numbers, and a browser or Node client reads them as 64-bit floating point numbers. Those are exact only up to 2^53 − 1. Above that, two different ids can become the same number. `9007199254740993` and `9007199254740992` both read back as `9007199254740992` (checked in Node). A user may then open the wrong record. Nothing throws an error.

**What to do instead.** Send ids as strings in JSON: `"id": "9007199254740993"`. A string is copied as it is, with no rounding. The client should treat the id as an opaque label and never do arithmetic on it. Do this before ids get large, because the change is a breaking one for existing clients.

The smaller ones:

- **ORMs mapping to Integer.** In Java, an entity field typed `Integer` cannot hold a big id. Change it to `Long`, and check generated DTOs and API clients.
- **Fixing the type but not the rate.** If failed retries burn most of the ids, find out why they fail. See [the race conditions post](/posts/race-condition-check-then-act/) for one common cause.

## Which should you use?

| Situation | Reach for |
|---|---|
| New table | **`bigint`** from the start |
| Existing table under 50 percent | **Alerts**, and a planned migration |
| Existing table over 70 percent | **Expand and contract** migration, soon |
| Ids sent to browsers | **Strings** in JSON |
| Java code with ids | **`long`** everywhere, and `Math.addExact` where wrap-around would hurt |

If you are not sure how much headroom you have, run the diagnostic query today. It takes one minute.

## The takeaway

1. A signed 32-bit key stops at **2,147,483,647**, and an unsigned one at **4,294,967,295**.
2. Counters **never take ids back**, so failed inserts and rollbacks use them up, and gaps are normal.
3. **Check headroom** with `pg_sequences` or `information_schema.TABLES`, and alert at 50 and 70 percent.
4. Use **`bigint`** everywhere the id appears: other tables, `long` in Java, strings in JSON.
5. Migrate large tables in **steps**, because an in-place type change rewrites the table.
