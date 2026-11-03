---
title: Authentication problems: sessions, JWTs and login bugs
description: Login and token problems explained: sessions that break behind a load balancer, JWT clock skew and not yet valid errors, and how sessions and tokens differ.
---

Login works on your laptop. In production users are logged out at random, valid tokens are rejected, or the same request succeeds on one server and fails on another. These bugs look like security problems but are usually problems of state and time.

This page collects posts on how authentication behaves once a system has more than one server: where sessions are stored, what a JWT really contains, why clocks that disagree by a few seconds reject valid tokens, and what changes when you add a load balancer.

Each post starts with a symptom, explains sessions and tokens from the basics, shows how to confirm the cause from headers, cookies and logs, and compares the fixes and their trade-offs. They are written so a complete beginner can follow.

Read it if you build login or API authentication and want to understand it well enough to debug it.
