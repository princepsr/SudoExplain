---
title: Why uploaded files vanish when you add a second server
date: 2026-11-01
description: A file saved on one server is missing on the next request. Why it happens and how shared storage fixes it.
tags: storage, system-design, scaling
draft: true
---

## The doubt

A user uploads a photo and sees it. On the next request the photo is gone, but only sometimes. It works on my laptop.

## What to study

- Why a server's own disk is private, just like its memory
- Failure case: upload lands on Server A, next request hits Server B
- Diagnose with the X-Served-By header
- Fixes: shared file storage, object storage, a shared network disk
- Link back to the sessions and stale cache posts: same family of bug
