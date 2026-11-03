---
title: Networking problems: DNS, TLS and 502 errors
description: Web networking problems explained from the error: 502 Bad Gateway from timeout mismatches, DNS changes that do not take effect, and expired TLS certificates.
---

Some outages have nothing to do with your code. A 502 appears at random because a proxy reused a connection the app had already closed, a DNS change does not reach every user for hours, or a site goes down at midnight because a certificate expired.

This page collects posts on the network layer between users and your application: proxies such as nginx, DNS and TTLs, TLS certificates and how they expire, and the timeouts that decide when a connection is dropped. These are failures that look random until you know where to look.

Each post starts from the error message or behaviour, explains the moving parts in plain language, shows the commands that confirm the cause, such as `curl`, `dig` and `openssl`, and compares the fixes.

Read it if you deploy web services and want to understand what happens between the browser and your server.
