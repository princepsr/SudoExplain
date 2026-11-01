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
> 1. What the **N+1 problem** is and how lazy loading creates it without any visible sign in the code
> 2. Why it stays hidden in development and arrives with data growth
> 3. How to **diagnose** it, even though no single query is slow
> 4. The fixes (fetch joins, batching, projections) and how each can backfire

## First, what an ORM does

Your data lives in database tables, as rows and columns. Your Java code works with objects, such as an `Order` with a `customer` and a `total`. Moving data between the two by hand is tedious: you write the SQL, read each column of the result, and copy it into the right field, again and again.

An **ORM** (object-relational mapper) does that copying for you. You describe which class matches which table. After that you ask for an `Order` object, and the ORM sends the SQL (`SELECT * FROM orders WHERE id = 5`) and fills in the object from the row. You write far less code, and you rarely see the SQL.

Two names come up all the time:

- **JPA** is the standard way to describe the matching in Java, using annotations such as `@Entity` and `@ManyToOne`. It is only a written set of rules. It does no work by itself.
- **Hibernate** is a library that follows those rules and does the real work of building the SQL. Spring Boot's data support uses it by default, so most Java projects run it, even when nobody on the team chose it on purpose.

That hidden SQL is where this post's problem comes from, so keep it in mind: the ORM sends queries that you never wrote.

## Then, lazy loading

An `Order` has a `Customer`, and a `Customer` has its own addresses, orders and more. If the ORM loaded all of that every time you asked for one order, it would read far more data than you need. So related data can be **lazy**: it is fetched only when your code first touches it.

You mark the link as lazy like this:

```java
@ManyToOne(fetch = FetchType.LAZY)
private Customer customer;
```

Be careful: in JPA the default for `@ManyToOne` is **EAGER**, meaning loaded immediately. That gives the same N+1, just earlier, inside the query call itself.

With the mapping above, loading the orders does not load their customers. A customer is fetched the first time you call `order.getCustomer()`.

```java
List<Order> orders = orderRepository.findAll();            // 1 query: all the orders

for (Order order : orders) {
    System.out.println(order.getCustomer().getName());     // 1 query for EACH new customer
}
```

The loop looks innocent. There is no query in sight. But each call to `getCustomer()` quietly sends one:

```sql
SELECT * FROM orders;                      -- 1 query
SELECT * FROM customers WHERE id = 7;      -- then one per different customer...
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

One query for the list, plus **N** more, one per row. That is the **N+1 problem**. Strictly, it is one query per different customer, because a customer already loaded in the same session is served from memory. Thousands of different customers still means thousands of queries.

## Why it appears only in production

The cost grows with the data, and the code never changes:

| Orders on the page | Queries | At about 2 ms each |
|---|---|---|
| 10 (development) | 11 | 22 ms |
| 500 | 501 | 1 second |
| 5,000 | 5,001 | 10 seconds |

These counts assume every order has a different customer. A customer who appears twice is loaded once and served from memory the second time, so 5,001 is the worst case.

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

**3. Check the database's statistics.** In PostgreSQL, the `pg_stat_statements` extension records how many times each query ran. It must be enabled first ([the slow query post](/posts/slow-query-missing-index/) shows how), and it replaces the ID with a placeholder, so all the repeated lookups collapse into one row. Sort by call count:

```sql
SELECT calls, query
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10;
```

A cheap query with a call count in the millions stands out immediately.

**4. Look at an APM trace.** APM means application performance monitoring, a tool that records what each request did. It shows one request as a tree of **spans**, the timed steps inside it. A request with hundreds of identical, tiny database spans is a textbook N+1.

**5. Count queries in a test.** The best fix for the future is a test that loads the page with, say, 20 rows and asserts that the number of queries is small and **does not depend on the row count**. Hibernate's statistics, or a library that wraps the data source, can count them.

## Fix 1: fetch everything in one query

Tell the ORM to load the related data together, with a **fetch join**. A join combines rows from two tables in one query:

```java
@Query("select o from Order o left join fetch o.customer")
List<Order> findAllWithCustomer();
```

That runs a single query that joins the two tables. Use `left join` if the customer is optional, because a plain `join` silently drops orders that have none. In Spring Data you can get a similar effect with `@EntityGraph(attributePaths = "customer")`. Five thousand and one queries become one.

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

Often the page does not need the whole `Customer`. It needs a name. Ask for exactly that with a **projection**, a query that returns just the selected columns:

```java
@Query("select o.id as orderId, c.name as customerName from Order o join o.customer c")
List<OrderSummary> findSummaries();     // OrderSummary is a small interface
```

This is usually the fastest option, because it moves less data and builds no entity objects. An **entity** is a Java object that the ORM maps to a table row. This `join` also drops orders without a customer, so use `left join` if that matters.

## When the fix goes wrong

- **Fetching two collections in one query.** A fetch join across two lists multiplies the rows: 100 orders with 10 items and 10 payments become 10,000 rows. Hibernate may throw `MultipleBagFetchException`, or the page gets slow in a new way.
- **Fetch join with paging.** Joining a collection and asking for "page 1, 20 items" makes Hibernate load the **whole** result into memory and page there, with a warning in the log. Page the parent query first, then fetch the children in a second query.
- **Making everything `EAGER`.** Marking the association `FetchType.EAGER` does not remove the problem. A query such as `findAll()` still runs N more queries, and now every use of the entity pays, whether it needs the customer or not.
- **Silencing `LazyInitializationException`.** If lazy data is touched after the session closes, Hibernate throws this error. Switching to `EAGER` or keeping the session open for the whole request hides the error and keeps the N+1. Fetch what you need up front instead.
- **A huge batch size.** `IN` lists of thousands of IDs make slow queries of their own, and some databases cap their length.

## Which should you use?

| Situation | Reach for |
|---|---|
| One page needs a related object for every row | **Fetch join** or `@EntityGraph` |
| Many associations, rarely all needed | **Batch fetching** (the global default size) |
| A list or report that shows a few columns | **A projection** with only those columns |
| Related data is a collection and you also need paging | **Two queries:** page the parent, then fetch the children by ID |
| A loop calls `findById` for each row | **`findAllById`** once with all the IDs |
| You want to stop it returning | **A query-count test** in your build |

N+1 also hides in collections, such as `order.getItems()` inside a loop, and in hand-written loops that call a repository once per row. The fixes above apply to both.

If you are not sure, turn on SQL logging for your three most visited pages and count. You will probably find one. If one query really is slow, see [the slow query post](/posts/slow-query-missing-index/).

## The takeaway

1. **Lazy loading** fetches related data on first use, so a loop can quietly send one query per row: the **N+1 problem**.
2. It stays hidden because small data is fast. The cost grows with row count, and the code never changes.
3. No single query is slow, so the **slow-query log misses it**. Count queries per request instead.
4. Fix it with a **fetch join**, **batch fetching** or a **projection**, depending on what the page needs.
5. Guard against it coming back with a test that asserts the **query count does not grow with the data**.
