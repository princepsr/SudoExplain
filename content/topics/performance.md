---
title: Slow application performance: find the real bottleneck
description: Why requests get slow and how to find what is actually waiting: queries, connection pools, threads, memory pauses and timeouts, measured before any fix.
---

"The app is slow" is a symptom, not a cause. The wait might be a query, a pool with no free connections, a thread stuck behind a lock, a memory pause or a slow downstream service. These posts teach you to find which one before you change anything.

**What you will learn**

- How to measure where time goes, instead of guessing
- Why tail latency (the slowest few percent of requests) is what users complain about
- How slow queries, exhausted pools, garbage collection pauses and unbounded queues each look in practice
- How to check that a fix actually moved the numbers

**How it helps you**

You avoid the most expensive mistake in performance work: fixing the wrong thing. Each post shows the symptom, the measurement that confirms the cause, and what each fix costs, so you can choose with evidence.

**Who it is for**

Anyone who has been told "make it faster" and wants a method, not a list of tips. Examples are mostly Java and SQL, but the method applies to any stack.
