---
title: Distributed systems failures: locks, split brain, outbox
description: Distributed systems problems explained by what fails: locks that expire, two leaders after a network split, and writes that reach a database but not a queue.
---

Once a system runs on more than one machine, things that were simple stop being simple. A lock can expire while its owner is still working, two servers can both believe they are the leader, and a write can succeed in one place and fail in another with nothing to tell you.

This page collects posts on these problems and the patterns used to survive them: distributed locks and fencing tokens, split brain after a network partition, and the outbox pattern for keeping a database and a message queue in step.

Each post begins with a failure you could see in production, explains the ideas behind it without academic language, and shows how the fix works and what it assumes. Several of them also say where the fix is not enough.

Read it if you work with more than one service or server and want to know why simple-looking designs fail in surprising ways.
