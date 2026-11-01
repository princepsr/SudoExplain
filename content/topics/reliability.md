---
title: Reliability problems explained from real failures
description: Cascading failures, retries, timeouts, failover and split brain, explained from what went wrong to how to prevent it.
---

Reliability is about what happens when something goes wrong, because something always does. A slow dependency, a lost network link or a bad deploy should hurt a little, not take everything down.

The posts below start from an outage pattern, explain how it spreads from one small fault, and show how to spot it and contain it. Each one compares the fixes and explains when a fix makes things worse.

The aim is to give you a picture of the failure in your head, so you can recognise it in your own system before it happens at night.
