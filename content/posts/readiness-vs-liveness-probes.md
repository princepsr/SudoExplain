---
title: Readiness vs liveness probes: why deploys cause errors
date: 2026-11-01
description: Why a routine rolling deploy can cause errors or a restart loop, the difference between readiness and liveness checks, and how to shut down gracefully.
tags: scaling, deployment, reliability
draft: true
---

## The question

You deploy a new version with a rolling update, one instance at a time, so the site stays up. But for a few minutes, users get errors. Or, on another day, a short database slowdown makes **every** instance restart at once, and the site stays down much longer than the slowdown itself.

The old instances were healthy. The new ones passed their checks. Yet something in the process of replacing them broke the site.

> A rolling deploy is supposed to be safe. Where do the errors come from?

From the moment between "the process started" and "the process can actually serve", and from the moment between "told to stop" and "really stopped". Health checks decide what happens in both.

Think of a restaurant. You must not seat guests before the kitchen is ready, and at closing time you stop seating, finish the meals already served, and only then lock up.

> [!SUMMARY]
> By the end you will know:
>
> 1. The difference between a **readiness** check and a **liveness** check
> 2. Three ways health checks cause outages: too early, too eager and no goodbye
> 3. How to **diagnose** deploy-time errors and restart loops
> 4. How to configure probes and a graceful shutdown that avoid them

## First, who asks, and what they do with the answer

Something outside your application, a load balancer or an **orchestrator** (a system such as Kubernetes that starts, stops and restarts your copies), regularly asks each instance "are you OK?" and acts on the answer. Each question is a **probe**. There are two different ones:

- **Readiness**: *"Can you serve traffic right now?"* If the answer is no, the instance is **taken out of rotation**, meaning it gets no requests. It is not killed.
- **Liveness**: *"Are you stuck beyond recovery?"* If the answer is no, the instance is **restarted**.

A third, a **startup probe**, gives slow-starting applications extra time before the other two begin.

Mixing these up causes most of the trouble. A readiness failure is mild and reversible. A liveness failure is drastic.

## Failure 1: ready too early

A very common health endpoint just returns `200 OK`. It answers as soon as the web server's port opens, which can be before the application has finished loading its configuration, warming caches or connecting to its dependencies. Even when the app is ready, the first requests can be slow while the JVM and caches warm up.

```diagram
type: sequence
alt: The load balancer sees a 200 from the health endpoint while the app is still starting, and sends user traffic to it.
caption: Figure 1. The check passes before the app can serve.
actors: Balancer | Instance
Balancer -> Instance: GET /health
Instance --> Balancer: 200 OK
note Instance: the app is still loading for 25 s
Balancer -> Instance: user request !
```

For 25 seconds, real users hit an instance that cannot answer yet. During a rolling deploy this happens once for every instance, so you see a burst of errors that lines up exactly with the rollout.

## Failure 2: a liveness check that restarts everyone

A well-meaning team makes the liveness check thorough: it calls the database to confirm everything works. Then the database gets slow for 30 seconds. If the probe fails fast enough, every instance fails it at once:

```diagram
type: flow
alt: A slow database makes every liveness probe fail, all instances restart together, and the cold starts overload the database.
caption: Figure 2. Restarting does not fix a slow database.
Database gets slow -> Every liveness probe fails -> All instances restart together -> Cold starts hit the database !
```

Restarting does not fix a slow database. It makes the database's problem worse and turns a brief blip into a full outage. A liveness check should answer only "is **this process** broken?", never "is the world healthy?".

## Failure 3: no goodbye

When an instance is stopped, two things happen at once: the orchestrator sends it a termination signal, and it starts telling the load balancer to stop sending traffic. The second takes a few seconds to take effect everywhere. If the instance exits immediately, requests that arrive during that gap hit a closed door:

```text
error: connection reset by peer
502 Bad Gateway
```

Requests that were already running when it died, called **in flight**, are cut off mid-way.

## How to diagnose it

**1. Compare error times with deploy times.** Errors that begin and end with a rollout point at startup and shutdown behavior, not at the code.

**2. Read the orchestrator's events.** In Kubernetes:

```bash
kubectl describe pod <name>        # look at Events, Last State and the restart count
kubectl get pods                   # RESTARTS climbing means a restart loop
kubectl logs <name> --previous     # logs of the copy that was killed
kubectl rollout status deploy/<name>
```

Events such as `Liveness probe failed` or `Readiness probe failed` say what the checks saw. In `describe`, a last state of `OOMKilled` or exit code 137 means the container was killed, not that it crashed on its own.

**3. Measure startup time.** Compare how long your application takes to be fully ready with when the probe first reports success. If the probe passes first, you are in Failure 1.

**4. Look at the gateway's errors.** A burst of 502 or "connection reset" at the instant an instance is replaced indicates a missing graceful shutdown.

## Fix 1: separate readiness and liveness, and make them honest

Make each probe answer its own question:

- **Readiness:** return success only when the application has finished starting and can do useful work. It may include checks for dependencies this instance truly cannot work without.
- **Liveness:** keep it **cheap and local**. "Can this process respond at all?" Do not call the database, other services or anything outside.

Spring Boot provides both endpoints when probes are enabled:

```properties
management.endpoint.health.probes.enabled=true
# /actuator/health/liveness   and   /actuator/health/readiness
```

By default, readiness reflects only the application's own state. To add a dependency, list it in the readiness group, for example `management.endpoint.health.group.readiness.include=readinessState,db`.

```yaml
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 6
startupProbe:                         # gives slow starts time before liveness begins
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30                # up to 150 seconds to start
```

Set `timeoutSeconds` on purpose. Kubernetes defaults it to 1 second, so a busy app or a pause for **garbage collection** (the JVM freeing unused memory) can fail a probe that was fine.

With this liveness setting, 6 failures 10 seconds apart means about a minute of failing before a restart. A 30-second blip does not trigger one.

## Fix 2: shut down gracefully

When told to stop, an instance should say goodbye properly:

1. **Stop being ready first,** so the load balancer sends no new requests.
2. **Wait a few seconds** for that to spread.
3. **Finish the requests in flight.**
4. Then exit.

In Spring Boot:

```properties
server.shutdown=graceful
spring.lifecycle.timeout-per-shutdown-phase=30s
```

When shutdown begins, Spring Boot moves its readiness state to `REFUSING_TRAFFIC` and the web server stops accepting new requests. But the health endpoints stop answering too, so Kubernetes only learns of it through failed probes, and that takes a probe period. That is why the pause below exists. Graceful shutdown is already the default in current Spring Boot versions.

In Kubernetes, add a short pause before the signal arrives, and give the pod enough total time:

```yaml
# in the container definition:
lifecycle:
  preStop:
    exec: { command: ["sleep", "10"] }     # let the load balancer catch up
# in the pod spec, beside the containers:
terminationGracePeriodSeconds: 45          # longer than the pause + slowest request
```

The grace period clock starts when termination begins, so it must cover the 10-second pause plus the 30-second shutdown timeout. That is 40 seconds, and 45 leaves a margin. Some minimal images have no `sleep` command. Since Kubernetes 1.34 you can use the built-in `lifecycle.preStop.sleep.seconds: 10` instead of `exec`, which also works on those images.

## Fix 3: replace instances without losing capacity

Configure the rollout so a new instance is **ready before** an old one is removed. This only works if readiness is honest, as in Fix 1:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0       # never remove an instance until its replacement is ready
    maxSurge: 1             # start one extra instance at a time
```

## When the fix goes wrong

Three of these pitfalls hurt the most, because they turn a small problem into an outage.

**1. Readiness that depends on an optional service.** It seems right for readiness to check everything the page needs, including a recommendations service. Then recommendations gets slow. Every instance calls the same service, so every instance fails readiness at the same moment. The platform takes them all out of rotation, and no instance is left to serve requests. Checkout fails too, even though it never needed recommendations.

A useful rule: if the problem is in something shared, removing instances does not help. Put in readiness only what this instance cannot do useful work without. For optional parts, stay ready and degrade: show the page without recommendations, using a short timeout. The cascading failures post, linked at the end of this section, shows how to stop a slow service from dragging others down.

**2. A liveness probe that is too eager.** Say liveness has a 1-second timeout and fails after 2 misses, 10 seconds apart. A garbage-collection pause or a traffic spike makes two answers slow, and the platform restarts the instance after about 20 seconds of slowness. That removes capacity, so the other instances get more load. They slow down, miss their probes, and get restarted too. The restarts then cause the outage.

Remember what liveness is for: it should catch a process that is stuck for good, not one that is merely slow. Use the settings from Fix 1, a 3-second timeout and 6 failures, which means about a minute of silence before a restart. Keep the check cheap and local.

**3. A slow start that never ends.** Say an instance needs 90 seconds to start, for example while it loads a cache. Liveness has no initial delay, checks every 10 seconds, and allows 3 failures. After 3 × 10 = 30 seconds the platform restarts it. The next start also takes 90 seconds, so it is killed again, and again. A healthy instance never gets the chance to finish starting.

A **startup probe** fixes this. Kubernetes does not run liveness or readiness probes until the startup probe succeeds. In the YAML above, 30 failures × 5 seconds gives the instance up to 150 seconds. A fixed `initialDelaySeconds` is only a guess, and it always waits the full time. The startup probe moves on as soon as the app is up. After that, liveness reacts quickly again.

The smaller pitfalls, in short:

- **A grace period shorter than your slowest request.** If a request can take 60 seconds and you allow 30, it is cut off anyway.
- **A `preStop` sleep that is too short.** A one-second pause may not cover the time the load balancer needs to update.
- **`maxUnavailable` above zero with few replicas.** With three instances, allowing one to be unavailable removes a third of your capacity during every deploy.

A busy instance can also fail its probes simply because its threads are all stuck waiting. [The cascading failures post](/posts/cascading-failures-circuit-breaker/) shows how that happens.

## Which should you use?

| Situation | Reach for |
|---|---|
| "Can this instance take traffic yet?" | **Readiness probe,** true only when really ready |
| "Is this process hung?" | **Liveness probe,** cheap and local, no external calls |
| Slow application startup | **Startup probe** with a generous limit |
| Errors during rollouts | **Graceful shutdown** and a `preStop` pause |
| Capacity dips during deploys | **`maxUnavailable: 0`** with `maxSurge: 1` |

If you are not sure, keep liveness boring. A liveness check that touches the outside world will, one day, restart your whole system at the worst moment.

## The takeaway

1. **Readiness** decides who gets traffic. **Liveness** decides who gets restarted. They are different questions.
2. Reporting ready **too early** sends users to an instance still starting, so deploys cause an error burst.
3. A liveness check that tests **dependencies** can restart everything during a dependency slowdown: a self-made outage.
4. Without a **graceful shutdown**, requests in flight and requests arriving just after the stop signal fail.
5. Fix it with honest readiness, **cheap local liveness**, a startup probe, a graceful drain and a rollout that adds before it removes.
