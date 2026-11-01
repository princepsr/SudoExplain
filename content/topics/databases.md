---
title: Database problems explained from real production failures
description: Slow queries, deadlocks, lock waits, risky migrations and replication lag, explained from the symptom to the diagnosis and the fix.
---

A database is shared by every request your system handles, so one bad query or one long lock can slow down everything else. These failures are often hard to see, because the database itself keeps running.

The posts below start from a symptom, such as a page that gets slower as data grows or a migration that blocks writes. They show how to confirm the cause, what the fixes are, and what each fix can break.

The examples use common relational databases, and each post says where the behaviour differs between products.
