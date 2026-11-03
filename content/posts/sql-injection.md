---
title: SQL injection: how one quote breaks your login
date: 2026-11-01
description: How SQL injection lets one typed quote rewrite your query and bypass a login, how to find it in your code, and how parameterized queries stop it.
tags: security, SQL, java
draft: true
---

## The question

A login form takes a username and a password. The code builds a database query from them and checks whether a row comes back. It has worked for years. Then a tester types a single quote and a few words into the password box and is logged in as a real user, without knowing the password.

The password check did not fail. It was **rewritten**.

> I only asked the database a question about the typed text. How did the typed text change the question?

Because the code glued the text into the question. The database cannot tell which part was the programmer's and which part was typed.

> [!SUMMARY]
> By the end you will know:
>
> 1. How **SQL injection** turns user text into SQL code
> 2. How to **find it** in code and logs, and test for it safely on your own database
> 3. The real fix, **parameterized queries**, with a correct Java example
> 4. The traps: second-order injection, `ORDER BY`, ORM string queries, `LIKE` and "fixes" that are not fixes

## First, data versus code

**SQL** is the language used to ask a relational database for data, for example `SELECT id FROM users WHERE name = 'alice'`. A query has two kinds of content. The **structure** says what to do (`SELECT`, `WHERE`, `AND`). The **values** are the data it works on (`'alice'`).

Think of a form letter with blanks. The letter text is fixed, and you only fill in names. SQL injection is a person who writes in the blank: "and also send them my bank balance". The analogy stops at one point: the database reads the finished letter as one piece, so it cannot tell where your blank was.

## The failure: string concatenation

Here is the vulnerable pattern in Java. It builds the query by joining strings with `+`:

```java
String sql = "SELECT id FROM users WHERE name = '" + name
           + "' AND password_hash = '" + pass + "'";
```

With the normal input `alice` and `hash-of-secret`, the query is:

```sql
SELECT id FROM users WHERE name = 'alice' AND password_hash = 'hash-of-secret'
```

Now suppose the second value is `' OR '1'='1`. The finished query becomes:

```sql
SELECT id FROM users WHERE name = 'alice' AND password_hash = '' OR '1'='1'
```

In SQL, `AND` binds tighter than `OR`. The condition reads "(name is alice and password is empty) **or** 1 equals 1". The second part is always true, so every row matches and the login succeeds. The quote in the input closed the string early, and the rest became code.

```diagram
type: sequence
alt: A login form sends text with a quote to the app, which joins it into SQL and the database returns a row for a wrong password.
caption: Figure 1. The quote ends the string early, so the typed text becomes part of the query.
actors: Browser | App | Database
Browser -> App: password = ' OR '1'='1
App -> Database: ... password_hash = '' OR '1'='1'
note App: text was glued into the query !
Database --> App: 1 row matched !
App --> Browser: login succeeded
```

I ran this against an in-memory H2 database (a small Java database) with both versions of the code. The glued query logged in with a wrong password. The parameterized version, shown below, rejected it. In real systems the same trick reads data from other tables, changes rows or, with powerful database accounts, reaches the server itself.

> [!WARNING]
> Test for SQL injection only on systems you own or have written permission to test, and only against a test database. Probing other people's systems is illegal in most places, even when "just looking".

## Why it is still common

OWASP, a nonprofit that publishes web security guidance, has listed injection near the top of its Top 10 for many years (first in 2017, third in 2021, fifth in 2025). The reasons are boring. String building is the first thing a beginner learns. Quick scripts and reports grow into production code. And one forgotten concatenated query in a thousand safe ones is enough.

## How to diagnose it

**1. Search the code for string-built queries.** Look for SQL keywords inside strings that are joined with `+` or `String.format`:

```bash
grep -rnEi '"[^"]*(select|insert|update|delete)[^"]*"\s*\+' src/
grep -rnE '(createQuery|createNativeQuery|executeQuery|executeUpdate)\(.*\+' src/
```

These patterns catch the common shapes, but not all. A query built across several lines or in a helper method needs a careful read. Review every query that includes a variable you did not write yourself.

**2. Read the logs and error messages.** Attack attempts often leave a single quote, `--`, `UNION SELECT` or `OR 1=1` in request logs. Database errors such as "syntax error near" with user text inside them mean the text reached the parser as code. Treat those as a strong sign.

**3. Test safely on your own test database.** In a test environment, enter a single quote `'` in each field. A database error, or a page that behaves differently, suggests that the input reaches a query unescaped. Use the harmless `' OR '1'='1` only against your own test data. Static analysis tools and OWASP's testing guide can automate this.

**4. Check database permissions.** If the application account can drop tables or read every schema, a small bug becomes a large breach. See fix 4.

## Fix 1: parameterized queries

The fix is to send the structure and the values **separately**. A **parameterized query** (also called a prepared statement) puts a `?` marker where each value goes. The driver sends the structure and the values separately, so the values are only ever treated as data. (Some drivers, such as MySQL's Connector/J by default, escape the values on the client instead. That is still safe with a prepared statement.)

```java
String sql = "SELECT id FROM users WHERE name = ? AND password_hash = ?";
try (PreparedStatement ps = connection.prepareStatement(sql)) {
    ps.setString(1, name);
    ps.setString(2, pass);
    try (ResultSet rs = ps.executeQuery()) {
        return rs.next();
    }
}
```

With the input `' OR '1'='1`, the database looks for a password that literally equals that text. Nothing matches. The attack becomes an ordinary wrong password.

The cost is almost nothing. Prepared statements can be faster when a driver reuses a server-side plan, but do not count on it. The security benefit is the reason to use them. The one rule is that you must **never** concatenate input into the SQL text before calling `prepareStatement`. That throws away the protection.

(A real login would also compare a salted password hash in code, not in SQL. The query here is only to show the mechanism.)

## Fix 2: use ORMs and builders correctly

An **ORM** (object-relational mapper) such as Hibernate writes SQL for you. Its generated queries are safe. Its **string queries** are not, when you build them by hand. HQL and JPQL are the query languages of Hibernate and JPA, and native queries are raw SQL.

```java
// Vulnerable: input is glued into HQL
session.createQuery("from User u where u.name = '" + name + "'");

// Safe: a named parameter
session.createQuery("from User u where u.name = :name", User.class)
       .setParameter("name", name);
```

The same applies to Spring Data's `@Query` and to native queries. Use `:name` or `?1` parameters. OWASP's cheat sheet states that Hibernate queries can be vulnerable to injection, and says to bind untrusted values rather than concatenate them.

## Fix 3: allow-lists for what cannot be a parameter

Parameters carry **values** only. They cannot stand in for a column name, a table name or `ASC` and `DESC`. For `ORDER BY name`, map the choice to a fixed set that **you** own:

```java
private static final Map<String, String> SORTABLE =
        Map.of("name", "name", "created", "created_at");

String col = requested == null ? "created_at" : SORTABLE.getOrDefault(requested, "created_at");
String dir = "desc".equalsIgnoreCase(direction) ? "DESC" : "ASC";
String sql = "SELECT id, name FROM customers ORDER BY " + col + " " + dir;
```

I compiled and ran this. A request like `name; DROP TABLE x` falls back to `created_at`. Only strings from your own map ever reach the SQL.

## Fix 4: least privilege

Give the application's database account only what it needs: usually `SELECT`, `INSERT`, `UPDATE` and `DELETE` on its own tables, and no admin rights. OWASP lists this as a way to **limit the damage** of an attack, not to prevent it. It is a second wall, not the first.

## Why escaping is not the fix

Escaping means adding a backslash or doubled quote before special characters. OWASP strongly discourages it. Rules differ between databases and settings, and one missed character or setting change breaks it. Parameters never need escaping, because the value never becomes code.

## When the fix goes wrong

Parameters fix the query they are used in. They do not fix queries you forgot, and they do not fix everything that touches the database. These three are the easiest to miss.

**1. Second-order injection.** You switched the sign-up code to parameters, so it is safe. A user registers with the name `admin'--`. The `INSERT` stores that text exactly as typed, with no harm done. Everyone relaxes.

Weeks later, another part of the app, such as "change my password", reads the name from the database and glues it into a query, because "it is our own data":

```sql
UPDATE users SET password_hash = 'new-hash'
WHERE name = 'admin'--'
```

In many databases, `--` starts a comment, so the rest of the line is ignored. The query now changes the password of the real `admin`, not of the attacker. The attacker never typed anything harmful into that page. The harm was planted earlier and waited.

**What to do instead.** Stored data is not trusted data. Use parameters every time a value goes into a query, whatever its source: a form, a file, an API, or your own database. Search the code for every query built with `+`, not only the ones that read from the web.

**2. Safe at one layer only.** The application uses a parameterized call, such as `CALL find_user(?)`. The call is safe. But inside the **stored procedure** (code saved in the database), the author builds a new SQL string from the argument and runs it as dynamic SQL. The argument now becomes code, one layer down, and the application's parameters cannot help.

**What to do instead.** Inside the procedure, write the query with the argument as a normal value. If you must build SQL at run time, pass the values as parameters of the dynamic statement too. Databases support this, for example PostgreSQL's `EXECUTE ... USING` and SQL Server's `sp_executesql`.

**3. `LIKE` wildcards.** In a search box you write `WHERE name LIKE ?`, and bind the typed text plus a `%` at the end. This is safe from injection. But `%` and `_` are special inside `LIKE`: `%` matches any text and `_` matches one character. A user who types just `%` makes the pattern `%%`, which matches every row. On a "find a customer" page, that lists the whole customer table. It can also be slow, because the database has to scan many rows.

**What to do instead.** Before you bind the term, escape `%`, `_` and the escape character itself, so they are treated as plain text. Then name the escape character in the query (here `!`, so escape `!`, `%` and `_` by putting `!` before each), as in `LIKE ? ESCAPE '!'`. The default escape character differs between databases, so declare it, and keep a limit on how many rows a search can return.

Smaller pitfalls:

- **Client-side validation only.** A browser check is a convenience. An attacker sends requests directly, so the server must be safe on its own.
- **Verbose errors.** A page that prints the failed query or a stack trace teaches attackers your table names. Log details on the server, and show users a generic message.
- **Validation as the only defense.** Rejecting the word `DROP` blocks the harmless and misses the clever. Use it as an extra layer.

## Which should you use?

| Situation | Reach for |
|---|---|
| Any value from a user, file or API | **Parameterized query** |
| HQL, JPQL or native query in an ORM | **Named parameters**, never string joins |
| Column name or sort direction from a user | **Allow-list map** |
| Damage if something slips through | **Least-privilege account** |
| Stored data used in later queries | **Parameters again**, every time |

If you are not sure whether a query is safe, ask whether any part of its text came from outside your code. If yes, use a parameter, or an allow-list for names.

## The takeaway

1. SQL injection happens when **user text is joined into a query**, so it becomes code instead of data.
2. Find it by searching for **string-built queries** and by watching logs and errors for stray quotes and SQL keywords.
3. The fix is the **parameterized query**. Never join input into the SQL text before preparing it.
4. ORM string queries are not safe by themselves. Use **named parameters**, and an **allow-list** for column names and sort order.
5. Escaping and keyword blocking are not fixes. Add **least privilege** and generic error messages as extra layers.
