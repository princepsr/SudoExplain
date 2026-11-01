---
title: CORS errors explained: why the browser blocks your API call
date: 2026-11-01
description: Why an API call works in curl and Postman but fails in the browser with a CORS error, how preflight requests work, and how to fix the headers.
tags: CORS, web, security
draft: true
---

## The doubt

You build an API and test it with `curl`. It returns the data. You try it in Postman. It works there too. Then your web page calls the same URL and the console fills with red text:

```text
Access to fetch at 'https://api.example.com/orders' from origin
'https://app.example.com' has been blocked by CORS policy: No
'Access-Control-Allow-Origin' header is present on the requested resource.
```

That wording is typical of Chrome, and other browsers differ. The server is up, the URL is right, and the same request worked a minute ago.

> The API works everywhere except the browser. What is the browser blocking, and why?

The browser is protecting the user, not blocking the server. The server answered, and the browser then refused to hand the answer to your page.

> [!SUMMARY]
> By the end you will know:
>
> 1. What an **origin** is, and what the same-origin policy stops
> 2. Why CORS is enforced by the browser but configured by the server
> 3. How **simple** and **preflight** requests differ, and how to diagnose each
> 4. How to fix the headers, and which traps make a fix look like it failed

## First, origins and the browser's rule

An **origin** is the combination of scheme, host and port: `https://app.example.com` and `https://api.example.com` are different origins, and so are `http://app.example.com` and `https://app.example.com:8443`.

By default, a browser lets a page read responses only from its **own** origin. This is the **same-origin policy**. Without it, any site you visit could silently call your bank's pages using your logged-in session and read the results.

**CORS** (Cross-Origin Resource Sharing) is the way a server tells the browser "pages from that other origin may read my responses". The server sends headers saying so, and the browser enforces them. `curl` and Postman are not browsers, so they have no such rule and never complain.

## The failure: no permission slip

Your page at `https://app.example.com` calls `https://api.example.com`. The browser adds an `Origin` header and sends the request:

```diagram
type: sequence
alt: The browser sends a request with an Origin header, the server replies without CORS headers, and the browser blocks the page from reading it.
caption: Figure 1. The server answered, but without permission headers the browser hides the response.
actors: Page | Browser | API
Page -> Browser: fetch(api.example.com/orders)
Browser -> API: GET /orders, Origin: app.example.com
API --> Browser: 200 OK, no CORS headers !
Browser -x Page: blocked: CORS policy !
```

The key response header is `Access-Control-Allow-Origin`. If it is missing, or does not match the page's origin, the browser blocks the page from reading the body. The request still reached the server, which matters for the traps below.

## Simple requests and preflight

Some requests are safe enough to send directly. MDN calls them **simple requests**. They use `GET`, `HEAD` or `POST`, set only a few "safelisted" headers, and use a `Content-Type` of `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`.

Anything else triggers a **preflight**: before the real request, the browser sends an `OPTIONS` request to ask permission. Common triggers are:

- a method such as `PUT` or `DELETE`
- a `Content-Type` of `application/json`
- a custom header, or an `Authorization` header

The preflight carries `Access-Control-Request-Method` and `Access-Control-Request-Headers`. The server must answer with a success status and headers that allow them. Only then does the browser send the real request.

```diagram
type: sequence
alt: The browser sends an OPTIONS preflight first, then the real PUT request only if the preflight answer allows it.
caption: Figure 2. A JSON PUT costs two requests, and the OPTIONS one must not need a login.
actors: Browser | Server
Browser -> Server: OPTIONS /orders/7 (preflight)
Server --> Browser: 204 + Allow-Origin, Allow-Methods
Browser -> Server: PUT /orders/7 (real request)
Server --> Browser: 200 + Allow-Origin
```

## The headers that matter

| Header | Meaning |
|---|---|
| `Access-Control-Allow-Origin` | The one origin allowed to read the response, or `*` for any |
| `Access-Control-Allow-Methods` | Methods allowed on the real request |
| `Access-Control-Allow-Headers` | Request headers allowed on the real request |
| `Access-Control-Allow-Credentials` | `true` lets the page send cookies and read the response |
| `Access-Control-Max-Age` | Seconds the browser may cache the preflight answer |

`Access-Control-Max-Age` defaults to 5 seconds. Browsers also cap it: according to MDN, Firefox at 24 hours and Chromium at 2 hours (7,200 seconds) from version 76. Setting it high saves a preflight on repeat calls.

## How to diagnose it

**1. Read the console message.** It says which header is missing or which preflight check failed. It names the exact origin and URL.

**2. Open the Network tab.** Find the failed call. A preflight shows as a separate `OPTIONS` row just before it. Look at its status and its response headers. A status of 401, 403, 404 or 500 on the `OPTIONS` row is the real problem.

**3. Replay the real request with an origin.** `curl` skips CORS, but you can send the header yourself and read what comes back:

```bash
curl -i https://api.example.com/orders -H "Origin: https://app.example.com"
```

Look for `Access-Control-Allow-Origin` in the response.

**4. Replay the preflight.** This mimics what the browser sends:

```bash
curl -i -X OPTIONS https://api.example.com/orders/7 \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type,authorization"
```

You want a 2xx status and an `Access-Control-Allow-Methods` that lists `PUT`. If you get a 401 or a redirect, fix that first.

## Fix 1: send the right headers on both responses

The preflight response **and** the real response both need `Access-Control-Allow-Origin`. A common bug is to add the header only to the `OPTIONS` handler, or only to successful responses. The browser checks each one.

## Fix 2: echo an allow-listed origin, not a wildcard

Keep a list of origins you trust. If the request's `Origin` is on the list, send that exact value back. Otherwise send no CORS headers. Add `Vary: Origin`, so shared caches do not give one origin's answer to another.

A wildcard `*` is fine for fully public data with no cookies. It is wrong as soon as credentials are involved.

## Fix 3: answer OPTIONS before authentication

A preflight carries no cookies and no `Authorization` header. If your login check runs first, it rejects the preflight with a 401, and the browser reports a CORS failure. Spring Security's documentation states that CORS must be processed before Spring Security for this reason.

A Spring Boot example that allow-lists one origin and works with Spring Security:

```java
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

@Configuration
public class WebSecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http.cors(Customizer.withDefaults());   // uses the CorsConfigurationSource bean
        // ... your authorization rules here
        return http.build();
    }

    @Bean
    UrlBasedCorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("https://app.example.com"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE"));
        config.setAllowedHeaders(List.of("Content-Type", "Authorization"));
        config.setMaxAge(3600L);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }
}
```

Without Spring Security, the same list goes in a `WebMvcConfigurer` through `addCorsMappings`. Spring documents both. This snippet is a sketch built from the documented classes, so compile it against your Spring version.

## When the fix goes wrong

Two of these waste the most time, so they come first. The short ones follow.

**1. Using `*` when the page sends cookies.** The wildcard `*` means "any origin may read this". It is the quickest way to make the error go away, so people use it first. It works until the page sends **credentials**, which means cookies or an `Authorization` header. For a request with credentials, the browser refuses to accept `*`. It wants the exact origin. So the same API works for a public call and fails the moment you add a login.

Say your page at `https://app.example.com` sends its login cookie. The response must then look like this:

```text
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
```

**What to do instead.** Name the origin. If you have several, keep a list on the server, and reply with the origin only when the request's `Origin` header is on that list. Never copy back whatever origin arrives without checking, because then every site can read your users' data. In Spring, a wildcard is not accepted in `allowedOrigins` when credentials are enabled. Use `allowedOriginPatterns` for patterns, and keep them narrow.

**2. A real error that looks like CORS.** You see "blocked by CORS policy" and start changing headers. But suppose the server crashed with a 500, and the error page came from a layer that does not add CORS headers. The browser sees a response with no `Access-Control-Allow-Origin`. It reports a CORS error and hides the real status from your code. No header change can fix a crash.

**What to do instead.** Look at the request in the Network tab. If the status is 500 or 502, the problem is on the server, so read the server logs. You can also call the URL with `curl` and add an `Origin` header. That shows the true status and headers, because `curl` does not enforce CORS. Only when the status is fine and the header is missing is it a CORS setting.

Smaller traps:

- **A redirect on the preflight.** A redirect to another URL, such as from `http` to `https` or a trailing-slash rewrite, fails the preflight in current browsers, because a preflight needs an ok (2xx) status. Older browsers differed. Call the final URL directly.
- **"Disable CORS" browser extensions.** They hide the error on your machine only. Your users still see it.
- **Treating CORS as API security.** It does not protect your API. `curl`, a script or a server can call it freely. Authenticate and authorize every request on the server. The [broken access control post](/posts/broken-access-control-idor/) shows what happens when you skip it.
- **A stale preflight cache.** After you change headers, the browser may use a cached preflight for up to the `Max-Age` you set.

## Which should you use?

| Situation | Reach for |
|---|---|
| A public, read-only API | **`*`,** with no credentials |
| A web app with cookies or tokens | **An allow-list** of origins, echoed back |
| Spring with authentication | **CORS configured in the security chain,** before auth |
| Local development only | **A dev-server proxy,** not a disabled browser check |

If you are not sure, copy the failing preflight into the `curl` command above. A clear status and headers there tell you where to look.

## The takeaway

1. An **origin** is scheme, host and port, and browsers isolate origins by default.
2. CORS is **enforced by the browser** and **configured by the server** with response headers.
3. JSON, custom headers and `PUT` or `DELETE` trigger an **`OPTIONS` preflight** first.
4. Return the headers on **both** responses, **echo an allow-listed origin**, and answer `OPTIONS` before authentication.
5. CORS is **not a security control** for your API, and a 500 can hide behind a CORS message.
