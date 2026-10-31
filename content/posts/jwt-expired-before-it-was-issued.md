---
title: Why a token can expire before it was issued: clock drift
date: 2026-11-01
description: Servers disagree about the time, so valid tokens get rejected at random. How to spot it and fix it.
tags: authentication, JWT, debugging
draft: true
---

## The doubt

Valid tokens are rejected at random, and the error says the token is expired or not valid yet. The token is fresh. What is going on?

## What to study

- Recap: exp and iat claims are timestamps
- What a clock is, and why two machines never agree exactly
- Failure case: Server A issues, Server B thinks it is the past
- Diagnose by comparing the time on each server
- Fixes: time sync (NTP), a small allowed leeway
- Builds on the JWT section of the sessions post
