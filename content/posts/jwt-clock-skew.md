---
title: JWT clock skew: why valid tokens are not yet valid
date: 2026-11-01
description: Why valid JWTs are rejected at random as not yet valid or expired, how to confirm clock drift between servers, and how to fix it without weakening security.
tags: authentication, JWT, debugging
draft: true
---

## The doubt

Users log in successfully and then, within seconds, an API call fails with an error such as `Token is not yet valid`. The token is brand new. A refresh works. It happens on some requests and not others, and only for some servers.

> The token was issued a second ago. How can it be not valid yet?

The server checking the token and the server that issued it **disagree about what time it is**.

> [!SUMMARY]
> By the end you will know:
>
> 1. Which timestamps inside a JWT get checked, and against whose clock
> 2. How a few seconds of clock difference rejects perfectly good tokens
> 3. How to **diagnose** drift by comparing clocks and decoding the token
> 4. How to fix it with time sync and a small leeway, and why a big leeway is dangerous

## First, the timestamps in a token

A **JWT** (JSON Web Token) is a signed token a login server hands out. It carries **claims**: small facts such as who the user is. The [sessions post](/posts/sessions-jwt-and-load-balancers/) explains how it is used. Three claims are timestamps, written as seconds since 1970:

- `iat` ("issued at"): when the token was created
- `nbf` ("not before"): the earliest time it may be used
- `exp` ("expires"): the time on or after which it is no longer valid

Whoever validates the token compares those numbers with **its own clock**. The token itself carries no clock. It was stamped by the issuer's machine, and it is judged by another machine.

Think of a concert ticket printed "valid from 8:00". The guard at the door checks it against their own watch. If the guard's watch says 7:57, a perfectly good ticket is turned away. The ticket is fine. The two watches disagree.

Which claims get checked depends on the library. Spring's resource server checks `exp` and `nbf`, not `iat`. PyJWT also checks `iat` by default, and rejects a token whose `iat` is in the future. Many issuers do not set `nbf` at all. If your issuer leaves it out, the "not yet valid" error is less likely, but `exp` can still be affected.

## The failure: two clocks, two answers

Computer clocks are never perfect. Without correction, each one drifts, and different machines drift by different amounts. Say the login server's clock is **3 seconds fast**:

```diagram
type: sequence
alt: The login server's fast clock stamps a token with a time three seconds ahead. The API server, with the correct time, rejects it as not valid yet.
caption: Figure 1. The token says 12:00:00 but the API server's clock says 11:59:57, so a good token is refused.
actors: Browser | Login server | API server
Login server --> Browser: token, nbf = 12:00:00
note Login server: its clock is 3 s fast
Browser -> API server: call with the token
note API server: its clock says 11:59:57
API server -x Browser: not valid yet !
```

Whether this happens depends on the validator's tolerance. Spring's default is 60 seconds, so a 3 second drift passes there. Many other libraries default to **zero** tolerance, such as jjwt, Node's `jsonwebtoken` and PyJWT. The failure appears when the drift is bigger than the tolerance. Check your library's default first.

For a token that is valid for 15 minutes, a few seconds hardly matters at the end of its life. But at the **start** it matters a lot, because the call arrives right after the login. An `expired` error needs a shorter token or a bigger drift. With 60-second tokens, a clock error of 10 seconds changes the validity by a sixth.

It looks random because it depends on **which server** handles which request, and on how far each has drifted.

Other causes of a jump rather than a slow drift: a virtual machine that was paused and resumed, a laptop that woke from sleep, and a container whose host has a wrong clock.

## How to diagnose it

**1. Read the error closely.** Libraries often print both times. This example uses the wording of jjwt 0.12 for a token that is not valid yet. Older versions and other libraries word it differently:

```text
JWT early by 3000 milliseconds before 2026-03-01T12:00:00Z.
Current time: 2026-03-01T11:59:57Z. Allowed clock skew: 0 milliseconds.
```

**2. Decode the token and compare.** Take the payload (the middle part of the three dot-separated parts), decode it, and compare `iat` with the real time:

```bash
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d     # the payload may need "=" padding added
date +%s          # the current time on this machine, in seconds since 1970
```

> [!WARNING]
> Do not paste real production tokens into online decoder websites. A token is a credential. Decode it locally, as above.

If a token issued just now has an `iat` several seconds ahead or behind that number, the issuer's clock is off.

**3. Compare the servers.** Run `date -u` on the issuer and on the validator at the same moment. Check whether the clock is synchronized: `timedatectl status` shows whether the system clock is synchronized, and `chronyc tracking` shows the current offset. On Windows, `w32tm /query /status` shows similar details.

**4. Look for a pattern in the hosts.** If failures cluster on one server, that server's clock is the suspect.

## Fix 1: keep every clock synchronized

The real fix is for all machines to agree on the time. **NTP** (Network Time Protocol) keeps clocks in line with reference servers. On Linux, `chrony` or `systemd-timesyncd` does it. Cloud providers offer a built-in time service. A container uses its host's clock, so fix the host or node, not the container.

Make this part of your server setup, and **monitor the offset** with an alert if it grows beyond a second. The Prometheus node exporter exposes it as `node_timex_offset_seconds`.

## Fix 2: allow a small leeway

Even synchronized clocks differ by milliseconds, and a little tolerance is normal. Most validators accept a **clock skew** allowance: a short extra margin on the time checks.

```java
NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build();
decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
        new JwtTimestampValidator(Duration.ofSeconds(30)),     // 30 s: stricter than the 60 s default
        new JwtIssuerValidator(issuer)));
```

Spring's `JwtTimestampValidator` already defaults to 60 seconds. You only need this code to change that value, or to combine it with other checks. Without a custom validator, `JwtValidators.createDefaultWithIssuer(issuer)` gives you the default timestamp check plus the issuer check. Other libraries have the same setting under names such as `allowedClockSkewSeconds`, `leeway` or `clockTolerance`. Look up your library's name.

## Fix 3: do not make the window needlessly tight

When the issuer sets `nbf` to exactly `iat`, any forward drift on the issuer breaks the first call. You can set `nbf` a few seconds in the past, or omit it if you do not need it. If your library also checks `iat`, moving `nbf` alone will not remove the problem. Make sure that very short lifetimes (a minute or less) are matched by good time sync and a refresh flow that expects it.

## When the fix goes wrong

- **A leeway that is too big.** Allowing 10 minutes of skew effectively **extends every token by 10 minutes** and lets a not-yet-valid token through. A leeway is a safety margin of seconds, not minutes.
- **Leeway used to hide a broken clock.** If one server is a minute out, a 60-second leeway makes the error disappear from the logs while the real problem grows. Watch the offset.
- **Fixing it by hand.** Setting a clock manually works until it drifts again. Use NTP.
- **Trusting the browser's clock.** A user's device can be hours wrong. Do **validation** on the server. If a front end checks `exp` to decide when to log out, use a margin and a server response as the final word.
- **Time jumps.** A VM resume or an NTP correction can move the clock in a step, and tokens issued just before the jump can fail. Short outages around those moments are expected.
- **Mocked clocks in tests.** A test that freezes time hides skew problems. Test with the clock a few seconds off in both directions.

The same clock rules bite elsewhere: OpenID Connect ID tokens, SAML assertions (which carry their own valid-from and valid-until times), request signing for some cloud APIs, and one-time codes in authenticator apps.

## Which should you use?

| Situation | Reach for |
|---|---|
| Tokens rejected at random, some servers only | **Check clocks** on the issuer and validators first |
| Servers without time sync | **NTP** (`chrony` or the cloud provider's time service) |
| Small differences are unavoidable | **A leeway of 30 to 60 seconds** in the validator |
| Tokens with very short lifetimes | **Good sync plus a leeway,** and a refresh flow that expects occasional retries |
| A client-side expiry check | **Treat it as a hint,** and let the server decide |

If you are not sure, compare `date -u` on two servers before you touch any code. Most "mystery" token failures are a clock, not a bug in the token.

## The takeaway

1. A JWT's `iat`, `nbf` and `exp` are **timestamps**, and the validator checks them against **its own clock**. Which ones it checks depends on the library.
2. If the issuer's and the validator's clocks differ by more than the validator's tolerance, a fresh token can look **not yet valid** or **expired**.
3. It looks random because it depends on **which server** answers, and on how far each has drifted.
4. Diagnose by reading the error's time difference, decoding the token, and comparing `date -u` and `chronyc tracking` across hosts.
5. Fix it with **NTP** on every machine and a **small leeway** (seconds, not minutes) in the validator. A big leeway weakens the security the expiry gives you.
