---
title: Why your app hangs under load: connection pool exhausted
date: 2026-11-01
description: Requests wait for database connections that never come back. How to recognise a drained pool and fix it.
tags: java, databases, performance
draft: true
---

## The doubt

The app works fine, then under load every request just hangs. No error, no crash. Why?

## What to study

- What a database connection is and why opening one is slow
- What a connection pool is (a shelf of reusable connections)
- Failure case: connections borrowed and never returned
- Diagnose with pool metrics and a thread dump
- Fixes: always return connections (try-with-resources in Java), size the pool, set timeouts
