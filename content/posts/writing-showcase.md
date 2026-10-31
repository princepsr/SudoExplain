---
title: Writing showcase (draft, only visible in dev)
date: 2026-10-30
description: Every formatting feature this blog supports, for checking the design.
tags: meta
draft: true
---

This draft exists so you can see how each element looks. It's hidden from the published site because `draft: true` is set. Delete the file whenever you like.

## Text

Regular text with **bold**, *italic*, `inline code`, and a [link to somewhere](https://example.com). Long paragraphs wrap in a comfortable measure so they stay readable on both phones and wide monitors.

### Lists

- First point
- Second point
  - A nested point
  - Another nested point
- Third point

1. Step one
2. Step two
3. Step three

## Code

```java
public final class Greeter {
    private static final String PREFIX = "Hello, ";

    public String greet(final String name) {
        return PREFIX + name;
    }
}
```

```bash
node build.mjs --serve
```

## Table

| Concept | Scope | Lifetime |
|---|---|---|
| Request | One call | Milliseconds |
| Session | One user | Minutes to hours |
| Application | Whole server | Until restart |

## Quote and rule

> A good explanation removes a doubt instead of adding vocabulary.

---

## Raw HTML (for diagrams)

<svg viewBox="0 0 320 80" role="img" aria-label="Simple flow diagram">
  <rect x="4" y="20" width="90" height="40" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="49" y="45" text-anchor="middle" font-size="14" fill="currentColor">Browser</text>
  <line x1="94" y1="40" x2="226" y2="40" stroke="currentColor" stroke-width="2"/>
  <rect x="226" y="20" width="90" height="40" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="271" y="45" text-anchor="middle" font-size="14" fill="currentColor">Server</text>
</svg>
