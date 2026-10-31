---
title: How a database index makes queries fast
date: 2026-11-01
description: Why one query takes seconds and another takes milliseconds, explained with the index at the back of a book.
tags: databases, performance, sql
draft: true
---

## The doubt

The same query is slow on a big table. Someone adds an index and it becomes instant. What is an index?

## What to study

- Full table scan: reading every row
- Index analogy: the back of a book
- What an index costs (writes and space)
- Reading a query plan
- Failure case: an index that is never used
