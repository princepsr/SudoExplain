---
title: Why a retry can charge a customer twice
date: 2026-11-01
description: How a network timeout leads to a double payment, and how idempotency keys make retries safe.
tags: reliability, apis, system-design
draft: true
---

## The doubt

The network timed out, so the app tried again, and the customer was charged twice. Why did a safe-looking retry cause harm?

## What to study

- What a timeout really tells you (you do not know if it worked)
- Failure case: request succeeds but the reply is lost
- What idempotent means, in plain words
- Fix: idempotency keys, with pseudocode
- Which operations are safe to retry
