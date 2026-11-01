---
title: "Correlation IDs: trace one request across services"
date: 2026-11-01
description: How a correlation ID lets you trace one request across services in logs: the traceparent header, Java MDC, and the thread trap that loses the ID.
tags: observability, logging, java
draft: true
---

## The doubt

A customer writes: "My order failed at 14:32." Support finds nothing useful. Your system has five services, and together they write millions of log lines an hour.

You search for the customer's user ID in the first service and find a line. The second service does not log that ID at all. The third logs it only sometimes. You are stuck holding one thread and unable to follow it.

> "How do I find every log line that belongs to one single request, across all the services it touched?"

You give each request a label when it enters the system and make every service stamp that label on every line it writes. Then one search finds the whole story.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **correlation ID** is and how it travels between services
> 2. The standard `traceparent` header and how to read it
> 3. How to put the ID in every Java log line, and why it silently **disappears** in new threads
> 4. How to carry it through queues, return it to users, and avoid the common mistakes

## First, the idea

A **log line** is one line of text a program writes to record that something happened. When a request passes through several services, each service writes its own lines in its own file or log stream, with no link between them.

A **correlation ID** (also called a request ID) is a unique string created when a request first arrives, at the **edge**, the first service that receives it, such as a gateway. Every service passes it on in an HTTP **header** (a name and value sent along with the request) and writes it in every log line.

Think of the tracking number on a parcel. Each depot scans the same number, so you can follow one parcel through many hands. The analogy stops at one point: a parcel number is printed once, while a software ID must be copied by hand, by your code, at every step.

## The standard header: traceparent

You can invent a header such as `X-Request-ID`, and many systems do. The standard way is the **W3C Trace Context** specification, which defines a header named `traceparent`:

```text
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
```

It has four fields joined by dashes:

| Field | Example | Meaning |
|---|---|---|
| version | `00` | Format version; `ff` is invalid |
| trace-id | `0af7651916cd43dd8448eb211c80319c` | 32 lowercase hex characters, the ID of the whole request |
| parent-id | `b7ad6b7169203331` | 16 lowercase hex characters, the step that made this call |
| trace-flags | `01` | 2 hex characters; the lowest bit means "sampled" |

**Hex** means digits 0 to 9 plus letters a to f. The specification says all zeros is invalid for both the trace-id and the parent-id. The example above comes from the specification itself.

For plain logs, the **trace-id** is your correlation ID. It stays the same across the whole request, while the parent-id changes at each hop.

## Putting the ID in Java logs: MDC

**SLF4J** is the common logging interface for Java, and **Logback** is a popular logger behind it. SLF4J provides the **MDC** (mapped diagnostic context): a small map of key-value pairs attached to the current thread. The logger can print any key from it on every line.

```java
MDC.put("requestId", "req-7f3a");   // at the start of the request
try {
    log.info("request received");
} finally {
    MDC.remove("requestId");         // always clean up
}
```

In Logback, print the value with `%X{key}` in the pattern. A default after `:-` is used when the key is missing:

```xml
<pattern>%-6thread [%X{requestId:-none}] %msg%n</pattern>
```

In a web app, set the MDC in a **filter**, a piece of code that runs before every request. Read the incoming header, or create a new ID if there is none, and put it in the MDC. Then add the same value to every outgoing call.

## The failure: the ID vanishes in another thread

MDC is **thread-local**: each thread has its own copy, and a new thread does not get yours. Worker threads do not inherit your MDC, and pooled threads are reused across requests, so they never hold your ID.

```diagram
type: sequence
alt: The request thread has the ID, but a worker thread logs the same request with no ID.
caption: Figure 1. The log line from the worker cannot be found by ID.
actors: Gateway | Orders | Worker
Gateway -> Orders: POST /orders (id req-7f3a)
note Orders: MDC holds req-7f3a
Orders -> Worker: submit charge task
note Worker: new thread, MDC is empty !
Worker --> Orders: log line has no ID !
```

You search for `req-7f3a` and see the start of the request but not the charge, which is the line you need. Here is a runnable demo using Logback 1.5.12 and SLF4J 2.0.16. It logs once from the request thread and then from a pool thread, with and without a fix:

```java
static Runnable withMdc(Runnable task) {
    Map<String, String> captured = MDC.getCopyOfContextMap();
    return () -> {
        Map<String, String> previous = MDC.getCopyOfContextMap();
        if (captured != null) MDC.setContextMap(captured); else MDC.clear();
        try {
            task.run();
        } finally {
            if (previous != null) MDC.setContextMap(previous); else MDC.clear();
        }
    };
}

// in main, with a one-thread pool and MDC "requestId" set to req-7f3a:
log.info("request received");
pool.submit(() -> log.info("charging card (plain task)")).get();
pool.submit(withMdc(() -> log.info("charging card (wrapped task)"))).get();
pool.submit(() -> log.info("next job on the same thread")).get();
```

Output from a real run:

```text
main   [req-7f3a] request received
pool-1-thread-1 [none] charging card (plain task)
pool-1-thread-1 [req-7f3a] charging card (wrapped task)
pool-1-thread-1 [none] next job on the same thread
```

The plain task lost the ID. The wrapped task copied it on submission. The last line shows why the wrapper restores the previous state: without that, a stale ID could leak into the next job on the same thread.

## The same problem in queues

When a request continues through a message queue, there is no HTTP header and no shared thread. Put the ID in the message's own **headers** (metadata that travels beside the body), and have the consumer read it into the MDC before it processes the message and clear it afterward.

```text
producer: message.headers["traceparent"] = current trace-id context
consumer: MDC.put("requestId", traceIdFrom(message.headers["traceparent"]));  try { handle() } finally { MDC.clear() }
```

This is pseudocode, because the exact call depends on your queue library. Message consumers run on their own threads, so without this step every message starts with an empty MDC.

## Return the ID to the user

Add the ID to error responses and show it on the error page: "Something went wrong. Reference: req-7f3a." A customer can quote it, and support can search for it directly. You can also return it in a response header such as `X-Request-ID`, so a browser's developer tools show it.

## How to diagnose it

**1. Follow one ID through every service.**

```bash
grep -h "req-7f3a" orders.log payments.log inventory.log | sort
```

Sorting works only if each line begins with a timestamp in a sortable format, such as ISO 8601 (`2026-11-01T14:32:07.123Z`). In a central log tool the equivalent is a search such as `requestId="req-7f3a"`, though the syntax differs by tool.

**2. Look for gaps.** If the ID appears in the gateway and orders but not in payments, the break is between them: a header not forwarded.

**3. Look for lines with no ID.** Search for the default value, here `none`. Lines that carry it come from threads that lost the ID. The count tells you how big the hole is.

## Fix 1: set it once, at the edge

**What it is:** the first service creates the ID, and all others reuse it.

**How it works:** a filter reads `traceparent` (or your header). If it is missing or malformed, create a new one. A random (version 4) UUID is a common choice, since it has 122 random bits. To use it as the trace-id in a `traceparent` header, strip the dashes and lowercase it, because that field must be exactly 32 lowercase hex characters.

**What it costs:** a small filter, and discipline: every outgoing HTTP client and message producer must copy the header.

## Fix 2: wrap every async hop

**What it is:** copy the MDC whenever work crosses a thread boundary.

**How it works:** wrap executors, scheduled tasks and callbacks like the `withMdc` helper above, or use your framework's built-in support for it, if it has one. Spring, for example, offers a task decorator hook on its executors.

**What it costs:** one wrapper per place where threads change, and a review habit to catch new ones.

## Fix 3: use tracing instead of hand-made IDs

**What it is:** **OpenTelemetry** is an open standard and set of libraries that create trace IDs, pass them using `traceparent`, and record timing for each step, called a **span**.

**How it works:** a library or agent patches common clients and servers, so IDs propagate with little code. It can put the trace ID in your logs for you.

**What it costs:** setup work, a place to store traces, and extra overhead. It is the fuller solution, and a plain correlation ID is the cheap first step.

## When the fix goes wrong

Two of these are easy to miss, so they come first. The short ones follow.

**1. Trusting an outside ID blindly.** It feels friendly to accept the ID a caller sends, so the trace continues. But the caller can send any text. Your logger then writes that text into every log line, without checking it.

Suppose the ID contains a line break followed by text that looks like a log line (illustrative):

```text
abc123
2026-11-01 10:00:00 INFO  payment approved for user 9
```

Your log file now shows a second line that no code of yours wrote. Someone reading the logs, or a tool parsing them, believes it. This is called **log injection**: an outsider writes fake lines in your logs. Some servers and proxies already reject line breaks in headers, but do not count on it. The ID may also come from a queue message or another place with no such check. A very long ID is a smaller problem, but it adds up. A 1 MB ID printed on 100 log lines is 100 MB of logs from one request.

**What to do instead.** Check every incoming ID. Accept it only if it matches a strict pattern, for example 8 to 64 characters of letters, digits and dashes. If it does not match, throw it away and create a new one. A strict pattern works because a line break or a huge string can never match it.

**2. Forgetting to clear the MDC.** The MDC belongs to a thread, and web servers reuse threads. Say a thread handles request A and puts `req-A` in the MDC. An error skips the cleanup line, so `req-A` stays. Later the same thread runs a scheduled job, or a request that never sets an ID. Every line it logs now says `req-A`. When you search for `req-A`, you find lines that have nothing to do with it, and you may blame the wrong request.

**What to do instead.** Set the ID in a filter, and clear it in a `finally` block, which runs even when the code throws an error. Then the thread is clean for the next task, whatever happened.

Smaller traps:

- **A new ID at every service.** If each service creates its own ID, nothing links them. Create one at the edge and forward it.
- **Personal data in the ID.** Never build it from an email, user name or account number. IDs end up in logs, URLs and screenshots.
- **IDs that are not unique enough.** A counter, a timestamp or a short random number collides across servers. Use a random UUID or a 16-byte random value.

## Which should you use?

| Situation | Reach for |
|---|---|
| A few services, plain logs | A correlation ID in a filter and MDC |
| Many services, need timing too | OpenTelemetry tracing |
| Async tasks and thread pools | Wrap each task to copy the MDC |
| Queues between services | The ID in message headers |

If you are not sure, start by logging one ID everywhere, using the `traceparent` format so you can adopt tracing later without changing the header.

## The takeaway

1. A **correlation ID** is created once at the edge and written in every log line, so one search finds the whole request.
2. The standard header is **`traceparent`**, and its trace-id field works well as the ID.
3. Java's **MDC is thread-local**, so the ID is lost in new threads, pool tasks and queue consumers unless you copy it.
4. Return the ID in **error responses**, and carry it in **message headers** for queues.
5. Validate incoming IDs, never put personal data in them, and move to **OpenTelemetry** when you need timing as well.
