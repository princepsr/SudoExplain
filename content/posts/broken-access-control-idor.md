---
title: Broken access control (IDOR): seeing others' data
date: 2026-11-01
description: How changing one number in a URL can expose another customer's data even for a logged-in user, how to test for it, and how to enforce ownership on the server.
tags: security, authorization, apis
draft: true
---

## The question

A customer opens their invoice. The address bar says `/invoices/1001`. Out of curiosity, they change it to `/invoices/1002` and see **another customer's invoice**, with name, address and amounts.

The login worked. The session is valid. The app checked who they are. Yet it still showed the wrong data.

> The user is properly logged in. Why did the app let them see someone else's invoice?

Logging in proves **who you are**. It says nothing about **what you may see**. Those are two separate checks, and the second one was missing.

> [!SUMMARY]
> By the end you will know:
>
> 1. The difference between **authentication** and **authorization**, and where this bug lives
> 2. What an **insecure direct object reference (IDOR)** looks like in code
> 3. How to **test** for it in minutes with two accounts
> 4. How to enforce ownership on the server, and the ways that enforcement still slips

## First, two different questions

Think of a hotel key card. Showing your ID at the desk proves you are a guest. The card then opens only your room. The bug here is a card that opens **every** room, if you simply walk up to the door and try it. The analogy stops at roles: real systems also decide by what the user is allowed to do, not only by which door it is.

- **Authentication** asks: *who are you?* A password, a session or a token answers it.
- **Authorization** asks: *are you allowed to do this to this thing?* Your role, and who **owns** the thing, answer it.

The bug lives in the gap between them. The app knows the caller is user 42, then loads invoice 1002 without asking whether invoice 1002 belongs to user 42. This class of bug has a name, **broken access control**. It was number one on the OWASP Top 10 in 2021, and it stayed there in the 2025 edition. OWASP is a nonprofit that publishes web security guidance.

The specific form, where the caller picks an object by its ID, is called an **insecure direct object reference**, or **IDOR**. In API security lists, the same bug is called **broken object level authorization (BOLA)**.

## The failure: trusting the ID in the request

```java
@GetMapping("/invoices/{id}")
public Invoice get(@PathVariable long id) {
    return invoiceRepository.findById(id).orElseThrow();    // loads ANY invoice
}
```

The method does what it says: it finds the invoice with that ID. Nothing connects the invoice to the person asking.

```diagram
type: sequence
alt: A logged-in user asks for invoice 1002. The server loads it without checking the owner and returns it.
caption: Figure 1. The server checks the login, then loads whatever ID it is given, with no ownership check.
actors: User 42 | Server | Database
User 42 -> Server: GET /invoices/1002 (valid login)
Server -> Database: find invoice 1002
Database --> Server: invoice of user 77
Server --> User 42: invoice of user 77 !
note Server: never asked who owns it !
```

An attacker can then walk through the numbers:

```bash
for id in 1000 1001 1002 1003; do
  curl -s -H "Authorization: Bearer <my-token>" https://example.com/invoices/$id
done
```

> [!WARNING]
> Run a loop like this only against a system you own or have written permission to test, and only with your own test accounts. Probing other people's IDs on a real service can be illegal.

With sequential IDs, this is trivial, and it is called **enumeration** (trying IDs one after another). The same hole opens on writes: `PUT /users/55` to change someone else's email, or `DELETE /orders/9001`.

Hiding the link in the interface does not help. The server is the only place that can enforce the rule, because the client can always send any request it likes.

## How to diagnose it

**1. Test it with two accounts.** This takes minutes, and finds most cases. Log in as user A and note the ID of one of A's objects. Log in as user B, and request A's object with B's credentials. Anything other than "not found" or "forbidden" is a bug. Burp Suite's Autorize extension replays your requests with a lower-privileged user's credentials, and OWASP ZAP's Access Control Testing add-on compares what each configured user can reach.

**2. Review every endpoint that takes an ID.** Path parameters, query parameters and fields in a JSON body such as `{"accountId": 7}`. For each, find the line that checks ownership. If you cannot find it, there probably is not one. Searching controllers for `findById(` is a quick start.

**3. Look at the logs.** Search for successful responses where the resource's owner differs from the caller. If you do not log ownership, that gap is itself worth fixing.

**4. Automate it.** Write a test that, for every endpoint, uses a second user to request the first user's data and expects a denial. Run it in your build.

## Fix 1: put the owner in the query

The safest pattern is to make it **impossible** to load an object that is not yours, by including the owner in the lookup:

```java
@GetMapping("/invoices/{id}")
public Invoice get(@PathVariable long id, @AuthenticationPrincipal UserPrincipal user) {
    return invoiceRepository.findByIdAndCustomerId(id, user.customerId())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
}
```

Here `UserPrincipal` is your own class for the logged-in user, and it carries the `customerId`. Notice two things. The user's identity comes from the **authenticated session or token**, never from a field the client sends. And the answer for "not yours" is **404 Not Found**, not 403 Forbidden. A 403 confirms that the invoice exists, which helps an attacker map your data.

The trade-off: 404 makes debugging harder, so log the denial on the server. And when the user may see the object but not do this particular action, 403 is the honest answer.

## Fix 2: one central rule, denied by default

Checks sprinkled by hand get forgotten. Put authorization in one layer, so every endpoint goes through it. **Deny by default** means that if no rule allows an action, it is refused. In Spring, method security can express the rule next to the method:

```java
@PreAuthorize("@invoiceAccess.canView(#id, authentication)")
@GetMapping("/invoices/{id}")
public Invoice get(@PathVariable long id) { ... }
```

Be careful, because this does not deny by default on its own:

- The annotation does nothing unless method security is switched on with `@EnableMethodSecurity`.
- A method with no annotation is open to **every logged-in user**. `anyRequest().authenticated()` only requires a login.
- The `#id` name in the expression needs parameter names at runtime. Compile with `-parameters`, because Spring Framework 6.1 and later no longer reads debug information. Spring Boot's Gradle plugin does this for you, or you can annotate the parameter with `@P("id")`.

To really deny by default, end your URL rules with `.anyRequest().denyAll()` and permit routes explicitly. Add a test (a tool such as ArchUnit can do this) that fails when a controller method has no authorization rule. A new endpoint then **fails closed** (refused) until someone writes its rule, instead of **failing open** (allowed) until someone remembers.

## Fix 3: IDs that are hard to guess, as a second layer

Using random identifiers such as UUIDs instead of 1001, 1002 makes enumeration impractical. Prefer random version 4 UUIDs, since time-ordered ones are partly guessable and reveal when a record was created. This is useful **defense in depth** (several independent protections, so one failure is not fatal), but it is not access control. An ID can leak through a log, a shared link or a browser history, and once it does, an unprotected endpoint hands over the data.

For multi-tenant data, where many customers share one database, a database-level backstop such as PostgreSQL row-level security or a Hibernate filter adds another layer.

## When the fix goes wrong

Even a correct ownership check can leave holes. These three matter most.

**1. Side doors.** After Fix 1, `GET /invoices/{id}` checks the owner. But the same data may leave through other routes: a batch call such as `GET /invoices?ids=1001,1002,1003`, a CSV export, a PDF download, a search. Each one is separate code. If the batch route calls `findAllById(ids)`, it returns all three invoices, whoever owns them. The fix and the test covered one door, and the others stayed open.

**What to do instead:** put the owner rule in one shared place that every route uses, such as a repository method like `findAllByIdInAndCustomerId`, or a central policy. Then list every route that touches the data, and make the two-account test hit all of them, including list, batch, export and download.

**2. Trusting a role from an old token.** A JWT (a signed login token, covered in the [sessions post](/posts/sessions-jwt-and-load-balancers/)) carries claims, such as a role, that were true when it was issued. The server does not ask again while the token is valid. Say a token is issued at 09:00 and lasts one hour. At 09:10 you remove the user's admin role. The token still says "admin", so the user keeps admin power until 10:00, 50 more minutes.

**What to do instead:** keep tokens short-lived, for example 5 minutes, so a stale role fades quickly. For sensitive actions, such as deleting data, exporting it or changing roles, read the user's current role from your database instead of trusting the token. This costs one lookup per sensitive request, which is cheap for the safety it buys.

**3. Mass assignment.** This happens when the server copies a whole JSON body onto an object. This is illustrative, not run:

```java
// Unsafe: the client can set any field of User
@PutMapping("/users/me")
public User update(@RequestBody User body) {
    return userRepository.save(body);
}
```

The page only sends `{"email": "new@example.com"}`. But a user can send `{"email": "new@example.com", "role": "ADMIN"}` by hand, and now they are an admin. A field like `"ownerId": 5` can move a record to someone else the same way. Hiding the field in the form does nothing, because the client can send any JSON it likes.

**What to do instead:** accept a small class that lists only the fields you allow, and copy them over yourself:

```java
// Safe: only these fields can come from the client
record UpdateProfile(String email, String displayName) {}
```

Smaller traps:

- **Checking `GET` but not `PUT` and `DELETE`.** Writes are the more dangerous half. Cover every method.
- **A filtered list but an unprotected detail page.** The list shows only your items, but `/items/{id}` returns anyone's. Check both.
- **Authorization only in the interface.** Hiding a button is a usability feature. The server must refuse the request itself.
- **Caching a protected response.** If a cache stores `/invoices/1002` by URL alone, the next user may receive the stored copy. The [stale caches post](/posts/stale-caches-explained/) covers caches: personal data needs the user in the cache key, or no caching.

## Which should you use?

| Situation | Reach for |
|---|---|
| Any endpoint that takes an ID | **Look up by ID and owner together** |
| Many endpoints, many developers | **A central policy,** denied by default |
| Exposing identifiers in URLs | **Random IDs** as a second layer, never the only one |
| Roles and permissions that can change | **Check against current data** for sensitive actions |
| Making sure it stays fixed | **Two-account tests** for every endpoint, in the build |

If you are not sure whether an endpoint is safe, ask one question: "If I change this ID to someone else's, what stops me?" If the answer is "nothing", fix it before anything else.

## The takeaway

1. **Authentication** says who you are. **Authorization** says what you may touch. Logging in only does the first.
2. An **IDOR** is an endpoint that loads an object by an ID from the request without checking the caller owns it.
3. Test it with **two accounts**, and review every endpoint that accepts an ID, on **every** HTTP method.
4. Enforce ownership **on the server**, in the query, with the identity taken from the session or token. Answer "not yours" with 404 where hiding existence matters.
5. Centralize the rule and **deny by default**. Random IDs and hidden buttons help, but they are not protection.
