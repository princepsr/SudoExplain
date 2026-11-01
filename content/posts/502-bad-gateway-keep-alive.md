---
title: 502 Bad Gateway: idle timeout mismatch behind a proxy
date: 2026-11-01
description: Why a proxy or load balancer returns an occasional 502 Bad Gateway when the app closes idle connections first, and how to fix the keep-alive timeouts.
tags: networking, nginx, debugging
draft: true
---

## The doubt

Users report an occasional error page: **502 Bad Gateway**. It is rare, perhaps one request in a few thousand. Refreshing makes it go away.

You look at the application logs and find nothing. No exception, no failed request. Oddly, it happens more at quiet times, such as early in the morning, and less under heavy load.

> The app never saw the request and never failed. Where does the 502 come from, and why when it is quiet?

The 502 comes from the proxy in front of your app. It sent a request down a connection that the app had just closed.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a 502 means, and what HTTP **keep-alive** does
> 2. How an idle connection can be closed at the same moment a request uses it
> 3. How to **diagnose** the mismatch from proxy logs and timeout settings
> 4. How to fix it with the right timeout order, and when retries are safe

## First, connections that stay open

A **proxy** is a server that sits in front of your app and forwards requests to it. A **load balancer** is a proxy that spreads requests over several app servers. Both are **gateways**: they talk to the user on one side and your app (the **upstream**) on the other.

A **502 Bad Gateway** means the gateway got an invalid answer, or none, from the upstream. It is not a problem with the user's request.

Opening a connection costs time, so HTTP **keep-alive** reuses one connection for many requests. Think of keeping a phone line open between two offices instead of redialing for every question. Both sides close the line after it has been **idle** for a set time, called the idle timeout.

## The failure: both sides time the line out

The proxy keeps idle connections to the app so that the next request is faster. (With nginx this needs upstream keep-alive to be switched on. It is the default since nginx 1.29.7, and older versions need `keepalive` in the upstream block, `proxy_http_version 1.1` and an empty `Connection` header.) The app also closes idle connections, after its own timeout. If the app's timeout is **shorter**, it hangs up first. The proxy does not know yet.

```diagram
type: sequence
alt: The app closes an idle connection at the same moment the proxy sends a request on it, so the proxy returns 502.
caption: Figure 1. The FIN and the request cross on the wire, and the request loses.
actors: Client | Proxy | App
Client -> Proxy: GET /orders
Proxy -> App: GET /orders (idle connection)
note App: idle timeout fires, closes socket
App --> Proxy: connection closed (FIN/RST) !
Proxy --> Client: 502 Bad Gateway !
```

The two events cross on the network. The proxy sends the request while the app's close is still travelling. The app's operating system answers a request on a closed connection by resetting it. The proxy sees a connection that died without a response, and returns 502.

This is a **race**: whoever's timer fires first wins, and the window is a few milliseconds wide. It is more likely at quiet times, because there are more idle connections and more of them sit near the timeout. Under steady load, connections never stay idle long enough to expire.

## How to diagnose it

**1. Read the proxy's error log.** With nginx, look for messages like these, which name the failed upstream:

```text
upstream prematurely closed connection while reading response header from upstream
recv() failed (104: Connection reset by peer) while reading response header from upstream
```

Both mean the upstream dropped a connection that nginx had already sent a request on. The access log for the same moment shows status 502.

**2. Compare the idle timeouts of every layer.** Write them down in order from the user inward, and look for an inner layer that is shorter than an outer one. The usual places are:

- the load balancer's idle timeout
- the proxy's idle timeout toward the app
- the app server's keep-alive timeout

For nginx, the setting toward the app is `keepalive_timeout` **inside the `upstream` block**. It defaults to 60 seconds, per the nginx documentation. The `keepalive_timeout` at server level is a different setting for client connections.

**3. Correlate with idle gaps.** Find the time between each failing request and the previous request to the same upstream. If failures cluster just after gaps close to the app's timeout, you have found it. For example, a 5-second app timeout and failures after gaps of 4.9 to 5.1 seconds point straight at it.

**4. Look for resets in a packet capture.** On the proxy host, capture traffic to the app's port, then open the file in Wireshark and look for a `RST` right after a request:

```bash
sudo tcpdump -i any -w 502.pcap 'tcp port 8080'
```

> [!WARNING]
> A capture can include sensitive request data, and on a busy server it grows fast. Limit it with a filter as above, stop it after a few minutes, and delete the file when done. Do not share it unredacted.

## Fix 1: make the app's timeout longer than the proxy's

The side that **sits behind** must hold the line open longer than the side in front. Then the proxy always closes first, and it knows about it. AWS says the same for its Application Load Balancer: configure the application's idle timeout to be larger than the load balancer's. Its documented default idle timeout is 60 seconds.

Example for a Node.js app behind that load balancer. Node's HTTP server `keepAliveTimeout` is in milliseconds and defaults to 5,000 (5 seconds) in current releases, which is far too short here. The socket actually closes after that time plus `keepAliveTimeoutBuffer` (1,000 ms by default in recent versions), and the default is planned to change in a future major version, so check yours:

```javascript
const http = require('http');

const server = http.createServer((req, res) => res.end('ok'));
server.keepAliveTimeout = 65000;   // 65 s, longer than a 60 s idle timeout
server.listen(8080);
```

For Tomcat, the `keepAliveTimeout` attribute of the HTTP connector (also in milliseconds) defaults to the value of `connectionTimeout`. Tomcat's own default for that is 60,000, but the `server.xml` it ships sets 20,000. So check what your install really uses.

For nginx as the proxy in front of an app, keep the upstream `keepalive_timeout` (60 seconds by default) below the app's timeout. If your app is not Node or Tomcat, find its own idle timeout in its documentation instead of guessing.

The cost: a longer timeout keeps more idle connections open on the app, using a little memory and a file descriptor each.

## Fix 2: retry safe requests at the proxy

A retry hides the rare failure. With nginx, `proxy_next_upstream` decides when to try again. Its default is `error timeout`, and by default nginx does not retry a request with a non-idempotent method (`POST`, `LOCK`, `PATCH`) once it has been sent upstream. Setting `non_idempotent` removes that guard.

An **idempotent** request is one that gives the same result when repeated, such as `GET` or `PUT`. Keep that guard on. Limit tries with `proxy_next_upstream_tries`.

The cost: retries add load and delay. They hide the cause instead of removing it, so fix the timeouts as well.

## Fix 3: stop idle connections before they race

You can also stop the problem at its source. In nginx, `keepalive_timeout` in the upstream block can be lowered. The nginx `keepalive_requests` and `keepalive_time` settings also cap how often a connection is reused. A short life avoids long-idle connections, at the price of more new connections.

## When the fix goes wrong

Each fix can fail quietly. These three are the ones most worth knowing.

**1. Raising the wrong timeout.** nginx has many timeouts, and their names sound alike. A common move is to raise `proxy_read_timeout`, because it looks related. It is not. That setting is how long nginx waits for the app to send a response, and it defaults to 60 seconds. The server-level `keepalive_timeout` is how long nginx keeps an idle connection to the user's browser. Neither one says how long the *app* keeps an idle connection, and the app's timer is the one that wins the race in Figure 1.

So you can raise both to 300 seconds and the 502s continue at the same rate. The settings that matter are the app's own idle timeout and the `keepalive_timeout` inside the `upstream` block. After any change, watch the "prematurely closed" lines in the error log. If they do not drop, you changed the wrong setting.

**2. Retrying non-idempotent requests.** Writes fail too, so it is tempting to switch on `non_idempotent` and let nginx retry a `POST` as well. The trouble is that nginx cannot tell *when* a connection broke. Say a customer pays 20 dollars. The app charges the card, but the answer is lost or comes too late, so nginx sees an error or a timeout. It sends the same `POST` again, and the card is charged twice: 2 x 20 = 40 dollars.

Keep the guard on. If writes must be retried, make them safe first with an **idempotency key**. This is a unique value the client sends with each request. The server saves the result under that key, and a repeat with the same key gets the saved result instead of a second charge. The [idempotency key post](/posts/idempotency-key-double-charge/) explains it.

**3. A margin of zero.** If both timeouts are 60 seconds, you might think the race is gone. It is not. Each side starts its own timer at a slightly different moment, because the last bytes need time to cross the network. The app's timer may fire at 60.000 seconds and the proxy's at 60.003. Between those two moments the proxy can still send a request down a line the app has just closed. That is the same race, only rarer, so it is harder to notice. Leave a real gap, such as 5 seconds, which is far larger than any network delay inside your system.

Smaller traps:

- **Fixing one layer out of three.** A user connects to a load balancer, which talks to nginx, which talks to the app. Every hop has its own pair of timers. Check each.
- **Assuming defaults.** Containers, frameworks and cloud services change them. Read the effective value.
- **Blaming the app.** The app did nothing wrong. Its logs are quiet because it closed a connection with no request on it.

## Which should you use?

| Situation | Reach for |
|---|---|
| Any proxy to app setup | **App timeout longer** than the proxy's idle timeout |
| Rare 502s remain on reads | **A proxy retry** for idempotent methods only |
| Writes also fail | **Fix the timeouts first,** then add idempotency keys |
| You cannot change the app | **Shorten** the proxy's idle timeout toward it |

If you are not sure, write down the idle timeouts of each layer, from the user inward. The app's must be the largest.

## The takeaway

1. A **502** means the gateway got a bad or empty answer from the app.
2. **Keep-alive** reuses connections, and both sides close them after an idle timeout.
3. If the app closes first, a request can **cross** its close, and the proxy returns 502.
4. Diagnose with proxy **error logs**, a comparison of timeouts, and idle gaps.
5. Make the **app's timeout the longest**, and retry only **idempotent** requests.
