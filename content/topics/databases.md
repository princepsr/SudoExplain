---
title: Database performance problems: slow queries to deadlocks
description: Why database queries get slow in production and how to fix them: missing indexes, deadlocks, lock waits, replica lag and risky migrations, with EXPLAIN.
---

The query was instant in development. A few months and a few million rows later, the same page takes four seconds and the database CPU stays high. Nothing in the code changed, which is why these failures are so confusing.

This page collects posts on database problems that only appear with real data and real traffic: missing indexes, queries an ORM multiplies without you noticing, transactions that block each other, replicas that serve old data, and migrations that lock a table while users wait.

The examples use PostgreSQL and MySQL, and each post says where the two behave differently. You will learn to read an `EXPLAIN` plan, to spot a lock wait, and to tell whether a fix helps by measuring the query before and after.

Read it if you write SQL or use an ORM and want to understand why a database slows down, and what each common fix costs.
