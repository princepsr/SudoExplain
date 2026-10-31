---
title: Connection pool exhausted: why the app hangs under load
date: 2026-11-01
description: Why a healthy-looking Java service freezes under load, how leaked or hoarded database connections cause it, and how to find and fix them.
tags: java, databases, performance
draft: true
---

## The doubt

The service runs fine all day. Then traffic picks up and every request starts to hang. CPU is low. The database looks nearly idle. There is no crash, just a growing wall of timeouts, and the logs say something like this:

```text
HikariPool-1 - Connection is not available, request timed out after 30000ms.
```

> The database is not busy and the servers are not busy, so what is everyone waiting for?

They are waiting for a **database connection**, and there are none left to hand out. Picture a rack of rental bikes. When every bike is out, the next customer queues, even though the roads are empty.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why apps keep a pool of connections, and what "exhausted" means
> 2. Three ways a pool runs dry: leaks, hoarding and too many servers
> 3. How to **diagnose** it from pool metrics, a thread dump and the database itself
> 4. How to fix it, and why the obvious fix (a bigger pool) often makes it worse

## First, what the pool is for

Opening a connection to a database is slow. It involves a network handshake, often encryption, and a login. Doing that for every request would cost more than the query itself. So an application opens a fixed number of connections at startup and keeps them in a **connection pool**.

A request **borrows** a connection, runs its queries, and **returns** it. Calling `close()` on a pooled connection does not really close it. It hands the connection back to the pool.

If every connection is borrowed, the next request **waits** for one to come back. If it waits longer than a timeout, it fails with the error above. The pool is **exhausted** when the demand for connections is higher than the supply, for long enough that requests start to queue.

The pool size is small on purpose. HikariCP, the usual Java pool, defaults to 10 connections. That is often enough, because a connection is only needed while a query runs.

## Failure 1: the leak

The simplest cause is a connection that is borrowed and never returned. Look at this code:

```java
Connection c = dataSource.getConnection();
PreparedStatement ps = c.prepareStatement("SELECT * FROM orders WHERE id = ?");
ps.setLong(1, id);
ResultSet rs = ps.executeQuery();      // if this throws...
// ...use rs...
c.close();                             // ...this line never runs
```

Whenever `executeQuery()` throws, `close()` is skipped, and that connection is lost to the pool for good. One error does not matter. But a database hiccup that causes a few hundred errors can drain a pool of 10 in seconds, and the pool never recovers, even after the database is healthy again.

## Failure 2: holding a connection while you wait

Even without a leak, a connection can be held far longer than the query needs. The classic case is calling another service inside a **transaction**, a group of queries that succeed or fail together and keep one connection until they finish:

```java
@Transactional
public void placeOrder(Order order) {
    orderRepository.save(order);             // the transaction holds a connection from here...
    paymentClient.charge(order);             // ...while waiting 2 seconds on a remote call
    orderRepository.markPaid(order);
}
```

The connection is held for the whole method, not just the two quick queries.

```diagram
type: sequence
alt: A request borrows a connection, then waits two seconds on the payment service while still holding it.
caption: Figure 1. The connection sits idle for the whole remote call.
actors: Request | Pool | Payment
Request -> Pool: borrow a connection
Pool --> Request: connection #1
Request -> Payment: charge card, wait 2 s !
note Request: still holding connection #1 !
Payment --> Request: ok
Request -> Pool: return it, 2 s late
```

A rule of thumb explains why this hurts:

```text
connections in use  =  requests per second  x  seconds each one holds a connection

pool of 10, each request holds one for 2 seconds:
10 = rps x 2   ->   the pool can handle only 5 requests per second
```

At 6 requests per second, the queue grows without limit. The database is idle, because the connections are sitting still waiting for the payment service. A slow query or a lock wait inside the database has the same effect, because it also makes each request hold its connection longer.

In Spring Boot with JPA there is a hidden version of this. The default `spring.jpa.open-in-view=true` keeps a connection from the first database access until the end of the web request, including remote calls and page rendering. Set it to `false` unless you rely on it.

## Failure 3: more servers than the database can take

Pools exist **per server**. If each of your servers has a pool of 20, then:

```text
 5 servers x 20 =  100 connections
20 servers x 20 =  400 connections
```

Databases have a connection limit of their own. PostgreSQL's `max_connections` defaults to 100, for example. Scale out past it and new connections are refused, with errors like `too many clients already`. The pool then fails to even create connections, and all servers break together.

This is the cruel part: you added servers to cope with load, and that is what took the database down.

## How to diagnose it

**1. Read the pool metrics.** Pools expose three numbers: connections **active** (borrowed), **idle** (free) and requests **pending** (waiting). The signature of exhaustion is *active equals the maximum, idle is zero, pending is climbing*. HikariCP publishes these through Micrometer (a metrics library) as `hikaricp.connections.active`, `hikaricp.connections.idle` and `hikaricp.connections.pending`.

**2. Take a thread dump.** A thread dump lists what every thread is doing right now. Capture one with `jcmd <pid> Thread.print`, and take two or three a few seconds apart. If many request threads are sitting inside `HikariPool.getConnection`, they are all queueing for a connection:

```text
"http-nio-8080-exec-17" waiting on condition
    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:...)
    at com.example.OrderRepository.save(OrderRepository.java:42)
```

**3. Find who is holding connections.** Ask the database what each connection is doing. In PostgreSQL:

```sql
SELECT state, count(*), max(now() - state_change) AS longest
FROM pg_stat_activity
GROUP BY state;
```

Compare this with the pool numbers. If the pool says "all active" but the database shows mostly `idle`, connections were borrowed and are not being used: a leak, or the app is doing other work while holding them. A large number in **idle in transaction** means the app opened a transaction and is doing something else with it: Failure 2.

**4. Make leaks name themselves.** HikariCP can log a stack trace when a connection is held too long. Set it in the pool config:

```properties
# milliseconds
spring.datasource.hikari.leak-detection-threshold=20000
```

After that, a connection borrowed for more than 20 seconds produces a warning that shows exactly where it was borrowed.

## Fix 1: always return the connection

Let the language do the closing. `try`-with-resources closes the connection even when an exception is thrown:

```java
try (Connection c = dataSource.getConnection();
     PreparedStatement ps = c.prepareStatement("SELECT * FROM orders WHERE id = ?")) {
    ps.setLong(1, id);
    try (ResultSet rs = ps.executeQuery()) {
        // ...use rs...
    }
}   // c is returned to the pool here, error or not
```

If you use a framework such as Spring, the framework does this for you, as long as you do not hold a raw connection yourself.

## Fix 2: keep transactions short

Do the slow thing outside the transaction. Call the payment service first, then open a short transaction to record the result:

```java
public void placeOrder(Order order) {
    PaymentResult result = paymentClient.charge(order);   // no connection held here
    orderWriter.saveOrderAndPayment(order, result);       // short @Transactional method
}
```

Two cautions. First, `orderWriter` must be a separate bean. If `saveOrderAndPayment` sits in the same class, Spring's `@Transactional` is silently ignored. Second, charging before saving changes the failure mode: if the save fails, you charged a customer for no order. Use an idempotency key and a refund path, as in [the double-charge post](/posts/idempotency-key-double-charge/).

The principle: **a connection should be held only while the database is actually working**. Never across a network call, a file upload or a sleep.

## Fix 3: size the pools together

Pick the pool size from the database's limit, not from hope. The total across all servers must stay well under it:

```text
database limit: 100
reserve for admin tools, migrations, monitoring: 20
left for the app: 80

8 servers  ->  pool of 10 each  = 80
```

A smaller pool is usually faster than a bigger one. HikariCP's pool-sizing guide argues that a small pool often performs best, and it suggests roughly twice the database's CPU core count (plus the number of disks) as a starting point. Treat that as the total across all servers, start small and measure.

If you truly need thousands of application connections, put a **connection proxy** such as PgBouncer between the app and the database, so many app connections share a few real ones. Check its pooling modes first, because some break session state.

Also set a **short connection timeout** (a few seconds rather than 30), for example `spring.datasource.hikari.connection-timeout=3000`. When the pool is exhausted, you want requests to fail fast and free their threads, not queue for half a minute and pile up.

## When the fix goes wrong

- **Raising the pool size to 200.** More connections do not make the database faster. Past a point, they make it slower, because it spends time switching between them. If the real problem is a leak, a bigger pool just takes longer to run dry.
- **Retrying on pool timeout.** Every retry joins the queue, so the queue gets longer exactly when the system is struggling. Retries need limits and delays. [The cascading failures post](/posts/cascading-failures-circuit-breaker/) covers this in depth.
- **Leak detection left at 0.** It is off by default. Turn it on in staging and production, with a threshold above your slowest legitimate query.
- **Forgetting background jobs.** A nightly report that holds 5 connections for an hour can starve the web requests. Give batch work its own small pool.

## Which should you use?

| Situation | Reach for |
|---|---|
| Pool at maximum, but the database is idle | **Look for hoarding** (slow calls inside transactions) and leaks |
| Connections in "idle in transaction" | **Shorten transactions.** Move remote calls outside them |
| Exhaustion began after an error spike | **A leak on the error path.** Use `try`-with-resources |
| Fine at 5 servers, broken at 20 | **Check the total** against the database limit. Consider a proxy |
| Requests pile up for 30 seconds before failing | **A shorter connection timeout,** so failures are quick |

If you are not sure where to begin, begin with the pool metrics and a thread dump. Together they show whether the problem is waiting, leaking or too many servers in about five minutes.

If the pool drains because queries themselves are slow, see [the slow query post](/posts/slow-query-missing-index/).

## The takeaway

1. A pool is a small, fixed set of connections that requests borrow and return.
2. **Exhausted** means demand for connections outlasts supply, so requests queue and then time out.
3. Three causes: a **leak** (never returned), **hoarding** (held during slow work) and **too many servers** for the database limit.
4. Diagnose with pool metrics (active at max, pending rising), a thread dump, and the connection states in the database.
5. Fix it by always returning connections, keeping transactions short and sizing all pools under the database limit. A bigger pool is not the fix.
