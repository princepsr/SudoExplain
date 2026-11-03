---
title: Application security bugs: IDOR, injection and secrets
description: Common application security bugs explained for developers: broken access control, SQL injection, XSS, leaked secrets and token mistakes, and how to fix them.
---

Most security incidents in everyday applications are not clever attacks. A user changes an ID in a URL and sees someone else's data. A quote typed into a login form changes the meaning of a query. A password committed to Git sits in the history for years.

This page collects posts on these ordinary mistakes: broken access control (IDOR), SQL injection, cross-site scripting (XSS), leaked secrets, token and session mistakes, and the newer problem of prompt injection in AI features. Each one starts from a realistic example and shows how the mistake can be used against an application.

Then it shows how to find the same bug in your own code and how to fix it, including how a half-fix can still be bypassed. The posts explain defence for developers who build and review their own systems.

Read it if you write backend or web code and want to recognise these bugs in a code review before they reach production.
