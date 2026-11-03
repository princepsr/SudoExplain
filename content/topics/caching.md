---
title: Caching problems: stale data, stampedes and fixes
description: How caches go wrong in production: stale data, two servers disagreeing, cache stampedes and bad invalidation, with how to confirm the cause and fix it.
---

A cache makes a system fast by keeping a copy of data somewhere closer. That same copy is the source of its worst bugs. It can be out of date, different on each server, or gone at the moment a thousand requests need it.

This page collects posts on the failures that come with caching: users seeing old data after an update, two servers giving different answers, a popular entry expiring and sending every request to the database at once, and the old saying that cache invalidation is one of the hard problems in computing.

Each post starts from something you can observe, explains what the cache is actually doing, and shows how to confirm the cause. Then it compares the fixes, including when a fix creates a new problem, for example a shorter expiry that causes a stampede.

Read it if you use Redis, a CDN, a browser cache or an in-memory cache and want to know why the data you see is not the data you expect.
