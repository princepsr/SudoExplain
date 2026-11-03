---
title: Java production problems: memory, threads and pools
description: Java and Spring Boot problems in production: memory leaks, thread pools, connection pools, GC pauses and slow queries, from symptom to measured fix.
---

A Java service that ran fine for weeks starts to crawl. Memory climbs until the container is killed, requests time out while the CPU sits idle, or a page that took 50 ms now takes ten seconds. The code did not change. Traffic did.

This page collects posts on the failures that appear when a Java or Spring Boot application meets real load: leaked connections and exhausted pools, threads waiting on each other, queries multiplied by an ORM, and a JVM that pauses to clean up memory. You will meet errors such as `OutOfMemoryError`, `Connection is not available` and exit code 137.

Each post starts with the symptom, explains the few Java and Spring concepts you need in plain language, and shows how to confirm the cause with tools you already have: a thread dump, a heap dump, GC logs and the query log.

Read it if you build or run Java services and want to find a problem by measuring, not by guessing.
