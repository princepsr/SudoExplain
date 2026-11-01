---
title: N+1 query problem in Hibernate and JPA: find it and fix it
date: 2026-11-01
description: Why a Hibernate or JPA page that is fast in development takes 10 seconds in production, how lazy loading hides hundreds of queries, and how to fix it.
tags: java, databases, performance
---

## The doubt

An orders page loads in 50 milliseconds on your machine, where the test database holds ten orders. Months later, in production with five thousand, it takes ten seconds. The database is busy answering a flood of requests. Yet when you look at the slow-query log, which lists queries that took too long, **nothing is slow**: every query finishes in a millisecond or two.

> Every single query is fast, so why is the page slow?

Because there is not one query. There are five thousand and one. It is like making 5,000 separate trips to the shop for one item each, instead of taking a single shopping list.

> [!SUMMARY]
> By the end you will know:
>
> 1. What the **N+1 problem** is and how loading related data (eager or lazy) creates it without any visible sign in the code
> 2. Why it stays hidden in development and arrives with data growth
> 3. How to **diagnose** it, even though no single query is slow
> 4. The fixes (fetch joins, batching, projections) and how each can backfire

## First, what an ORM does

Your data is stored in a database. Your Java code works with Java objects. They are two different shapes, so something has to translate between them.

An **ORM** (object-relational mapper) is that translator. You ask for an `Order` in Java. The ORM writes the database query for you, runs it, and hands you back a ready `Order` object. Without an ORM, you would write the query yourself and copy every value into the object by hand.

The catch is that you never see the queries it writes. Keep that in mind, because this post is about what happens when those hidden queries pile up.

You will see two names for this:

- **JPA** is the written set of rules for how Java and a database are matched up. It is only rules, not code that runs.
- **Hibernate** is the ORM that follows those rules and does the actual work. Spring Boot uses it by default, so most Java projects already have it.

## Then, related data: eager and lazy

An `Order` belongs to a `Customer`. When you load an order, should the ORM also load its customer? There are two choices:

- **Eager:** load the customer straight away, together with the order, every time.
- **Lazy:** load only the order. Load the customer later, at the moment your code first asks for it.

Lazy exists to save work. A customer has its own addresses, orders and more, so loading all of that with every order could read a lot of data you never use.

You choose with a setting on the link between the two classes:

```java
@ManyToOne(fetch = FetchType.LAZY)
private Customer customer;
```

Here is the part that surprises people. If you write nothing, JPA picks **eager** for this kind of link. You might expect eager to be safe, because the customer arrives with the order. But when you load a *list* of orders, the ORM sends one query for the orders, and then, to fill in each customer immediately, one more query per order, all inside that same call.

So eager does not help. Lazy does not cause a problem by itself, though. If your code never asks for the customers, lazy sends no extra queries, and it saves work.

The trouble starts when your code **does** ask, for many orders in a row. A page that lists orders with each customer's name asks for every customer, and each ask sends its own query. Lazy only decides *when* those queries are sent, not *how many*. Eager sends the same number, just earlier.

Here is lazy at work. Loading the orders does not load their customers. A customer is fetched only when you call `order.getCustomer()`. So look at what happens when a page shows the customer's name for every order:

```java
// 1 query: loads all the orders
List<Order> orders = orderRepository.findAll();

for (Order order : orders) {
    // each new customer here sends 1 more query
    System.out.println(order.getCustomer().getName());
}
```

The loop looks innocent. There is no query in sight. But each call to `getCustomer()` quietly sends one:

```sql
SELECT * FROM orders;                  -- 1 query
SELECT * FROM customers WHERE id = 7;  -- one per customer
SELECT * FROM customers WHERE id = 12;
SELECT * FROM customers WHERE id = 31;
...
```

```diagram
type: sequence
alt: The app asks for all orders in one query, then sends one customer query for every order.
caption: Figure 1. One query for the list, then one round trip per row.
actors: App | Database
App -> Database: SELECT * FROM orders
Database --> App: 5,000 orders
App -> Database: customer 7?
App -> Database: customer 12?
note all: ...up to 5,000 more round trips !
```

That is the **N+1 problem**: **1** query to get the list, plus **N** more, one for each customer. If there are 5,000 different customers, the page sends 5,001 queries.

One small detail: if two orders belong to the same customer, the ORM remembers that customer and does not ask the database again. So N is the number of *different* customers. With thousands of customers, that is still thousands of queries.

## Why it appears only in production

The cost grows with the data, and the code never changes:

| Orders on the page | Queries | At about 2 ms each |
|---|---|---|
| 10 (development) | 11 | 22 ms |
| 500 | 501 | 1 second |
| 5,000 | 5,001 | 10 seconds |

Each query is a **network round trip** to the database. Even when the database answers in a fraction of a millisecond, the trip costs more. Thousands of tiny trips add up to a slow page.

This is why the bug ships dormant. In development, the database often runs on the same machine, so trips cost almost nothing, and a handful of rows is fast. It only wakes up when real data arrives.

## How to diagnose it

The usual tool, the slow-query log, finds nothing, because no individual query is slow. Instead, look at **how many** queries one request makes.

**1. Print the SQL.** Turn on SQL logging for one request, for example `logging.level.org.hibernate.SQL=DEBUG` in Spring Boot. Load the page. If you see the same statement repeated with only the ID changing, that is the pattern:

```text
select ... from customers where id=?
select ... from customers where id=?
select ... from customers where id=?
... (hundreds more)
```

**2. Count with Hibernate statistics.** Setting `spring.jpa.properties.hibernate.generate_statistics=true` makes Hibernate collect statement counts, which you can read from its `Statistics` object or see in the session metrics log. A page that runs thousands of statements is your suspect.

**3. Ask the database how often each query ran.** The database can keep a tally of every query it receives. In PostgreSQL this is done by an extension called `pg_stat_statements`. It treats queries that differ only in their values as one query, writing the value as a placeholder like `$1`. So 5,000 lookups of different customers show up as a single line with a count of 5,000.

It is switched off by default. To turn it on:

1. Add `pg_stat_statements` to `shared_preload_libraries` in the PostgreSQL settings, then restart PostgreSQL.
2. Run `CREATE EXTENSION pg_stat_statements;` once in your database.

Then reset the tally, load the slow page once, and list the queries by how many times they ran:

```sql
SELECT pg_stat_statements_reset();   -- start counting from zero

-- now load the page once, then run:
SELECT calls, query
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 5;
```

The reset may need extra privileges. If you cannot run it, load the page twice and compare the counts. The result looks like this (illustrative):

```text
 calls | query
-------+-----------------------------------------
  5000 | select ... from customers where id = $1
     1 | select ... from orders
```

One page load ran one query for the orders and 5,000 for the customers. That huge count on a cheap query is the N+1 problem.

**4. Look at an APM trace.** APM means application performance monitoring, a tool that records what each request did. Examples are Datadog, New Relic and Elastic APM, or OpenTelemetry with the free Jaeger viewer. They show one request as a tree of **spans**, the timed steps inside it. Open the trace of the slow page. A request with hundreds of identical, tiny database spans is a textbook N+1.

## Fix 1: fetch everything in one query

Tell the ORM to load the orders and their customers together, in one query, instead of asking for each customer later. This is called a **fetch join**:

```java
@Query("select o from Order o left join fetch o.customer")
List<Order> findAllWithCustomer();
```

This sends one query that returns every order with its customer already attached. Looping over the orders now sends no more queries. In Spring Data you can get the same effect with `@EntityGraph(attributePaths = "customer")`. Five thousand and one queries become one.

## Fix 2: fetch in batches

When you cannot join, tell the ORM to load related rows in groups. Instead of one query per customer, it asks for many at a time:

```properties
spring.jpa.properties.hibernate.default_batch_fetch_size=50
```

```sql
SELECT * FROM customers WHERE id IN (7, 12, 31, ... 50 ids);
```

Five thousand queries become roughly a hundred. It is not as good as one, but it is a one-line change, and it applies to every association without rewriting queries. Hibernate also has a `@BatchSize` annotation for finer control.

## Fix 3: load only what the page needs

Often the page does not need the whole `Customer`. It only shows the order number and the customer's name. So ask the database for just those two values. This is called a **projection**.

First, a small interface that lists the two values you want:

```java
public interface OrderSummary {
    Long getOrderId();
    String getCustomerName();
}
```

Then a query that returns only those two values:

```java
@Query("select o.id as orderId, c.name as customerName "
     + "from Order o left join o.customer c")
List<OrderSummary> findSummaries();
```

This sends one query, and the database returns only two columns instead of full order and customer rows. It is usually the fastest option, because it moves the least data.

## When the fix goes wrong

Each fix can create a new problem if you use it in the wrong place. These are the common ones.

**1. Joining two lists in one query (Fix 1).** A fetch join is safe when each order has *one* related object, such as one customer. But an order can also have *lists*: several items, and several payments. Joining both lists in one query goes wrong.

The database can only answer with a flat table, so it pairs every item with every payment. Take 2 orders, where each order has 3 items and 4 payments (illustrative). These are the rows for order 1:

```text
order | item | payment
------+------+--------
  1   | pen  | card-A
  1   | pen  | card-B
  1   | pen  | card-C
  1   | pen  | card-D
  1   | book | card-A
  1   | book | card-B
  1   | book | card-C
  1   | book | card-D
  1   | lamp | card-A
  1   | lamp | card-B
  1   | lamp | card-C
  1   | lamp | card-D
```

Order 2 has the same shape, so it adds 12 more rows. That is 3 × 4 = 12 rows for each order, 24 rows in all. But the real data is only 6 items and 8 payments, 14 pieces in total. Most rows are repeats: "pen" appears four times, once with each payment.

It gets much worse as the lists grow. With 10 items and 10 payments per order, each order gives 10 × 10 = 100 rows, so 100 orders become 10,000 rows. Hibernate has to sort them all back into orders, and the page becomes slow. Often Hibernate refuses and throws `MultipleBagFetchException` instead.

**What to do instead.** Split the work into separate queries, so the two lists never meet. It takes three steps:

1. **Join only the items.** Load the orders together with their items, in one query. Each row is now just one item of one order, so 100 orders with 10 items each give 100 × 10 = 1,000 rows, not 10,000.
2. **Leave the payments out of that query.** The page still needs them, so they stay lazy: Hibernate loads an order's payments when your code first reads them. If each order did that on its own, you would be back to the N+1 problem, with 100 more queries.
3. **Switch on batch fetching (Fix 2).** Now, when the code reads the payments of one order, Hibernate loads the payments of 50 orders in a single query. 100 orders need only 2 of these queries. The batch size counts orders, not rows, so 50 orders with 10 payments each means 500 rows per query.

For our 2 orders, the items query returns 6 rows, and the payments query returns 8 rows (both orders fit in one batch):

```text
items query              payments query
order | item             order | payment
------+------            ------+--------
  1   | pen                1   | card-A
  1   | book               1   | card-B
  1   | lamp               1   | card-C
  2   | mug                1   | card-D
  2   | cap                2   | card-E
  2   | bag                2   | card-F
                           2   | card-G
                           2   | card-H
```

That is 2 queries and 6 + 8 = 14 rows, with no repeats, instead of 24 rows before. The gap grows quickly with size. With 100 orders, each with 10 items and 10 payments:

- **Query 1, the items:** 100 orders × 10 items = 1,000 rows.
- **Queries 2 and 3, the payments:** 50 orders × 10 payments = 500 rows each, 1,000 in total.

That is 3 queries and about 2,000 rows, instead of 10,000 rows in one query.

In short: a join saves queries but can multiply rows, and batching keeps the rows low but sends more queries. Joining one list and batching the other keeps both numbers small.

**2. Joining a list and paging (Fix 1).** **Paging** means showing a long list a little at a time, for example 20 orders per page. Normally the database does this for you: you ask for "the first 20 rows" and it stops after 20.

That works when there is one row per order. But when you join a list, such as the items, there is one row per *item*. Say each order has 3 items. The first 20 rows are then only about 7 orders, and the last of them is cut in half, with some of its items missing.

The database cannot know how many rows make 20 whole orders, so Hibernate does not ask it to stop. It loads **every** order with all of its items into memory, and then picks out 20 orders in Java. With 100,000 orders, that is hundreds of thousands of rows in memory just to show one page. Hibernate writes a warning in the log when it does this.

Instead, do it in two steps:

1. Run one query for just the 20 orders on this page, with nothing joined.
2. Run a second query that loads the items of those 20 orders.

Now the database only ever returns what the page needs.

**3. Making everything `EAGER`.** It looks like an easy shortcut: always load the customer together with the order, so nobody has to think about it. But as shown earlier, eager does not remove the extra queries. Loading a list of orders still sends one query per customer.

The new problem is that eager applies **everywhere**. Say one page lists 5,000 orders and shows only the order number and the total. It never uses the customer.

- With a lazy link, that page sends 1 query.
- With an eager link, it sends up to 5,001 queries, to load customers that nobody looks at.

The same happens in every report, search and export that loads orders. So one setting can make pages slower that were fine before. Instead, keep the links lazy, and let each page fetch what it needs with Fix 1, 2 or 3.

**4. Silencing `LazyInitializationException`.** Remember that lazy data is fetched later, when your code first touches it. To fetch it, Hibernate needs its **session**: the open connection between your code and the database. In many applications the session closes when the method that loaded the data finishes.

If your code touches lazy data after that, there is no session left to ask the database, and Hibernate throws this error:

```java
// the session closes when findAll() returns
List<Order> orders = orderService.findAll();

// error: there is no session left to load the customer
orders.get(0).getCustomer().getName();
```

The error message ends with "could not initialize proxy - no Session". It is annoying, so people silence it in one of two ways:

- **Switch the link to `EAGER`.** This brings back problem 3.
- **Keep the session open for the whole request.** Spring Boot's "open session in view" setting does this, and it is on by default in web applications. Lazy loading then works anywhere, even in a controller or a page template, so a loop can quietly send hundreds of queries again.

Both hide the error and keep the N+1 problem. The error is actually telling you something useful: you are asking for data you did not load. Instead, fetch what you need before the method finishes, with Fix 1, 2 or 3.

**5. A huge batch size (Fix 2).** The batch size is how many IDs go into one query. With a batch size of 50, loading 100 customers takes 2 queries, each ending in `WHERE id IN (...50 IDs...)`. That is fine.

It is tempting to think a bigger number is always better, because it means fewer queries. Say you set 5,000 and then load 5,000 customers. You get one query with a list of 5,000 IDs in it. That has problems of its own:

- The query text is huge, and the database takes longer to read and plan it.
- Some databases refuse it. For example, Oracle allows at most 1,000 values in one `IN` list.
- If a page needs only 3 customers, a very large batch size gives you no extra benefit, only a risk.

Start with a modest number, in the tens, then measure the page with your real data and adjust.

## Which should you use?

| Situation | Reach for |
|---|---|
| One page needs a related object for every row | **Fetch join** or `@EntityGraph` |
| Many associations, rarely all needed | **Batch fetching** (the global default size) |
| A list or report that shows a few columns | **A projection** with only those columns |
| Related data is a collection and you also need paging | **Two queries:** page the parent, then fetch the children by ID |
| A loop calls `findById` for each row | **`findAllById`** once with all the IDs |

N+1 also hides in collections, such as `order.getItems()` inside a loop, and in hand-written loops that call a repository once per row. The fixes above apply to both.

If you are not sure, turn on SQL logging for your three most visited pages and count. You will probably find one. If one query really is slow, that is a different problem, such as a missing index, and `EXPLAIN` shows how the database runs it.

## The takeaway

1. The ORM fetches related data one row at a time, either on first use (**lazy**) or straight away (**eager**), so a list can quietly send one query per row: the **N+1 problem**.
2. It stays hidden because small data is fast. The cost grows with row count, and the code never changes.
3. No single query is slow, so the **slow-query log misses it**. Count queries per request instead.
4. Fix it with a **fetch join**, **batch fetching** or a **projection**, depending on what the page needs.