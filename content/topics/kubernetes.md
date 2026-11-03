---
title: Kubernetes problems: CrashLoopBackOff, probes, autoscaling
description: Kubernetes problems explained from the symptom: pods that keep restarting, health probes that break deploys, OOMKilled containers and autoscaling that is too late.
---

Kubernetes tells you very little when something goes wrong. A pod says `CrashLoopBackOff`, a deploy briefly returns errors, a container disappears with exit code 137, or a traffic spike hits before the new pods are ready. The status is a label, not an explanation.

This page collects posts that start from those messages and work out what is really happening. They cover pods that restart in a loop, the difference between readiness and liveness probes, containers killed for using too much memory, and autoscalers that react after the damage is done.

Each post explains the Kubernetes idea behind the symptom in plain language, shows the exact `kubectl` commands that confirm the cause, and compares the fixes, including the ones that make things worse.

Read it if you run applications on Kubernetes, or are about to, and want to understand what the cluster is doing when it says no.
