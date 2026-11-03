---
title: Concurrency bugs: race conditions, deadlocks, lost updates
description: Concurrency bugs explained with real failures: race conditions, thread and database deadlocks, lost updates and thread pools, and how to find and fix each one.
---

Concurrency bugs are the ones that vanish when you try to reproduce them. Two requests read the same value and both write back, two threads each wait for the other, or a balance ends up wrong once in ten thousand requests. Tests pass, production fails.

This page collects posts on these bugs in the places they actually occur: threads inside one Java process, transactions inside a database, and several servers sharing one resource. They cover race conditions, deadlocks, lost updates, optimistic and pessimistic locking, thread pool queues and locks across servers.

Each post builds the problem in a small example you can follow, shows how to catch it with a thread dump, a database lock view or a log, and compares the fixes and what each costs in speed and complexity.

Read it if your code handles more than one request at a time and you want to know why it sometimes gets the wrong answer.
