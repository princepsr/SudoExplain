---
title: Debugging production problems, step by step
description: How to find the cause of real production problems: reading logs, metrics and dumps, and telling a symptom from its cause.
---

Production problems are hard to debug because you cannot stop the system and look around. You have logs, metrics, and whatever tools are already installed.

The posts below start from a real symptom, such as an error code you cannot explain or a service that restarts every few minutes. They walk through the evidence to collect, how to read it, and how to confirm a cause before changing anything.

Each one ends with the fixes and when they go wrong, so you leave with both the method and the answer.
