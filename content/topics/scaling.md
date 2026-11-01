---
title: Scaling problems explained from real production failures
description: Why systems fail when traffic grows: load balancers, autoscaling, retries, queues and limits, explained from the symptom to the fix.
---

Systems rarely fail at their average load. They fail when traffic spikes, when one slow part drags the rest down, or when the fix for one problem creates another.

The posts below start from a failure you may have seen, such as users logged out behind a load balancer or an autoscaler that reacts too late. Each one explains the basics first, shows how to confirm the cause, then compares the fixes and when each one goes wrong.

Adding more servers is only one tool. Many of these problems are fixed by changing how the servers share state, wait or retry.
