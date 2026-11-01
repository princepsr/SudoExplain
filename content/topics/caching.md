---
title: Caching explained through real production failures
description: How caches go wrong in production: stale data, stampedes and inconsistent servers, with the symptoms, the causes and the fixes.
---

A cache keeps a copy of data somewhere faster than the original. That one idea is the source of both its speed and its bugs, because a copy can fall out of date, and a popular copy can disappear at the worst moment.

The posts below start from a failure you can observe, such as two servers showing different data or a database overwhelmed when a popular key expires. Each one explains what a cache is doing, how to confirm the cause, and which fix suits which situation.

If you are new to the topic, read the first post for the basics, then the failure posts in any order.
