---
title: XSS (cross-site scripting): when input runs as code
date: 2026-11-01
description: How cross-site scripting (XSS) turns a comment or search term into code in other users' browsers, how to find it in your own site, and how to fix it.
tags: XSS, security
draft: true
---

## The question

A site has a comment box. A user posts a comment that contains HTML tags instead of words. Nothing looks wrong for them. But when other users open the page, their browsers run that comment as a program.

The site never meant to run anything. It only meant to show text.

> I just print what the user typed. How can printing text run code in someone else's browser?

Because a browser cannot tell your text from your page. If the typed text contains markup and you insert it into the page as markup, the browser obeys it.

> [!SUMMARY]
> By the end you will know:
>
> 1. What **cross-site scripting (XSS)** is, and its three kinds: stored, reflected and DOM-based
> 2. What an attacker can and cannot do with it, and where cookies fit in
> 3. How to **find** it in your own code and test safely with a harmless marker
> 4. The fixes (output encoding, sanitizing, Content-Security-Policy, cookie flags) and the traps that defeat them

## First, how a page becomes code

A web page is **HTML**, text with tags such as `<b>` and `<p>` that tell the browser what to draw. A tag such as `<script>` or an attribute such as `onerror` can also tell it to **run JavaScript**, the programming language browsers use to make pages interactive.

Think of a notice board that reads aloud whatever is pinned to it. If a visitor pins a note that says "now read the safe combination", the board obeys. XSS is that note. The analogy stops at one point: the board is each visitor's own browser, so the damage lands on other people.

A browser also enforces the **same-origin policy**: a script on one site cannot read another site's data. XSS defeats this, because the injected script runs **as part of your site**. The browser sees it as yours.

## The failure: user text inserted as markup

Here is the unsafe pattern in the browser, using `innerHTML`, which parses a string as HTML:

```javascript
// Unsafe: the comment is parsed as HTML
commentDiv.innerHTML = comment.text;
```

The same mistake happens on a server that builds HTML by string:

```javascript
res.send("<p>Hello, " + req.query.name + "</p>");
```

A harmless demonstration is a comment that tries to show a pop-up. The attacker's text is `<img src=x onerror="alert(1)">`. The image fails to load, and the `onerror` code runs. I ran this through a small Node program. Without encoding, the output page contained the tag exactly as typed. With encoding, it contained `&lt;img src=x onerror=&quot;alert(1)&quot;&gt;`, which a browser shows as plain text.

```diagram
type: sequence
alt: An attacker posts a comment with a script, the server stores it, and a victim's browser runs it when loading the page.
caption: Figure 1. The server stores the comment as typed, then every visitor's browser runs it.
actors: Attacker | Server | Victim
Attacker -> Server: post comment with markup
Server --> Attacker: saved as typed
Victim -> Server: open the comments page
Server --> Victim: page includes the markup !
note Victim: browser runs it as the site !
```

> [!WARNING]
> Test for XSS only on sites you own or have written permission to test. Use harmless markers, never code that steals data or changes other people's accounts.

## Three kinds

**Stored XSS.** The input is saved (a comment, a profile name) and shown to everyone who views it. This is the most dangerous kind, because the victim does nothing except load the page.

**Reflected XSS.** The input is in the request, often a search term in a link, and the server echoes it back in the response. The attacker must get the victim to open the crafted link. It affects one request at a time.

**DOM-based XSS.** The flaw is purely in the browser. JavaScript reads something controllable, such as the part of the URL after `#`, and writes it into the page with a risky call like `innerHTML`. The server may never see the payload.

## What an attacker can do

Injected script runs with the victim's permissions on your site. It can **act as the victim**: send requests, post messages or change settings. It can **read the page**, including personal data on screen. It can read anything scripts can reach, such as `localStorage` and cookies that are not protected.

A cookie flagged `HttpOnly` cannot be read through `document.cookie`, according to MDN. That blocks one data theft route, but the script can still make requests, and the browser attaches the cookie to them. HttpOnly limits the damage and does not stop the attack. The [sessions post](/posts/sessions-jwt-and-load-balancers/) explains session cookies and tokens.

## How to diagnose it

**1. Map where user input is shown.** List every place a name, comment, search term, filename or URL part appears in a page, an email or an admin screen. Admin screens matter, because the viewer has more power.

**2. Search the code for risky sinks.** A **sink** is a spot where data becomes markup:

```bash
grep -rnE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write' src/
grep -rn 'dangerouslySetInnerHTML' src/
grep -rnE 'bypassSecurityTrust|v-html|\|\s*safe' src/
```

The last line looks for Angular's trust-bypass functions, Vue's `v-html` and the `safe` filter in some template engines. Frameworks escape output by default. Each of these is a deliberate way around that. Review every hit.

**3. Test with a harmless marker.** On your own site, submit a distinctive string such as `<b>xss-marker-123</b>` in each field. Open the page and view the source. If the text appears in bold, or the tags are present without being turned into `&lt;b&gt;`, the output is not encoded.

**4. Read Content-Security-Policy reports.** A **Content-Security-Policy (CSP)** is a response header telling the browser which scripts and resources may run. With a reporting directive, the browser sends a JSON report each time something is blocked. MDN describes `report-to` (also declare the older `report-uri` for browsers that lack it), and also a report-only mode, `Content-Security-Policy-Report-Only`, which reports without blocking. A blocked inline script you did not write is a clue.

## Fix 1: encode output for its context

**Output encoding** turns characters that have meaning in HTML into harmless text. The character `<` becomes `&lt;`, so the browser draws it and does not treat it as a tag.

```javascript
function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
```

Encoding must match the **context** where the data lands. OWASP's cheat sheet separates these:

- **HTML body:** encode as above, or set `textContent` instead of `innerHTML`.
- **HTML attribute:** always quote the value, then encode it.
- **URL parameter:** use `encodeURIComponent()` for the value.
- **JavaScript:** never insert untrusted code or expressions into a script. Prefer passing data as a data attribute or JSON and reading it safely.

The cost is discipline: use the right tool each time. That is why framework defaults matter.

## Fix 2: use the framework and do not bypass it

React, Angular and Vue escape values placed in templates. The danger is the escape hatch. `dangerouslySetInnerHTML`, `v-html` and Angular's `bypassSecurityTrust` functions all say "trust this string". Only use them on content you generated or have sanitized.

## Fix 3: sanitize when you must allow HTML

Sometimes users really need bold text or links, as in a rich text editor. Then encoding would break the feature. Use a maintained **sanitizer**, a library that removes dangerous tags and attributes and keeps safe ones. OWASP recommends DOMPurify for this. Keep it updated, because browsers change and new bypasses appear. Do not change the HTML after sanitizing it. Never write your own sanitizer with regular expressions.

## Fix 4: Content-Security-Policy as a second layer

A CSP can block inline scripts and scripts from unknown places. MDN says that with `script-src` or `default-src` set, inline scripts are blocked by default, and it describes a **nonce** (a random value, new on each response) that marks the scripts you trust. MDN also says to sanitize input **and** set a CSP, because a policy is not a replacement. Start with `Content-Security-Policy-Report-Only`, fix what it reports, then enforce.

## Fix 5: cookie flags

Add `HttpOnly` so scripts cannot read the session cookie, `Secure` so it travels over HTTPS only, and `SameSite=Lax` or `Strict` against cross-site requests. These reduce the damage. SameSite does not stop XSS, because injected script runs on your own site and its requests count as same-site.

## When the fix goes wrong

Encoding is the main fix, and it is easy to apply in a way that does not work. These are the three traps that matter most.

**1. Encoding for the wrong context.** The `escapeHtml` function above is right for the HTML body. People then use it everywhere. But each spot in a page reads text by different rules, so one encoder cannot fit all.

Take a name placed in an attribute with no quotes: `<input value=NAME>`. The attacker's name is `x onfocus=alert(1) autofocus`. `escapeHtml` changes nothing here, because there is no `<`, `&` or quote in it. I ran it, and the output was `<input value=x onfocus=alert(1) autofocus>`. The space ended the value, and the rest became new attributes. The fix is to always put quotes around attribute values, then encode.

The second case is an inline handler: `onclick="greet('NAME')"`. The browser decodes HTML entities in the attribute **before** it runs the text as JavaScript. So `&#39;` turns back into a real quote, and the attacker's quote ends your string. The encoding was undone before it could help. Do not put user text into handlers or script blocks. Attach the handler with `addEventListener`, and pass the value as data, such as a `data-` attribute that you read with JavaScript.

**2. Blocking bad words.** A filter that removes `<script>` looks like a fix. Attackers just choose another route. `<img src=x onerror=alert(1)>` has no `script` in it, and my removal filter let it through unchanged. A filter that removes the word once can even be tricked into building it: from `<scr<script>ipt>alert(1)</script>`, removing the inner `<script>` leaves `<script>alert(1)</script>`. A list of bad things is never complete. Encode output, so that every character is treated as plain text, whatever it spells.

**3. Trusting URLs in `href`.** A link `<a href="javascript:alert(1)">` runs code when clicked. `escapeHtml` does not touch it, because the text contains no special character. Checking `startsWith("javascript:")` also fails, because browsers ignore leading spaces and capital letters, so `" JaVaScRiPt:alert(1)"` still works as a link. Instead, parse the address with the `URL` class and allow only `http:` and `https:`. My check returned `#` for all of these, and kept `https://example.com/a`. It also rejects relative links such as `/a`, so adapt it if you need them.

Smaller traps, in short:

- **Sanitizing on input instead of encoding on output.** Data stored "clean" may later land in a different context, such as an email or a CSV. Encode when you display.
- **Markdown with raw HTML.** Some markdown libraries, such as marked, pass raw HTML through, so check your library's default. Turn that off or sanitize the result.
- **Rendering model output as markdown.** If a chat page renders images from untrusted text, a hidden image address can carry data out. [The prompt injection post](/posts/prompt-injection/) covers that related trick.
- **Relying on CSP alone.** A loose directive, such as `'unsafe-inline'` without a nonce or hash, removes most of its protection.

## Which should you use?

| Situation | Reach for |
|---|---|
| Showing user text on a page | **Output encoding**, or the framework default |
| Users need some HTML (rich text) | **A maintained sanitizer** such as DOMPurify |
| URLs from users in links | **Allow-list `http` and `https`** |
| Extra protection | **CSP**, started in report-only mode |
| Limiting damage | **HttpOnly, Secure, SameSite cookies** |

If you are not sure, ask where each piece of user text ends up, and check that the encoding matches that spot. When in doubt, show it as plain text.

## The takeaway

1. **XSS** happens when user input is inserted into a page as markup, so the browser runs it as your site's code.
2. It comes in three kinds: **stored**, **reflected** and **DOM-based**. Stored is the most dangerous.
3. Find it by listing where input is shown, **searching for risky sinks** like `innerHTML` and `dangerouslySetInnerHTML`, and testing with a harmless marker.
4. Fix it by **encoding output** for its context, keeping framework escaping on, and **sanitizing** with a library when HTML is needed.
5. Add **CSP** and **cookie flags** as extra layers. They reduce damage and do not replace encoding.
