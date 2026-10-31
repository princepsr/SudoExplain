---
title: "CrashLoopBackOff: debug a pod that keeps restarting"
date: 2026-11-01
description: How to debug CrashLoopBackOff in Kubernetes: what the status means, how to read exit codes and previous logs, and how to fix each common cause.
tags: kubernetes, debugging, operations
draft: true
---

## The doubt

You deploy a new version. The pipeline is green, but the site does not change. You run `kubectl get pods` and the new pod says `CrashLoopBackOff`, with a restart count that grows every few minutes.

You run `kubectl logs` and get nothing, or one unhelpful line. The pod is clearly trying, yet it never works.

> "The pod keeps restarting and I cannot tell why. Where do I even look first?"

The status is a symptom, not a cause. It tells you a container started and then stopped, again and again. The cause is always something else, and a short checklist finds it quickly.

> [!SUMMARY]
> By the end you will know:
>
> 1. What **CrashLoopBackOff** really means, and why the waiting time grows
> 2. The five usual causes: a crash, bad configuration, a wrong command, a probe that kills a slow app, and out of memory
> 3. How to **diagnose** it in order, including how to read exit codes 1, 137 and 143
> 4. How to fix each cause, and the traps that waste an afternoon

## First, what Kubernetes is doing

A **pod** is the smallest unit Kubernetes runs: one or more **containers** (packaged processes) that share a network address. A component on each machine, the **kubelet**, starts the containers and watches them.

By default a pod has a restart policy of `Always`. If a container exits, for any reason, the kubelet starts it again. Restarting instantly forever would waste resources and flood logs, so the kubelet waits between attempts.

That wait is the **back-off**. The Kubernetes documentation says it grows exponentially: 10 seconds, 20 seconds, 40 seconds, and so on, capped at 300 seconds (5 minutes). The timer resets once a container has run for 10 minutes without problems.

`CrashLoopBackOff` is the status shown while the kubelet is waiting out one of those delays. Newer Kubernetes versions can shorten the delays: a kubelet setting for the maximum back-off (beta and on by default since 1.35) and an alpha feature gate that lowers the starting delay and the cap. Check the documentation for your version.

## The failure on a small case

Say your app reads a database address from an environment variable. Someone renames the variable in the config, and the app exits with an error right after it starts.

```diagram
type: sequence
alt: The kubelet starts a container, it exits with code 1, and the kubelet waits longer after each failure.
caption: Figure 1. Each crash makes the wait longer, so the pod looks frozen.
actors: Kubelet | Container
Kubelet -> Container: start
Container --> Kubelet: exit code 1 !
note Kubelet: wait 10 s, then start again
Container --> Kubelet: exit code 1 !
note Kubelet: wait 20 s, then 40 s, up to 5 min
```

Between attempts the container does not exist as a running process. That is why `kubectl exec` fails and why the logs look empty: you are asking about a process that is currently not running.

## The usual causes

Almost every crash loop is one of these:

- **The application crashes on startup.** An unhandled exception, a port already in use, or a failed connection to a database it needs at boot.
- **Bad configuration.** An empty environment variable, a wrong file path, or a malformed config file. A Secret that does not exist at all gives a different status, `CreateContainerConfigError`, but an empty or wrong value still crashes the app.
- **A wrong command or image.** The container's command points at a file that is not in the image. A wrong image name gives `ImagePullBackOff` instead, which is a different problem.
- **A liveness probe that kills a healthy app.** The probe fails while the app is still starting, so Kubernetes kills it. See [the readiness and liveness post](/posts/readiness-vs-liveness-probes/).
- **Out of memory.** The container exceeds its memory limit and the system kills it. See [the OOMKilled post](/posts/java-docker-oomkilled/).

## How to diagnose it

Work in this order. Each step narrows the cause.

**1. See the status and the restart count.**

```bash
kubectl get pods
```

```text
NAME                   READY   STATUS             RESTARTS      AGE
orders-5d8c7b6f-x2k9p  0/1     CrashLoopBackOff   6 (2m ago)    11m
```

This output is illustrative. `READY 0/1` means no containers are ready. The `(2m ago)` is the time of the last restart.

**2. Describe the pod and read the Last State.**

```bash
kubectl describe pod orders-5d8c7b6f-x2k9p
```

```text
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
    Restart Count:  6
```

Also illustrative. `Last State` describes the previous run, which is what you need. `State` only shows that the kubelet is waiting. Look at `Reason` and `Exit Code` first, then scroll to the `Events` section at the bottom.

**3. Read the logs of the previous run.**

```bash
kubectl logs orders-5d8c7b6f-x2k9p --previous
```

The `--previous` flag shows the output of the last terminated container. Without it you see the current container, which is usually brand new and silent. Add `-c <name>` if the pod has several containers.

**4. Read the events.**

```bash
kubectl get events --field-selector involvedObject.name=orders-5d8c7b6f-x2k9p
```

Look for `Liveness probe failed`, `Back-off restarting failed container`, or errors about mounting a volume or a Secret.

### What the exit code tells you

An **exit code** is a number a process returns when it stops. Zero means success. By Unix convention, a code above 128 means "killed by signal number (code minus 128)".

| Exit code | Meaning | Usual cause |
|---|---|---|
| 1 | The app exited with a general error | An exception or bad config; read the logs |
| 126 or 127 | The shell could not run the command, or did not find it | Wrong command or missing file in the image (if the runtime cannot start the process at all, `describe` shows `StartError` or `RunContainerError` instead) |
| 137 | Killed by signal 9 (128 + 9) | Out of memory, or force-killed after a shutdown timeout |
| 143 | Ended by signal 15 (128 + 15) | A normal stop request, such as a liveness failure or a deploy |

A **signal** is a message the operating system sends to a process. Signal 15 asks it to stop politely. Signal 9 cannot be refused. Code 137 with `Reason: OOMKilled` is an out-of-memory kill. Code 137 without it can also mean the container ignored the polite request and was force-killed.

### When there is nothing to read

If the app dies before it prints anything, copy the pod with a shell as its command, so you can look inside:

```bash
kubectl debug orders-5d8c7b6f-x2k9p -it --copy-to=orders-debug --container=app -- sh
```

This creates a copy of the pod (the Kubernetes documentation uses this form) with a shell instead of your command. The `kubectl debug` command can also attach an **ephemeral container**, a temporary extra container, to a running pod with `--image` and `--target`. That is stable since Kubernetes 1.25, but the pod must be running, so the copy approach suits a crashing one better.

> [!WARNING]
> Try this on a test cluster. Deleting pods in production changes live traffic. By default, `kubectl debug --copy-to` drops the original labels and probes, so the copy gets no Service traffic. If you add `--keep-labels`, the copy can match a Service and receive requests. Delete the copy when you are done.

## Fix 1: fix the crash itself

**What it is:** the logs from `--previous` usually name the problem: a missing variable, a refused connection, a port in use.

**How it works:** change the config or the code, then roll out again. For a missing setting, check the variable names inside the pod spec against what the app reads. Print the effective values at startup, with secrets masked.

**What it costs:** nothing extra, but the loop is slow. Each retry waits up to five minutes. If a Deployment manages the pod, deleting it creates a replacement with a fresh back-off timer, which skips the wait.

## Fix 2: repair the command or the image

**What it is:** the container's `command` or `args` in the pod spec override the image's defaults, and a typo there fails every time.

**How it works:** exit code 127 (when a shell runs the command), or `StartError` with an error like `executable file not found`, points here. Run the same image locally with `docker run --rm -it --entrypoint sh <image>` and try the command by hand. Check the file really exists and is executable.

**What it costs:** a little time. Pin the image by digest so what you tested is what runs (see the traps below).

## Fix 3: make probes patient, and give memory room

**What it is:** if `describe` shows `Liveness probe failed` right before each restart, the probe is the killer, not the app. If it shows `OOMKilled`, memory is.

**How it works:** for slow starters, add a **startup probe**, which holds back the liveness probe until the app has started once:

```yaml
startupProbe:
  httpGet: { path: /health, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30     # up to 150 seconds to start
livenessProbe:
  httpGet: { path: /health, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 3
```

For memory, raise the limit or lower the app's use, as the OOMKilled post explains.

**What it costs:** a longer wait before a truly stuck app is restarted, and more memory reserved on the cluster.

## When the fix goes wrong

- **Reading only the current logs.** A container that just restarted has almost no output. Always add `--previous`.
- **A restart count that hides an OOM kill.** The count only says "many restarts". Check `Last State` for `OOMKilled`, because the application logs show nothing when the system kills a process.
- **No startup probe on a slow app.** The liveness probe fires before the app is ready, kills it, and the loop starts over.
- **Changing the image tag but not the digest.** A tag such as `1.4` can point to different content over time, and nodes may reuse a cached copy. A **digest** (`image@sha256:...`) names exact content.
- **Fixing the wrong pod.** A Deployment recreates pods from its template. Edit the Deployment, not the pod.
- **Restart policy `Never`.** A pod with it does not restart at all, so you will see `Error`, not a loop.

## Which should you use?

| Symptom | First thing to check |
|---|---|
| Exit code 1, error in `--previous` logs | Application or configuration |
| Exit code 127 or "not found" | Command, args and image contents |
| `Liveness probe failed` in events | Probe settings, add a startup probe |
| `OOMKilled`, exit code 137 | Memory limit and app memory use |
| Empty logs, instant exit | `kubectl debug --copy-to` with a shell |

If you are not sure, run `kubectl describe pod` and read `Last State` and `Events` before anything else. Those two sections answer most of the questions.

## The takeaway

1. **CrashLoopBackOff** means a container keeps exiting and the kubelet waits longer between restarts, up to five minutes.
2. The status is a **symptom**. The cause is a crash, bad configuration, a wrong command, a probe, or memory.
3. Diagnose in order: `get pods`, `describe` (Last State and Exit Code), `logs --previous`, then events.
4. Exit **137** often means killed for memory, **143** means asked to stop, and **1** means the app failed on its own.
5. Fix the cause, add a **startup probe** for slow starts, and pin images by **digest**.
