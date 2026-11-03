---
title: Distributed systems failures: locks, split brain, outbox
description: Distributed systems problems explained by what fails: locks that expire, two leaders after a network split, and writes that reach a database but not a queue.
---

Why things that work on one machine break across many.

**You will learn**

- Locks that expire too early
- Two servers that both think they are the leader
- Keeping a database and a queue in sync

**Good for:** anyone working with several services or servers.
