---
title: Performance problems explained from real failures
description: Why requests get slow: queries, memory, threads, pools and timeouts, explained from the symptom to the measurement and the fix.
---

A slow system rarely has one obvious cause. A page can be slow because of a query, a full pool of connections, a pause for memory cleanup, or a downstream service that is answering slowly.

The posts below start from a symptom and teach you to measure before changing anything. Each one shows how to confirm the cause, then compares the fixes and what each costs.

The goal is a habit: find what is actually waiting, fix that, and check that the numbers moved.
