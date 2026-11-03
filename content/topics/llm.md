---
title: LLM application problems: hallucinations, cost and prompts
description: What goes wrong when you build with LLMs: hallucinations, wrong RAG answers, prompt injection, runaway agents and surprise token bills, with fixes.
---

An LLM demo works on the first try. In production the same feature invents facts, answers from the wrong document, follows instructions hidden in a web page, or runs up a bill while looping through tools. None of it shows up as an error.

This page collects posts on what breaks when a language model becomes part of a real product: hallucinations and how to validate output, retrieval (RAG) that fetches the wrong text, prompt injection, agents that call tools without limits, and token costs that grow much faster than expected.

Each post explains the idea behind the failure in plain language, shows how to detect it with logs and tests you can run, and compares the fixes. Where a fix only reduces the risk, the post says so.

Read it if you are adding an LLM to an application and want to know what it will do when real users and real data arrive.
