---
title: Scaling problems: load balancers, autoscaling and limits
description: What breaks when a system grows from one server to many: sessions behind load balancers, stale caches, autoscaling that reacts late, retries and rate limits.
---

Everything works with one server. Add a second behind a load balancer and users are logged out, servers disagree on data, or a scheduled job runs twice. These posts explain what changes when a system grows, and why.

**What you will learn**

- Why sessions break behind a load balancer, and the options for fixing it
- How caches on different servers become stale and inconsistent
- Why autoscaling that reacts late still lets a traffic spike cause an outage
- How to stop a job running on every server at once
- How rate limits and read replicas help, and what they cost

**How it helps you**

You learn the one idea behind most of these failures: state that used to live in one place now lives in several, and the copies disagree. Once you see that, you can predict scaling problems in a design before they reach production.

**Who it is for**

Developers moving from one server to several, or whose system behaves differently under load than in testing. Each post explains the basics first.
