---
title: Messaging and Kafka problems: rebalances, retries, poison
description: Message queue and Kafka problems explained: consumer rebalances, poison messages, duplicate delivery and events lost between a database and a queue.
---

Queues decouple services, until one of them stops reading. A single bad message blocks everything behind it, consumers keep rebalancing and processing stalls, messages are delivered twice, or a database change commits and its event never reaches the queue.

This page collects posts on these failures in Kafka and other message brokers. They cover consumer groups and rebalances, poison messages and dead-letter queues, retries and duplicates, and the gap between writing to a database and publishing an event.

Each post explains how the queue works underneath, in plain language, then shows what the failure looks like in lag graphs and logs and how to confirm the cause. It ends with the fixes, including where a fix trades one problem for another.

Read it if your services talk through queues or event streams and you want to know what happens when messages stop flowing.
