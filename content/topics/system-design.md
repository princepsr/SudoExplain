---
title: System design in practice: how designs fail in production
description: System design explained through failures: sessions, caches, queues, retries and consistency, and what each design choice costs once real traffic arrives.
---

System design is usually taught as boxes and arrows: a load balancer, an app server, a cache, a database. The diagram looks complete, then production shows what it left out. A session that lived in one server's memory, a cache that goes stale, or a retry that doubles the load on a struggling service.

This page collects posts that explain a design choice by showing how it fails. Each starts from a symptom, explains the parts involved from the basics, and shows how the problem appears in a running system. They then compare the common fixes and the trade-off each one makes, such as speed against consistency or simplicity against safety.

You do not need to have designed a large system before. The point is to learn why designs have the shape they do, because every box and arrow exists to prevent a specific failure.

Read it if you are learning system design, or preparing to explain your own design choices to a team or in an interview.
