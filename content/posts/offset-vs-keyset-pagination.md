---
title: Offset vs keyset pagination: skipped rows, slow pages
date: 2026-11-01
description: Why page 2 shows items from page 1, why page 5,000 takes seconds, and how keyset (cursor) pagination fixes both.
tags: databases, apis, performance
draft: true
---

## The doubt

A feed shows 20 items per page, with an infinite scroll. Users report two odd things. Sometimes the same item appears twice, and sometimes an item is never shown at all. Separately, the export job that walks through every page gets slower and slower, and page 5,000 takes several seconds.

> It is just "give me the next 20". Why does it duplicate, skip and slow down?

Because "page N" is defined as "skip the first (N-1) x 20 rows". That definition breaks when the data moves, and it costs more the deeper you go.

> [!SUMMARY]
> By the end you will know:
>
> 1. How `OFFSET` pagination works, and why it duplicates and skips rows
> 2. Why deep pages are slow
> 3. How to **diagnose** both from queries and plans
> 4. How **keyset (cursor) pagination** fixes them, and what it costs you

## First, how offset pagination works

The usual approach is simple:

```sql
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 0;       -- page 1
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 20;      -- page 2
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 100000;  -- page 5,001
```

`OFFSET 100000` means: find the rows in order, **count off and throw away the first 100,000**, and then return the next 20.

## Failure 1: the data moves while you read

Think of reading a stack of newspapers from the top, 20 at a time, while someone keeps adding new ones on top. When you come back for "the next 20", the stack has shifted and you see some papers again.

New items arrive at the top of a newest-first feed. A user reads page 1, and five new posts appear before they ask for page 2:

```diagram
type: sequence
alt: The user reads page 1, five new posts arrive, and page 2 then repeats five posts the user has already seen.
caption: Figure 1. Five new posts push everything down, so "skip 20" lands five rows too early.
actors: Client | Server
Client -> Server: page 1: skip 0
Server --> Client: posts 100 down to 81
note Server: 5 new posts arrive (101-105)
Client -> Server: page 2: skip 20
Server --> Client: posts 85 down to 66 !
note Client: 85 to 81 are repeats !
```

Everything shifted down by five, so "skip 20" now lands five rows too early. If rows are **deleted** instead, everything shifts the other way, and rows are **skipped** and never shown. The position of "row 21" is not fixed. It depends on what happened since you looked.

## Failure 2: deep pages are slow

The database cannot jump to row 100,000. It must produce them in order and discard them. The work grows with the offset:

```text
page 1       reads 20 rows
page 100     reads 2,000 rows
page 5,001   reads 100,020 rows, returns 20
```

A job that walks all pages reads each row, on average, about half as many times as there are pages. The whole export therefore costs time that grows with the **square** of the table size. It looks fine in testing and becomes a nightly problem at scale.

## Failure 3: ties in the sort order

If the `ORDER BY` column is not unique, for example many posts share the same `created_at` second, the order of tied rows is not guaranteed. With `LIMIT`, PostgreSQL can return tied rows in a different order on each run. That causes duplicates and gaps even without any new data.

## How to diagnose it

**1. For duplicates and gaps,** reproduce it: load page 1, insert a row, then load page 2 and compare. If you see an item from page 1 again, you have the shift problem.

**2. For slowness,** look at latency by page number. A steady climb as the page number rises is the signature. Then run the query with `EXPLAIN ANALYZE`. The plan reads offset-plus-limit rows, even with an index. In PostgreSQL it looks like this (illustrative):

```text
Limit  (actual time=90.4..90.5 rows=20 loops=1)
  ->  Index Scan Backward using idx_posts_created on posts
        (actual time=0.03..90.4 rows=100020 loops=1)
```

The `Limit` node returns 20 rows, but the scan below it read 100,020.

**3. Check for ties.** Count rows that share a sort value: `SELECT created_at, count(*) FROM posts GROUP BY created_at HAVING count(*) > 1;`. Any result means the order of those rows is not fixed.

## Fix: keyset (cursor) pagination

Instead of "skip N rows", say "give me the rows **after the last one I saw**". The client sends the last item's sort values, and the query uses them as a starting point:

```sql
SELECT * FROM posts
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

The first page has no cursor yet, so it runs the same query without the `WHERE` line. Two details make this work:

- The `ORDER BY` includes a **unique tie-breaker** (`id`), so the order is fully determined.
- An index on the same columns, `(created_at DESC, id DESC)`, lets the database jump straight to the starting point and read 20 rows, **whatever the page depth**.

Because the next page starts from a **position in the data**, not a count, new or deleted rows elsewhere do not shift it. No duplicates, no gaps. The row comparison is valid in PostgreSQL and MySQL. PostgreSQL's B-tree index can use it to start the scan. MySQL's manual says its optimizer is less likely to use an index when the row comparison does not cover a prefix of the index, and its own example used only the first column. Check with `EXPLAIN`, and if it does not range-scan on all the columns, use the expanded form shown below under mixed sort directions.

The API returns an **opaque cursor**, meaning a string the client passes back without reading or changing it. This hides the details:

```java
String encodeCursor(Post last) {
    // Keep the full precision of the column. Milliseconds would lose microseconds.
    String raw = last.createdAt().toString() + "|" + last.id();   // Instant.toString()
    return Base64.getUrlEncoder().withoutPadding()
                 .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
}
```

To know whether another page exists, ask the database for **one extra row**. Fetch 21 rows when the client wants 20. If you get 21, return 20 and a `next` cursor. If you get 20 or fewer, return `next: null`.

```text
GET /posts?limit=20
-> { "items": [...], "next": "MjAyNi0wMy0wMVQxMjowMDowMC4xMjM0NTZafDQyMQ" }

GET /posts?limit=20&cursor=MjAyNi0wMy0wMVQxMjowMDowMC4xMjM0NTZafDQyMQ
```

## What you give up

Keyset pagination is not free:

- **No jumping to page 37.** You can only go forward (and, with care, backward) from where you are. For feeds and exports, that is fine. For a table where people say "go to page 37", it is not.
- **A fixed, unique ordering.** You must sort by a stable key and always include the tie-breaker.
- **Counting is separate.** A total such as "1,243,000 results" needs `COUNT(*)`, which scans a lot. Often you can show "more results" without a total.
- **New items stay out of view.** Items added above your position do not appear until you start again from the top.

## When the fix goes wrong

These three skip rows without any error, so they are easy to miss.

**1. No tie-breaker.** A first try at keyset pagination sorts by `created_at` alone and asks for rows `WHERE created_at < :last`. It looks right, because "older than the last one I saw" sounds complete. But many rows can share one timestamp.

Take 5 posts, two per page. Post 5 is at 12:00:09, posts 4, 3 and 2 are all at 12:00:05, and post 1 is at 12:00:01. The database may order tied rows any way it likes, so page 1 happens to be post 5 and post 4. The cursor is 12:00:05. Page 2 asks for rows older than 12:00:05, so it returns post 1. Posts 3 and 2 are never shown, because they are not older than 12:00:05, they are equal to it.

Add the unique `id` to both the `ORDER BY` and the cursor, as in the Fix section. The cursor is then (12:00:05, post 4), and page 2 starts with post 3, then post 2.

**2. A cursor that loses precision.** The cursor is just text, so it is easy to cut it short. Say PostgreSQL stores `created_at` down to the microsecond, which is a millionth of a second, but your code keeps only milliseconds, a thousandth.

Post A is at 12:00:05.123456 and post B, older, is at 12:00:05.123100. Page 1 ends with A, and the cursor is cut to 12:00:05.123. Page 2 asks for rows before 12:00:05.123, and B is at .123100, which is **after** .123000. So B is skipped. Keep the full value in the cursor. In Java, `Instant.toString()` does this, as in the code above.

**3. Nullable sort columns.** Suppose you sort by `last_login`, and some users have never logged in, so the value is `NULL`. In SQL, comparing anything with `NULL` gives "unknown", not true, and a `WHERE` keeps only rows where the test is true. So after page 1, rows with `NULL` are never returned. A cursor taken from a `NULL` row returns nothing at all.

Sort by a column that is `NOT NULL`, such as the creation time, or give the column a default value. If you must keep `NULL`, handle it with its own condition in the `WHERE`.

Shorter ones:

- **Sorting by something that changes.** If you page by `updated_at` and rows are updated while someone reads, a row can move from a page you already read to one you have not, or vice versa. Prefer an immutable key such as creation time or ID.
- **An index that does not match the `ORDER BY`.** The query still works, but the database sorts everything on each page, and you have lost the speed advantage.
- **A trusted cursor.** If the cursor is plain data that clients edit, they can request odd positions. That is usually harmless, but validate the values and consider signing the cursor.
- **Mixed sort directions.** `ORDER BY a ASC, b DESC` cannot use the row comparison above, on any database, because a row comparison applies one direction to all columns. Expand it: `WHERE a > :a OR (a = :a AND b < :b)`.
- **Throwing offset away completely.** For a small admin table of a few hundred rows, offset is simple and fine. Choose the tool to match the size.

Frameworks can hide this. Spring Data's `Pageable` uses offset, and a `Page<T>` return type also runs a count query (`Slice<T>` and `List<T>` do not). Spring Data 3.1 and later has `Window` and `ScrollPosition.keyset()` for keyset-style scrolling on derived queries, so check the documentation for your version before writing your own.

## Which should you use?

| Situation | Reach for |
|---|---|
| Feeds, timelines, infinite scroll | **Keyset (cursor),** sorted by time plus `id` |
| Exports and jobs that walk all rows | **Keyset,** so each page costs the same |
| An admin table with "go to page N" and few rows | **Offset** is acceptable |
| You need a total count | **A separate count,** cached or approximate |
| Rows are added or removed while users page | **Keyset,** so positions do not shift |

If you are not sure, use keyset for anything public or large. Switching later means changing the API contract, which is harder than starting with it.

## The takeaway

1. **`OFFSET` pagination** means "skip N rows". It is simple and has two problems.
2. When data is added or removed between requests, rows **shift**, giving duplicates or gaps.
3. A deep offset makes the database **read and discard** every skipped row, so deep pages get slower.
4. Fix both with **keyset pagination**: "rows after the last one I saw", sorted by a stable key with a **unique tie-breaker** and a matching index.
5. The price is no jumping to arbitrary pages, and counting separately. For feeds and exports, that is a good trade.
