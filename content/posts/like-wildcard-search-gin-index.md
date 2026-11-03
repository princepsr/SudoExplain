---
title: "Slow LIKE '%text%' search: fix it with a GIN index"
date: 2026-11-02
description: A search box using LIKE '%word%' scans the whole table and ignores your index. Learn why, and how a PostgreSQL GIN index with pg_trgm fixes it.
tags: databases, performance, sql
draft: true
---

## The question

A customer search box runs this query:

```sql
SELECT * FROM customers WHERE name LIKE '%smith%';
```

There is an index on `name`, yet the query reads the whole table and takes seconds on 5 million rows.

> Why does the index not help, and what kind of index does?

## Why a normal index cannot help

A normal index (a B-tree) is sorted from the first letter. It can jump to every name that starts with "Smi", like a phone book. It cannot jump to every name that *contains* "smith", because that text can sit anywhere in the name. The database has to read every row.

(To write: the `'smith%'` case, where a prefix search can use the index, and why it needs the right operator class or collation.)

## How a GIN index fixes it

(To write, with a small worked example.)

1. Trigrams: `pg_trgm` cuts every name into 3-letter pieces. "smith" becomes "smi", "mit", "ith" (the real extension also pads the edges).
2. A **GIN** index (generalized inverted index) stores, for each piece, the list of rows that contain it. Like the index at the back of a book.
3. Searching `'%smith%'` looks up each piece and keeps the rows that contain all of them.

```sql
CREATE EXTENSION pg_trgm;

CREATE INDEX idx_customers_name_trgm
    ON customers USING gin (name gin_trgm_ops);
```

## When the fix goes wrong

(To write, important pitfalls only.)

- Searches shorter than 3 characters cannot use trigrams well.
- GIN indexes are slower to update and bigger than a B-tree, so write-heavy tables pay more.
- Build it with `CREATE INDEX CONCURRENTLY` on a live table, as in the missing-index post.
- Real full-text search (`tsvector`) is a better fit when you search words, not fragments.

## The takeaway

(To write.)

<!-- TODO before publishing: verify every claim above against the PostgreSQL docs (pg_trgm, GIN, operator classes). Link to /posts/slow-query-missing-index/ and add the link back from its Fix 3 section, where "GIN index" is plain text today. -->
