---
title: Why every release logs all your users out
date: 2026-11-01
description: Sessions kept in memory vanish when a server restarts. Why it happens and how to deploy without logging anyone out.
tags: authentication, deployment, scaling
draft: true
---

## The doubt

Each time we release a new version, everyone has to log in again. Why?

## What to study

- Recap: a session lives in server memory
- Failure case: restart wipes the memory
- Diagnose by checking whether logouts line up with deploy times
- Fixes: shared session store, tokens, rolling restarts
- Builds on the sessions post
