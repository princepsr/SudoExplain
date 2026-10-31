---
title: Sessions vs JWT: where does your login actually live?
date: 2026-10-31
description: Both answer "who is this request from?". The real difference is where the state lives, and who pays when you need to log someone out.
tags: authentication, web, system-design
---

## The doubt

Every article says the same thing: *sessions are stateful, JWTs are stateless, so JWTs scale better.* Then you build an app with JWTs and discover it still hits the database on every request. Logging a user out doesn't really work. And somehow you also ended up storing a "refresh token" on the server.

So what did "stateless" actually buy you?

## The misconception

I used to think JWT was the modern replacement and sessions were the old way. That framing hides the real point: **both solve the same problem**. HTTP has no memory, so every request has to prove who sent it. The only question is *where the memory lives*.

- **Sessions** keep the memory on the server. The browser carries a meaningless ticket number.
- **JWTs** put the memory in the token. The server keeps nothing and re-checks a signature instead.

Neither is free. You are choosing where to pay.

## How a session works

After you log in, the server creates a record and gives the browser only its ID:

```text
POST /login            -> 200 OK
Set-Cookie: sid=9f3c2a...; HttpOnly; Secure; SameSite=Lax

GET /orders
Cookie: sid=9f3c2a...
```

The cookie value is just a random lookup key. Everything meaningful (the user, their roles, the cart) sits in a store on the server. Every request does a lookup:

```java
// Pseudo-code
Session session = sessionStore.get(request.cookie("sid"));  // read from the store
User user = session.user();
```

This has a great property: **the server is in control.** To log someone out, delete the record. To change a user's permissions, update the record. The next request sees it.

The cost shows up when you run more than one server. Request one lands on server A and creates the session in A's memory. Request two lands on server B, which has never heard of you. There are three standard fixes:

1. **Sticky sessions**: the load balancer always sends you to the same server. Simple, but if that server dies, you are logged out.
2. **A shared session store** (a database, Redis, a distributed cache): every server reads the same records. Robust, but now every request makes a network call.
3. **Replicate sessions between servers**: works for small clusters, gets heavy as you grow.

## How a JWT works

A JWT is three base64 chunks joined by dots: `header.payload.signature`. The payload carries the facts about you:

```json
{
  "sub": "42",
  "role": "admin",
  "iat": 1793490000,
  "exp": 1793493600
}
```

The server signs those three parts with a secret (or a private key). When a request arrives, the server checks the signature. If it matches, the claims are trusted. **There is no lookup and no shared store**, just maths:

```java
// Pseudo-code
Claims claims = verifier.verify(request.bearerToken());  // CPU only, no network call
User user = new User(claims.subject(), claims.role());
```

Any server that knows the verification key can do this, which is why JWTs fit multiple servers and multiple services so well. With public-key signing, services only need the *public* key to verify tokens, so they can't mint new ones.

### One thing that surprises people

A JWT is **signed, not encrypted**. Anyone holding the token can read it:

```javascript
const [header, payload] = token.split('.');
const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
console.log(claims);
// { sub: "42", role: "admin", exp: 1793493600 }
```

The signature stops people *changing* the claims. It does nothing to stop people *reading* them. Never put secrets, personal data you wouldn't show the user, or anything sensitive in the payload.

## The catch: revocation

Here is where the doubt from the start gets answered.

A JWT is valid until it expires. The server isn't looking anything up, so it has no way to say "actually, this one is no good any more". That is a problem when:

- a user logs out
- an account is disabled
- a role is removed
- a token is stolen

The usual answer is to make tokens **short-lived** (say, 5 to 15 minutes) and pair them with a **refresh token**. When the short token expires, the client trades the refresh token for a new one. Here's the catch: **the refresh token is checked against a server-side record**, so you can revoke it. You have rebuilt a session, just a smaller one that is consulted every few minutes instead of every request.

The other option is a **denylist** of revoked token IDs that every server checks. That is also state, and also a lookup.

So "stateless" was always slightly misleading. The honest version is: *JWTs let you keep state out of the hot path, and you pay for it with weaker, slower revocation.*

## Where the token lives in the browser

This decision matters as much as the choice of session or JWT.

| Storage | Readable by JavaScript? | Main risk |
|---|---|---|
| `localStorage` | Yes | A single XSS bug leaks the token |
| `HttpOnly` cookie | No | CSRF, reduced by setting `SameSite` explicitly |

An `HttpOnly` cookie is the safer default for browser apps, and it works for JWTs too. You can store a JWT in a cookie. People often assume JWT means `localStorage`, but that was a convention, not a rule.

## So which one?

Rules of thumb that have held up for me:

| Situation | Reach for |
|---|---|
| One web app, one backend, users log in through a browser | **Sessions.** Simple, easy to revoke, nothing clever to get wrong |
| Several services that need to trust the same login | **Tokens (JWT).** Each service verifies locally |
| Mobile apps or third-party API clients | **Tokens.** There is no cookie jar to lean on |
| You must be able to kick a user out *right now* | **Sessions**, or very short tokens with a revocable refresh token |

If you are not sure, start with sessions. Move to tokens when you actually feel the pain of sharing login state across services, not because a blog post said tokens are modern.

## The takeaway

Sessions and JWTs are two answers to *where does the memory live?*

- **Sessions:** memory on the server. Easy to revoke, costs a lookup, harder to spread across servers.
- **JWT:** memory in the token. Cheap to verify anywhere, painful to revoke.

"Stateless" doesn't mean the state disappeared. It means you moved it, and the moment you need to revoke something, it comes back.
