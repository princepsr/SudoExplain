---
title: Sessions, JWTs and load balancers explained
date: 2026-10-31
description: A beginner's walkthrough: what sessions and JWTs are, what breaks when you add a second server, how to diagnose it, and how to fix it.
tags: authentication, web, system-design, scaling
---

## The question

Picture a website where you log in. You click "My orders", and it greets you by name. The site **remembers who you are**. That memory is called a **session**.

Now picture a busy website that is not run by one computer, but by three identical ones. A gatekeeper stands in front of them and sends each click to whichever computer is free. That gatekeeper is called a **load balancer**.

Here is the puzzle:

1. You log in. Your click goes to **Computer 1**, which remembers you.
2. You click "My orders". The gatekeeper sends this one to **Computer 2**.
3. Computer 2 was never told about your login. To it, you are a stranger.

> If one computer remembers me, how does the next one know who I am?

That was my question. Big websites with millions of users clearly solve it, so the answer must exist. It only makes sense after a few basics, so we start there. I won't assume you know any of these words.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a session is, and what a JWT is
> 2. What a load balancer does, and why it breaks naive sessions
> 3. How to **diagnose** the problem when it happens to you
> 4. The ways to **fix** it, and how a JWT fits in

## First, the problem HTTP leaves us with

Your browser talks to a website using HTTP, the set of rules browsers and servers use to exchange pages and data. Each time your browser asks the server for something (a page, an image, your list of orders), that is one **request**.

HTTP has no memory. Every request arrives as a stranger. The server answers it and forgets it.

```text
Request 1:  POST /login   (username + password)  ->  "Welcome, Prince"
Request 2:  GET  /orders                         ->  "Who are you?"
```

The server did not forget on purpose. Nothing in request 2 says it came from the person who logged in a moment ago. So after login, the browser has to **prove who it is on every single request**, without typing the password again. A session and a JWT are two different ways to do that.

### Cookies in 30 seconds

A session ID usually rides on a **cookie**, and a JWT often does too, though it is also commonly sent in an `Authorization` header. A cookie is a small piece of text that a website asks your browser to store. After that, the browser attaches it automatically to every request to that website.

```text
Response:   Set-Cookie: sid=9f3c2a...; HttpOnly; Secure; SameSite=Lax
Requests:   Cookie: sid=9f3c2a...
```

Those extra words are safety switches. `HttpOnly` hides the cookie from the page's own JavaScript. `Secure` sends it only over HTTPS (the encrypted, padlock version of HTTP). `SameSite` limits when other websites can trigger it. Remember that the browser does the carrying. The only question is what you put inside the cookie.

### See it yourself

You can look at a real one in two minutes. Open a website you are logged into, where logging back in is easy, and press `F12` to open the browser's developer tools. Choose the **Application** tab (called **Storage** in Firefox), then **Cookies**, then your site.

Look for a cookie with a long, random-looking value. It is often named something like `session`, `sid` or `JSESSIONID`. That value is the ticket number. Now delete that cookie and refresh the page. You are logged out, because the server can no longer match a ticket to a record. If nothing happens, the site keeps its login in a different cookie, so try another one.

> [!WARNING]
> A real session cookie or token works like a password for your account. Never paste one into an online tool, a chat or an email.

## What is a session?

A session is a **record the server keeps about you**. After you log in, the server:

1. Creates a record such as "this is user 42, logged in at 10:00"
2. Gives that record a long random ID, for example `9f3c2a...`
3. Sends the ID to your browser in a cookie

The cookie holds only the ticket number. Think of a coat check: you hand over your coat and get a numbered ticket. The ticket is meaningless on its own. The coat stays in the cloakroom. On every later request the server takes the ticket, looks up the record, and knows who you are.

Here is the idea in pseudocode:

```pseudocode
sessions = an empty table, kept in THIS server's memory

on POST /login:
    id = a random ticket number
    sessions[id] = { userId: 42 }
    send the browser a cookie:  sid = id

on GET /orders:
    session = sessions[ the sid cookie ]
    if there is no such session:
        redirect to /login          # unknown ticket: who are you?
    show the orders of session.userId
```

Notice where the record lives: in a table inside that one server's memory. Keep that in mind, because it is the root of the whole problem.

You may already have used this without noticing. In a Java web app, the servlet container (the program that runs it, such as Tomcat) does exactly this for you: calling `request.getSession()` creates the record and sends a cookie called `JSESSIONID`. By default, the table lives in that one server's memory.

A session has a great property: **the server is in control**. To log someone out, delete their record. To change their permissions, edit it. The next request sees the change.

## What is a JWT?

JWT stands for JSON Web Token (JSON is just a plain-text way of writing labelled values, as in the box below). It takes the opposite approach: the server keeps **nothing**, and the browser carries **the facts about you**, sealed so they cannot be changed.

Think of a festival wristband with your ticket details printed on it and a tamper-proof seal. Any gate guard can read it and check the seal. Nobody needs to phone head office.

A JWT is three chunks of text joined by dots: `header.payload.signature`.

- The **header** says how it was signed (not the same thing as an HTTP header, which comes later)
- The **payload** holds the facts (called *claims*), such as who you are and when the token expires
- The **signature** is the seal, made with a secret key (a private key, or in simpler setups a shared secret) that only the login service holds

```json
{
  "sub": "42",
  "role": "admin",
  "iat": 1793490000,
  "exp": 1793493600
}
```

Here `sub` is the subject (the user's ID), `iat` is when the token was issued and `exp` is when it expires, both written as seconds since 1970.

When the token comes back, the server checks the seal. If it matches, the facts are trusted. If someone edited even one letter, the seal no longer matches and the token is rejected.

```pseudocode
# At login (once)
facts = { sub: "42", role: "admin", expires: one hour from now }
token = sign(facts, privateKey)

# On every request: fails if tampered with or expired
facts = verify(token, publicKey)
```

There is no lookup and no table. Just a calculation.

### How can a seal be checked but not forged?

This is the part that confuses most people, so here is an analogy. Think of a **postcard with an official stamp** on it.

- Anyone who picks up the postcard can **read** it. Nothing is hidden.
- Only the post office owns the **stamp**. Nobody else can make a genuine one.
- The stamp is made from the message itself. Change one word, and the old stamp no longer fits, so the postcard is exposed as fake.

A JWT works the same way, and the two keys are the stamp and the stamp-checker:

| Key | Postcard analogy | What it can do | Who holds it |
|---|---|---|---|
| **Private key** | The stamp itself | **Create** a seal | Only the login service. Keep it secret |
| **Public key** | A checking device | **Check** a seal, but never make one | Anyone. It is safe to hand out |

So the login service stamps tokens with its private key. Every other server holds the public key and can confirm "yes, a genuine stamp, and the words have not changed". Those servers can verify logins, but they cannot invent one.

(Some systems use one shared secret for both jobs instead of a pair. Then every server that can check a token can also forge one. The idea is the same, just less safe to spread around.)

### One thing that surprises people

A typical JWT is **signed, not encrypted**. (Encrypted variants exist but are rare.) Those two words sound alike but mean different things:

- **Encrypted** means scrambled so that only the right key holder can read it, like a locked box.
- **Signed** means readable by everyone, but protected against changes, like the stamped postcard.

A JWT is the postcard, not the locked box. Its chunks are written in Base64, which is only a way of spelling any data with ordinary letters and digits. It is not a secret code. Anyone holding the token can read it. In Java, three lines are enough to open one up, no key needed:

```java
String payload = token.split("\\.")[1];
byte[] bytes = Base64.getUrlDecoder().decode(payload);
System.out.println(new String(bytes, StandardCharsets.UTF_8));
// prints: {"sub":"42","role":"admin",...}
```

The seal stops people *changing* the facts. It does not stop people *reading* them.

> [!WARNING]
> Never put passwords or sensitive data in a JWT payload. Anyone who gets the token can read it.

## Stateful and stateless, in plain words

You will see these two words everywhere, so let us pin them down.

- **Stateful** means someone has to *remember* things between requests. A session is stateful: the server remembers you.
- **Stateless** means nothing is remembered between requests. Each request carries everything needed to handle it. A JWT is the stateless style: the token carries the facts.

Two misconceptions are worth clearing up now:

- *"JWT is the modern replacement and sessions are old."* They are two answers to the same question: where does the memory live? Neither is free.
- *"A stateful app cannot be spread over many servers."* It can, and this post shows how. The trick is to separate **where the state lives** from **which server answers the request**.

## One server is easy. Then you add a second.

Everything above works perfectly with a single server. Real apps rarely stay that way, because one server means:

- limited capacity, and it falls over under heavy load
- no backup if it crashes
- downtime every time you release a new version, because the app has to restart

So you run several copies of the app and put a **load balancer** in front of them. A load balancer is a traffic cop: it receives every request from users and hands each one to one of the servers, spreading the work out. Users see one website, but several servers do the work behind it.

## The problem: a session kept in one server's memory

Now combine the two ideas. Our session code kept its table in **one server's memory**. Watch what happens with two servers:

<figure>
<div class="diagram diagram-wide">
<svg viewBox="0 0 680 300" role="img" aria-label="Diagram: a login creates a session on Server A. The next request is sent by the load balancer to Server B, which has no record of the session and asks the user to log in again.">
  <defs><marker id="arr1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <g font-family="var(--sans)" font-size="14" fill="currentColor" stroke="currentColor" stroke-width="2">
    <rect x="10" y="120" width="110" height="56" rx="8" fill="none"/>
    <rect x="210" y="120" width="130" height="56" rx="8" fill="none"/>
    <rect x="470" y="30" width="190" height="80" rx="8" fill="none"/>
    <rect x="470" y="190" width="190" height="80" rx="8" fill="none"/>
    <line x1="120" y1="148" x2="206" y2="148" marker-end="url(#arr1)"/>
    <line x1="340" y1="135" x2="466" y2="78" marker-end="url(#arr1)"/>
    <line x1="340" y1="161" x2="466" y2="222" stroke="var(--accent)" stroke-dasharray="6 5" marker-end="url(#arr1)"/>
    <g stroke="none" text-anchor="middle">
      <text x="65" y="153">Browser</text>
      <text x="275" y="153">Load balancer</text>
      <text x="565" y="62">Server A</text>
      <text x="565" y="88" font-size="13">memory: { session S1 }</text>
      <text x="565" y="222">Server B</text>
      <text x="565" y="248" font-size="13">memory: { }</text>
      <text x="565" y="292" font-size="13" fill="var(--accent)">"Who are you? Please log in."</text>
    </g>
    <g stroke="none">
      <text x="352" y="96">1. login</text>
      <text x="345" y="236" fill="var(--accent)">2. next request</text>
    </g>
  </g>
</svg>
</div>
<div class="diagram diagram-tall">
<svg viewBox="0 0 340 400" role="img" aria-label="Diagram: a login creates a session on Server A. The next request is sent by the load balancer to Server B, which has no record of the session and asks the user to log in again.">
  <defs><marker id="arr1t" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <g font-family="var(--sans)" font-size="14" fill="currentColor" stroke="currentColor" stroke-width="2">
    <rect x="100" y="10" width="140" height="44" rx="8" fill="none"/>
    <rect x="100" y="110" width="140" height="44" rx="8" fill="none"/>
    <rect x="10" y="250" width="150" height="84" rx="8" fill="none"/>
    <rect x="180" y="250" width="150" height="84" rx="8" fill="none"/>
    <line x1="170" y1="54" x2="170" y2="106" marker-end="url(#arr1t)"/>
    <line x1="140" y1="154" x2="88" y2="246" marker-end="url(#arr1t)"/>
    <line x1="200" y1="154" x2="252" y2="246" stroke="var(--accent)" stroke-dasharray="6 5" marker-end="url(#arr1t)"/>
    <g stroke="none" text-anchor="middle">
      <text x="170" y="37">Browser</text>
      <text x="170" y="137">Load balancer</text>
      <text x="85" y="285">Server A</text>
      <text x="85" y="311" font-size="13">memory: { S1 }</text>
      <text x="255" y="285">Server B</text>
      <text x="255" y="311" font-size="13">memory: { }</text>
      <text x="255" y="360" font-size="13" fill="var(--accent)">"Who are you?</text>
      <text x="255" y="378" font-size="13" fill="var(--accent)">Please log in."</text>
    </g>
    <g stroke="none" font-size="13">
      <text x="20" y="206">1. login</text>
      <text x="240" y="206" fill="var(--accent)">2. next request</text>
    </g>
  </g>
</svg>
</div>
<figcaption>Figure 1. The login lands on Server A, but the next request lands on Server B, which has never heard of it.</figcaption>
</figure>

1. You log in. The load balancer sends the request to **Server A**. Server A creates session `S1` in its own memory and gives your browser the cookie `sid=S1`.
2. You click a link. The load balancer sends this request to **Server B**, which is just as likely. Server B receives `sid=S1`, looks in its own memory, finds nothing, and says: *"Who are you? Please log in."*

Server B did nothing wrong. It simply never saw your login. The result for users is baffling: they are logged out at random, or have to log in again every few clicks.

This bug is cruel for one more reason: **it never shows up on your laptop**, because on your laptop there is only one server.

## How to diagnose it

When users report random logouts only in production, suspect this. Here is how to confirm it step by step.

**1. Notice the pattern.** Logins that work, then vanish for no reason? Does it happen more as you add servers? Does it go away if you run only one server? Those are strong signs.

**2. Find out which server answers.** Configure each server to add a **header** to its responses with its own name, for example `X-Served-By: server-a`. A header is a labelled extra line of information sent along with the page. Then log in once, save the cookie, and call a protected page several times. The tool below is `curl`, a command-line program that makes web requests for you:

```bash
# Log in once and save the cookie
curl -s -c jar.txt -d 'user=demo&pass=demo' \
  https://example.com/login -o /dev/null

# Call a protected page six times and show who answered
for i in 1 2 3 4 5 6; do
  curl -s -b jar.txt -D - -o /dev/null https://example.com/orders \
    | grep -iE "^HTTP/|^x-served-by"
done
```

If sessions are stuck in one server's memory, you will see something like this:

```text
HTTP/2 200
x-served-by: server-a
HTTP/2 302
x-served-by: server-b
HTTP/2 200
x-served-by: server-a
HTTP/2 302
x-served-by: server-b
```

A `200` (success) comes from the server that created the session, and a `302` (a redirect to the login page) comes from the other. That settles it.

**3. Rule out the lookalikes.** Make sure the cookie is actually being sent (check the browser's developer tools, Application tab), that it has not expired, and that the cookie's domain and `Secure` settings match your site. Those cause random logouts too, but they would break on one server as well.

## Fix 1: sticky sessions

The cheapest fix: tell the load balancer to **always send the same user to the same server**. This is called a *sticky session*. Once you land on Server A, you stay on Server A.

It works, but it has real weaknesses:

- If Server A crashes or restarts, everyone stuck to it is logged out
- Deploying a new version restarts the servers, so users on a restarted server can lose their sessions. Some servers keep them across a clean restart only if you configure it, and a crash loses them either way
- The load can become uneven, because some users keep a server busy while others do not

Sticky sessions are a bandage. They are fine for a small setup, and not much more.

## Fix 2: a shared session store

The robust fix: **take the table out of the server.** Keep sessions in one shared place that every server can read. A database works. So does a fast in-memory store like Redis, which is software built to hold small pieces of data in memory and share them over a network. Distributed caches such as Infinispan or Hazelcast do the same job. You do not need to know these yet. They are just examples. (Keeping copies of data in fast stores has its own failure mode: copies go out of date, as explained in [stale cache and cache stampede](/posts/stale-caches-explained/).)

<figure>
<div class="diagram diagram-wide">
<svg viewBox="0 0 680 300" role="img" aria-label="Diagram: the load balancer sends requests to either Server A or Server B. Both servers read and write sessions in one shared session store, so either can handle any request.">
  <defs><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <g font-family="var(--sans)" font-size="14" fill="currentColor" stroke="currentColor" stroke-width="2">
    <rect x="10" y="120" width="100" height="56" rx="8" fill="none"/>
    <rect x="170" y="120" width="130" height="56" rx="8" fill="none"/>
    <rect x="370" y="20" width="150" height="64" rx="8" fill="none"/>
    <rect x="370" y="216" width="150" height="64" rx="8" fill="none"/>
    <rect x="565" y="104" width="105" height="92" rx="8" fill="none" stroke="var(--accent)"/>
    <line x1="110" y1="148" x2="166" y2="148" marker-end="url(#arr2)"/>
    <line x1="300" y1="135" x2="366" y2="66" marker-end="url(#arr2)"/>
    <line x1="300" y1="161" x2="366" y2="232" marker-end="url(#arr2)"/>
    <line x1="520" y1="60" x2="563" y2="128" stroke="var(--accent)" marker-end="url(#arr2)"/>
    <line x1="520" y1="240" x2="563" y2="172" stroke="var(--accent)" marker-end="url(#arr2)"/>
    <g stroke="none" text-anchor="middle">
      <text x="60" y="153">Browser</text>
      <text x="235" y="153">Load balancer</text>
      <text x="445" y="49">Server A</text>
      <text x="445" y="69" font-size="12">keeps no sessions</text>
      <text x="445" y="245">Server B</text>
      <text x="445" y="265" font-size="12">keeps no sessions</text>
      <text x="617" y="142">Shared</text>
      <text x="617" y="160">session store</text>
      <text x="617" y="180" font-size="12" fill="var(--accent)">{ S1 }</text>
    </g>
  </g>
</svg>
</div>
<div class="diagram diagram-tall">
<svg viewBox="0 0 340 430" role="img" aria-label="Diagram: the load balancer sends requests to either Server A or Server B. Both servers read and write sessions in one shared session store, so either can handle any request.">
  <defs><marker id="arr2t" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <g font-family="var(--sans)" font-size="14" fill="currentColor" stroke="currentColor" stroke-width="2">
    <rect x="100" y="10" width="140" height="44" rx="8" fill="none"/>
    <rect x="100" y="100" width="140" height="44" rx="8" fill="none"/>
    <rect x="10" y="190" width="150" height="64" rx="8" fill="none"/>
    <rect x="180" y="190" width="150" height="64" rx="8" fill="none"/>
    <rect x="85" y="330" width="170" height="84" rx="8" fill="none" stroke="var(--accent)"/>
    <line x1="170" y1="54" x2="170" y2="96" marker-end="url(#arr2t)"/>
    <line x1="140" y1="144" x2="90" y2="186" marker-end="url(#arr2t)"/>
    <line x1="200" y1="144" x2="250" y2="186" marker-end="url(#arr2t)"/>
    <line x1="85" y1="254" x2="130" y2="326" stroke="var(--accent)" marker-end="url(#arr2t)"/>
    <line x1="255" y1="254" x2="210" y2="326" stroke="var(--accent)" marker-end="url(#arr2t)"/>
    <g stroke="none" text-anchor="middle">
      <text x="170" y="37">Browser</text>
      <text x="170" y="127">Load balancer</text>
      <text x="85" y="218">Server A</text>
      <text x="85" y="238" font-size="12">keeps no sessions</text>
      <text x="255" y="218">Server B</text>
      <text x="255" y="238" font-size="12">keeps no sessions</text>
      <text x="170" y="358">Shared</text>
      <text x="170" y="377">session store</text>
      <text x="170" y="398" font-size="12" fill="var(--accent)">{ S1 }</text>
    </g>
  </g>
</svg>
</div>
<figcaption>Figure 2. With a shared session store, either server can answer any request.</figcaption>
</figure>

The change is tiny. The only thing that moves is where the table lives:

```pseudocode
sessions = the shared store      # was: a table in this server's memory

on login (any server):
    sessions.save(id, { userId: 42 }, expires in 30 minutes)

on a later request (any server):
    session = sessions.load(id)
```

Now Server A creates the session, Server B finds it, and everything works. Any server can answer any request, so the servers are **interchangeable**. You can add, remove or restart them freely.

**This answers the question we started with.** The application is still stateful, because it remembers you. But the *state* lives in the shared store, not in the web servers. The servers are effectively stateless, and that is what lets a load balancer spread requests around freely. Stateful system, stateless servers.

Two details matter in practice:

- **Expiry must be shared too.** Store a "last active" timestamp in the shared record, and treat a session as expired when `now - lastActive > timeout`. If each server tracked time on its own, one server could log you out while another still thinks you are logged in.
- **There is a cost.** Every request now makes a trip to the store, and the store has to be reliable, because if it goes down, nobody can be recognised. That is why these stores usually run as a group of machines holding copies of each other's data, so one failure does not lose everything.

A third option exists, *session replication*, where servers copy sessions to each other. It works for small clusters, but it gets heavy as you grow, which is why a shared store is more common.

## Fix 3: stop storing sessions on the server at all (JWT)

There is a completely different way to escape the problem: if the server keeps no session, there is nothing to share. That is exactly what a JWT does.

With a JWT, the login hands the browser a signed token carrying the facts. On every request, **any** server can check the signature using the key, and trust the facts. No shared table, no lookup, no request to a store.

1. You log in. The token is created and given to your browser.
2. Your next request goes to Server B. It checks the signature. It matches. You are in.
3. The request after that goes to Server A. Same check. Same result.

No server needed to have seen your login. This is why tokens are popular when many servers, or many separate services, must all trust the same login. Remember the key pair from earlier: services only need the **public** key to check tokens, so they can verify logins without being able to create fake ones.

### The catch

A JWT is valid until it expires, and the server is not looking anything up, so it cannot say "actually, this one is no good any more." That hurts when:

- a user logs out
- an account is disabled
- a role is removed
- a token is stolen

The usual answer is to make tokens **short-lived** (5 to 15 minutes) and pair them with a **refresh token**. When the short token expires, the client trades the refresh token for a new one. Usually the refresh token is checked against a **server-side record**, so it can be revoked. You have rebuilt a small session, consulted every few minutes instead of every request.

Two more cautions. If you keep the token where the page's own JavaScript can read it (such as `localStorage`), a script-injection bug can steal it. An `HttpOnly` cookie stops scripts from reading it, though it then needs protection against forged requests from other sites (`SameSite` helps). And on every request the server must check the signature, the expiry and the algorithm it expects. Never accept a token that names its own algorithm as "none".

So "stateless" never meant the state vanished. The honest version is: *JWTs keep state out of the hot path, and in exchange you get weaker, slower revocation.*

## Which should you use?

| Situation | Reach for |
|---|---|
| One web app, one backend, users log in through a browser | **Sessions.** Simple, easy to revoke, nothing clever to get wrong |
| Several servers behind a load balancer | **Sessions in a shared store**, or tokens. Avoid sessions in one server's memory (sticky sessions are a stopgap) |
| Several services that must trust the same login | **Tokens (JWT).** Each service verifies locally |
| Mobile apps or third-party API clients | **Tokens.** Cookies are awkward to share across apps and third-party clients |
| You must be able to kick a user out right now | **Sessions**, or very short tokens with a revocable refresh token |

If you are not sure, start with sessions in a shared store. Move to tokens when you actually feel the pain of sharing login state across services, not because a blog post said tokens are modern.

## The takeaway

1. HTTP forgets you, so every request needs proof of who you are.
2. A **session** keeps the memory on the server. A **JWT** puts the memory in a signed token.
3. A session kept in **one server's memory** breaks the moment a load balancer sends you to a different server.
4. Fix it by **moving the state out of the servers** (a shared store) or **out of the server side entirely** (a JWT), rather than relying on pinning users to machines.
5. "Stateless" does not mean the state disappeared. It means you chose where to keep it, and the moment you need to revoke something, it comes back.
