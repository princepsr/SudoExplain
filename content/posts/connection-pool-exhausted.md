---
title: HikariPool-1 Connection is not available: pool exhausted
date: 2026-11-02
description: Why a Java app hangs with Connection is not available errors under load, how leaked or hoarded connections cause it, and how to find and fix it.
tags: java, databases, performance, hikaricp
---

## The question

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

## Failure 1: a connection leak, and the fix

The simplest cause is a connection that is borrowed and never returned. It is the connection version of a [Java memory leak](/posts/java-memory-leak/): something is taken and never given back. Look at this code:

```java
Connection c = dataSource.getConnection();
PreparedStatement ps = c.prepareStatement(
        "SELECT * FROM orders WHERE id = ?");
ps.setLong(1, id);
// if this line throws an exception...
ResultSet rs = ps.executeQuery();
// ...use rs...
// ...this line never runs
c.close();
```

Whenever `executeQuery()` throws, `close()` is skipped, and that connection is lost to the pool for good. One error does not matter. But a database hiccup that causes a few hundred errors can drain a pool of 10 in seconds, and the pool never recovers, even after the database is healthy again.

**The fix: always return the connection.** Let the language do the closing. `try`-with-resources closes the connection even when an exception is thrown:

```java
try (Connection c = dataSource.getConnection();
     PreparedStatement ps = c.prepareStatement(
             "SELECT * FROM orders WHERE id = ?")) {
    ps.setLong(1, id);
    try (ResultSet rs = ps.executeQuery()) {
        // ...use rs...
    }
}
// c is returned to the pool here, error or not
```

If you use a framework such as Spring, the framework does this for you, as long as you do not hold a raw connection yourself.

## Failure 2: holding a connection while you wait, and the fix

In Failure 1, connections were lost by mistake. Here nothing is lost: every connection is returned in the end. The problem is that it is **held for much longer than needed**, and while one request holds it, nobody else can use it.

Think of renting a bike to ride to the shop, and then leaving it parked outside a café for two hours. You did bring it back, but nobody else could ride it in that time.

In code, this usually happens inside a **transaction**. A transaction is a group of database queries that must all succeed or all fail together. To keep them together, the app uses one connection for the whole group, from the first query until the method ends. Look at this method:

```java
@Transactional
public void placeOrder(Order order) {
    // the transaction takes a connection here...
    orderRepository.save(order);
    // ...and holds it while waiting 2 s on a remote call
    paymentClient.charge(order);
    orderRepository.markPaid(order);
}
```

Here is what happens, step by step:

1. `save(order)` runs a quick query. To do that, the method borrows a connection.
2. `charge(order)` calls the payment company over the network and waits 2 seconds. No database work happens now, but the transaction is not finished, so the connection stays borrowed.
3. `markPaid(order)` runs another quick query. Only then does the method end and the connection go back to the pool.

The connection did real work for a few milliseconds, but it was held for about 2 seconds. For almost the whole time, it sat idle and nobody else could use it.

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

Now see why this drains the pool. It is simple arithmetic:

```text
one connection serves 1 request per 2 seconds
10 connections serve 10 / 2 = 5 requests per second
```

So a pool of 10 can handle 5 requests per second, and no more. Say 6 requests arrive every second. Every second the pool falls one request further behind. Those requests wait in a queue, the queue only grows, and in the end they time out with the error from the start of this post.

The strange part is that the database looks idle. It is not the busy one. The connections are just waiting for the payment service. A slow query or a lock wait inside the database has the same effect, because it also makes each request hold its connection for longer.

**The fix: keep transactions short.** Do the slow work outside the transaction, so no connection is held while you wait. Call the payment service first. Then open a short transaction that only writes the results, which takes a few milliseconds:

```java
public void placeOrder(Order order) {
    // no connection is held during the remote call
    PaymentResult result = paymentClient.charge(order);
    // a short @Transactional method
    orderWriter.saveOrderAndPayment(order, result);
}
```

Two cautions.

**1. Put the short method in a separate class.** It is tempting to keep it in the same class, like this:

```java
@Service
public class OrderService {
    public void placeOrder(Order order) {
        PaymentResult result = paymentClient.charge(order);
        // called from inside the same class
        saveOrderAndPayment(order, result);
    }

    @Transactional
    public void saveOrderAndPayment(Order o, PaymentResult r) {
        // ...no transaction starts here
    }
}
```

This looks right, but `@Transactional` does nothing here, and Spring does not warn you. The reason is how it works. Spring does not change your method. It puts a **stand-in** object in front of your class. When other code calls your service, the call goes through the stand-in, which opens the transaction, runs your method, and then commits.

A call from inside the same class goes straight to the method. The stand-in is skipped, so no transaction opens. The two saves are no longer all-or-nothing: if the second one fails, the first one stays. The fix is to put `saveOrderAndPayment` in a separate class, like `orderWriter` above, so the call comes from outside and goes through the stand-in.

**2. Charging first changes what can go wrong.** If the save fails after the charge, the customer paid and there is no order. Protect against that with an idempotency key, a unique ID that lets the server recognise and ignore a repeated request, and a way to refund.

The principle: **a connection should be held only while the database is actually working**. Never across a network call, a file upload or a sleep.

**A hidden version of this problem in Spring Boot.** Even if you keep your transactions short, Spring Boot can still hold the connection for you. It has a setting called `open-in-view`, and it is **on by default**. Its purpose is to make lazy loading work late: it keeps the database connection open for the whole web request, so that even a page template can still load more data.

That means the connection is held from the first database query until the response is sent. It stays held while your code calls other services or builds the page, which is the same problem as before, without you writing any transaction.

To turn it off, set this in your configuration:

```properties
spring.jpa.open-in-view=false
```

Now the connection goes back to the pool when the service method ends. The price is that lazy data can only be loaded **inside** the service method. So load everything the page needs there, with a fetch join or a projection, as shown in the [N+1 query problem](/posts/n-plus-one-query-problem/) post.

## Failure 3: more servers than the database can take, and the fix

Pools exist **per server**. If each of your servers has a pool of 20, then:

```text
 5 servers x 20 =  100 connections
20 servers x 20 =  400 connections
```

Databases have a connection limit of their own. PostgreSQL's `max_connections` is typically 100 by default, for example. Scale out past it and new connections are refused, with errors like `FATAL: sorry, too many clients already`. The pool then fails to even create connections, and all servers break together.

This is the cruel part: you added servers to cope with load, and that is what took the database down.

**The fix: size the pools together.** Pick the pool size from the database's limit, not from hope. The total across all servers must stay well under it:

```text
database limit: 100
reserve for admin tools, migrations, monitoring: 20
left for the app: 80

8 servers  ->  pool of 10 each  = 80
```

Give batch work, such as a nightly report, its own small pool. Otherwise a report that holds 5 connections for an hour can starve the web requests.

A smaller pool is usually faster than a bigger one. HikariCP's pool-sizing guide argues that a small pool often performs best, and it suggests roughly twice the database's CPU core count (plus the number of disks) as a starting point. Treat that as the total across all servers, start small and measure.

**If you truly need thousands of connections, use a connection proxy.** A **connection proxy** is a small program that sits between your apps and the database. Your apps connect to the proxy, not to the database. The proxy keeps only a few real database connections and lends them out when they are needed.

Think of a receptionist. A thousand visitors can wait in the lobby, but only 50 fit in the meeting rooms. The receptionist sends each visitor in when a room is free. In the same way, 20 servers with 50 connections each, 1,000 in all, can share 50 real database connections, which fits under a limit of 100.

PgBouncer is a well-known proxy for PostgreSQL. It has **pooling modes**, which decide how long an app keeps a real connection:

- **Session mode:** the app keeps one for as long as it stays connected. Everything works as normal, but little is shared.
- **Transaction mode:** the app gets one only while a transaction runs, and then it goes to someone else. This shares the most, but the next transaction may run on a different real connection. Anything stored on one connection is lost, such as settings made with `SET`, temporary tables, `LISTEN` and session-level locks.

So choose the mode first, and test your app with it. Transaction mode works only if your app does not use the features that it breaks.

## For all three: fail fast with a short timeout

Whatever the cause, set a **short connection timeout** (a few seconds rather than 30), for example `spring.datasource.hikari.connection-timeout=3000`. When the pool is exhausted, you want requests to fail fast and free their threads, not queue for half a minute and pile up.

## How to diagnose it

**1. Read the pool metrics.** Pools expose three numbers: connections **active** (borrowed), **idle** (free) and requests **pending** (waiting). The signature of exhaustion is *active equals the maximum, idle is zero, pending is climbing*. HikariCP publishes these through Micrometer (a metrics library) as `hikaricp.connections.active`, `hikaricp.connections.idle` and `hikaricp.connections.pending`.

**2. Take a thread dump.** A thread dump lists what every thread is doing right now. Capture one with `jcmd <pid> Thread.print`, and take two or three a few seconds apart. If many request threads are sitting inside `HikariPool.getConnection`, they are all queueing for a connection:

```text
"http-nio-8080-exec-17" waiting on condition
    at com.zaxxer.hikari.pool.HikariPool.getConnection(...)
    at com.example.OrderRepository.save(OrderRepository.java:42)
```

**3. Find who is holding connections.** Ask the database what each connection is doing. In PostgreSQL:

```sql
SELECT state, count(*), max(now() - state_change) AS longest
FROM pg_stat_activity
GROUP BY state;
```

Compare this with the pool numbers. If the pool says "all active" but the database shows mostly `idle`, connections were borrowed and are not being used: a leak, or the app is doing other work while holding them. A large number in **idle in transaction** means the app opened a transaction and is doing something else with it: Failure 2.

**4. Make leaks name themselves.** HikariCP can log a stack trace when a connection is held too long. It is off by default, so turn it on in the pool config:

```properties
# milliseconds
spring.datasource.hikari.leak-detection-threshold=20000
```

After that, a connection borrowed for more than 20 seconds produces a warning that shows exactly where it was borrowed. Set the threshold above your slowest legitimate query, or it will warn about connections that are fine.

## When the fix goes wrong

Two pitfalls look like sensible reactions. Both make an outage worse.

**1. Raising the pool size.** When requests wait for connections, a bigger pool looks like the obvious cure. But more connections do not make the database faster. Past a point they make it slower, because it spends time switching between them. And as Failure 3 showed, a bigger pool on every server can push the total past the database limit.

If the real problem is a leak, a bigger pool only delays the failure. Say a bug leaks one connection per failed request, and 5 requests fail each second. A pool of 10 is gone in 2 seconds. A pool of 200 is gone in 200 / 5 = 40 seconds. The outage is the same, just later.
**What to do instead:** find out why connections are held, using the pool metrics and a thread dump. Then fix the leak or the long transaction.

**2. Retrying on pool timeout.** The error says "try again later", so a retry looks natural. But the retry asks the same full pool for a connection. Say the pool has 10 connections, all busy, and 100 requests are waiting. They time out, and each is retried twice more, so 3 attempts each. Up to 3 x 100 = 300 requests now queue for the same 10 connections. The queue gets longer exactly when the system is struggling, and the pool may never catch up.

**What to do instead:** do not retry on a pool timeout. If a retry is needed, do it at one layer only, with a delay that grows and a limit on attempts.

## Which should you use?

| Situation | Reach for |
|---|---|
| Pool at maximum, but the database is idle | **Look for hoarding** (slow calls inside transactions) and leaks |
| Connections in "idle in transaction" | **Shorten transactions.** Move remote calls outside them |
| Exhaustion began after an error spike | **A leak on the error path.** Use `try`-with-resources |
| Fine at 5 servers, broken at 20 | **Check the total** against the database limit. Consider a proxy |
| Requests pile up for 30 seconds before failing | **A shorter connection timeout,** so failures are quick |

If you are not sure where to begin, begin with the pool metrics and a thread dump. Together they show whether the problem is waiting, leaking or too many servers in about five minutes.

If the pool drains because queries themselves are slow, look at the slow queries first. [A missing index](/posts/slow-query-missing-index/) is a common cause, and `EXPLAIN` shows how the database runs a query. If one page runs hundreds of small queries, each request holds its connection for longer, and the [N+1 query problem](/posts/n-plus-one-query-problem/) is the likely cause.

## The takeaway

1. A pool is a small, fixed set of connections that requests borrow and return.
2. **Exhausted** means demand for connections outlasts supply, so requests queue and then time out.
3. Three causes: a **leak** (never returned), **hoarding** (held during slow work) and **too many servers** for the database limit.
4. Diagnose with pool metrics (active at max, pending rising), a thread dump, and the connection states in the database.
5. Fix it by always returning connections, keeping transactions short and sizing all pools under the database limit. A bigger pool is not the fix.
