---
title: API problems: retries, pagination and rate limits
description: API design problems explained from real failures: double charges from retries, slow or skipping pagination, rate limiting, lost updates and access control gaps.
---

An API that works for one client in a test behaves differently when thousands call it, retry it and page through it. These posts explain why, and how to build APIs that survive real clients.

**What you will learn**

- How retries cause double charges, and how idempotency keys make them safe
- Why page 400 is slow and skips rows, and when keyset pagination fixes it
- How rate limiting works, from fixed windows to token buckets
- How two clients overwrite each other, and how optimistic locking prevents it
- How a missing access check lets one user read another's data

**How it helps you**

You stop designing for the happy path. Each post shows the failure first, so you can spot the same weakness in your own API during design or code review, before a client finds it.

**Who it is for**

Developers who build or call HTTP APIs and want them to hold up under retries, load and mistakes. No prior experience with large systems is needed.
