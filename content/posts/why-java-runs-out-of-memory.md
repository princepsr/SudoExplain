---
title: Why does my Java app run out of memory?
date: 2026-11-01
description: Heap, garbage collection and memory leaks, with a short example you can run.
tags: java, memory, debugging
draft: true
---

## The doubt

My Java app crashes with OutOfMemoryError, but I never allocate that much. What fills the memory?

## What to study

- Stack vs heap, in plain words
- What garbage collection does
- Failure case: a growing collection that is never cleared
- Diagnose with a heap dump
- Fixes: remove references, bounded caches (link to the stale cache post)
