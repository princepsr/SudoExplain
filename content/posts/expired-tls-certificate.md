---
title: Expired TLS certificate: why it takes the site down
date: 2026-11-01
description: Why an expired TLS certificate takes a site or API offline with no code change, how to check expiry with openssl, and how to automate renewal.
tags: TLS, security, operations
draft: true
---

## The doubt

At 02:07 on a Saturday the alerts start. Browsers show a full-page warning. Mobile apps fail to load. Partner systems report that every call to your API is rejected.

Nobody deployed anything. The servers are healthy, the database is fine, and the logs on your side are quiet, because the requests never arrive.

> Nothing changed and everything is down. How can a certificate do this?

A certificate has an end date. Clients check it before they send a single byte of your data, and they refuse to talk once it has passed.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a TLS certificate proves, and how the chain of trust works
> 2. Why certificates expire unnoticed, including the internal ones
> 3. How to **diagnose** an expiry with `openssl` and `curl`
> 4. How to automate renewal, monitor it, and avoid the traps that remain

## First, what a certificate proves

**TLS** (Transport Layer Security) is the encryption behind `https://`. Before encrypting, the client has to know it is talking to the real server and not an impostor. A **certificate** is the proof: a signed file that says "this public key belongs to `api.example.com`".

Think of a passport. It names you, has an expiry date, and is signed by an authority the border officer trusts. An expired passport is refused even if it is genuine.

A **certificate authority** (CA) is the organization that signs certificates. Clients do not trust your certificate directly. They follow a **chain**. Your **leaf** certificate is signed by an **intermediate** certificate. That is signed by a **root** certificate, which the client already has in its trust store (its list of trusted roots). Every certificate in the chain has its own expiry.

## The failure: the date passes

Every certificate has a `notBefore` and a `notAfter` date. The client checks the clock against both during the handshake, which is the first exchange of messages that sets up a connection.

```diagram
type: sequence
alt: A client connects, the server sends an expired certificate, and the client closes the connection before any request.
caption: Figure 1. The handshake fails first, so your application never sees a request.
actors: Client | Server
Client -> Server: ClientHello (start TLS)
Server --> Client: certificate, notAfter in the past !
note Client: checks the date, finds it expired
Client -x Server: connection closed, no request sent !
```

This is why your logs are quiet. The application code never ran. Only the TLS layer, or the load balancer in front of it, saw the attempt.

## Why it goes unnoticed

- **Manual renewal.** Someone bought a certificate, installed it by hand, and left the company. A calendar reminder went to a mailbox nobody reads.
- **A forgotten internal certificate.** A service-to-service certificate or a database certificate expires on a system nobody looks at.
- **A client certificate.** With **mutual TLS** (mTLS), the client also presents a certificate, and the server checks that one too. These expire silently as well.
- **A private CA.** A company's own CA has its own root and intermediates. Those can run for years, then expire all at once.
- **Java keystores and truststores.** A **keystore** holds your own certificates and keys. A **truststore** holds the roots you trust. Both are files that nobody renews by default.

## What the error looks like

To a user, the browser shows a warning page. Chrome names it `NET::ERR_CERT_DATE_INVALID`. Firefox says `SEC_ERROR_EXPIRED_CERTIFICATE`.

To an API client, the message depends on the library. With `curl` you see:

```text
curl: (60) SSL certificate problem: certificate has expired
```

A Java client throws an `SSLHandshakeException`, usually with a message that includes `PKIX path validation failed` and `validity check failed`. Note that "expired" can be the leaf or an intermediate. An expired root is rejected by OpenSSL and most browsers, but Java does not check the validity dates of a trust anchor in its truststore.

## How to diagnose it

**1. Read the dates the server is sending.** The `-servername` option sends the host name, which servers that host many sites need to pick the right certificate:

```bash
echo | openssl s_client -connect api.example.com:443 -servername api.example.com 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer
```

Output has this shape (illustrative):

```text
notBefore=Jan  5 00:00:00 2026 GMT
notAfter=Apr  5 23:59:59 2026 GMT
subject=CN=api.example.com
issuer=CN=Example Intermediate CA
```

If `notAfter` is in the past, you have your answer. The `echo |` closes the connection after the handshake.

**2. Check the whole chain.** Run `openssl s_client` with `-showcerts` and read the `Verify return code` line at the end. Code `10` means `certificate has expired`. Code `20` means `unable to get local issuer certificate`, which usually means a missing intermediate, or a root that is not in the trust store.

**3. Use `curl -v`.** It prints the handshake, including `expire date` for the server certificate, then the verification error.

**4. Test a file or a threshold.** `openssl x509 -in cert.pem -noout -checkend 2592000` exits with code 1 if the certificate expires within 30 days (2,592,000 seconds). That is easy to use in a script.

**5. For Java files**, list a keystore with `keytool -list -v -keystore store.jks`. Each entry shows its `Valid from` and `until` dates.

> [!WARNING]
> Do not "fix" an outage by turning off certificate checking in the client, for example with `curl -k` or a trust-all setting in code. It hides the problem and removes the protection TLS gives. Use it only on a throwaway test, never in production or committed code.

## Fix 1: automate renewal

**ACME** (Automatic Certificate Management Environment) is the protocol that lets software prove it controls a domain and get a certificate with no human steps. Tools that speak it include **certbot** on servers, and **cert-manager** on Kubernetes.

With certbot, `certbot renew` renews certificates that are close to expiry, and `certbot renew --dry-run` tests the process against a staging server. Many installs already add a timer or cron entry, which you can find with `systemctl list-timers`. As of Certbot 4.0.0, a certificate is due for renewal when less than a third of its lifetime remains. Older versions used a fixed 30 days.

In cert-manager, a `Certificate` resource names the issuer and the secret to fill. Its `duration` defaults to 90 days, and with no `renewBefore` set, renewal starts two thirds of the way through the lifetime.

The cost: automation is another system that can fail. It needs its own monitoring, which is Fix 2.

## Fix 2: monitor days to expiry

Check every certificate from outside, the way a client sees it, and alert at **several** thresholds, for example 30, 14, 7 and 3 days. The early alerts are for planning. The late ones mean automation has failed.

Alert on the certificate that is **served**, not the file on disk. They differ when a renewed file was never loaded.

## Fix 3: inventory everything, including mTLS

List every certificate you own: public sites, internal services, client certificates, keystores, truststores and private CA roots. Give each one an owner and an expiry date. A spreadsheet beats nothing. A scanner that finds them is better.

## Fix 4: test the renewal

Run the renewal early and on purpose, in staging. Use `--dry-run` for certbot. Then check that the **new** certificate is the one being served. Practice replacing a private CA intermediate while nobody is under pressure.

## When the fix goes wrong

- **Renewal works, but the server was not reloaded.** The new file is on disk, yet the process still serves the old certificate from memory. Certbot's `--deploy-hook` runs a command after a successful renewal, such as `systemctl reload nginx`.
- **A missing intermediate.** The server sends only the leaf. Some clients cope by fetching the rest and others fail. Serve the full chain.
- **Clock skew.** If a client's clock is wrong, a valid certificate looks expired or "not yet valid" (error code `9`). The [JWT clock skew post](/posts/jwt-clock-skew/) shows the same trap for tokens.
- **Lifetimes keep shrinking.** The CA/Browser Forum, the group that sets rules for public CAs, limits certificates issued on or after March 15, 2026 to 200 days. The limit falls to 100 days for certificates issued on or after March 15, 2027, and to 47 days for those issued on or after March 15, 2029 (Baseline Requirements, section 6.3.2). Let's Encrypt has announced 45-day certificates by 2028. Manual renewal gets harder every year.
- **The ACME challenge breaks.** A firewall rule or DNS change can block the check, and renewal fails quietly.
- **Private CA certificates sit outside the schedule.** The public limits do not apply to them, so they often get forgotten.

## Which should you use?

| Situation | Reach for |
|---|---|
| A public web site or API | **ACME with certbot,** or cert-manager on Kubernetes |
| Internal and mTLS certificates | **An inventory** and a private CA with automated issuing |
| Any certificate at all | **Expiry alerts** at 30, 14, 7 and 3 days |
| After every change | **A renewal test** and a check of the served certificate |

If you are not sure what you own, scan your hosts and your keystores for end dates this week. The list is the first fix.

## The takeaway

1. A certificate is **signed proof of identity** with an end date, and clients enforce it.
2. When it expires, the handshake fails **before** your code runs.
3. Check with **`openssl s_client`** piped to `openssl x509 -noout -dates`.
4. **Automate** renewal, and alert on the certificate that is actually served.
5. Include **internal, client and truststore** certificates, and expect lifetimes to keep shrinking.
