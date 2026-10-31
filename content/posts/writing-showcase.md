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
# start the dev server
export PORT=4000
node build.mjs --serve --drafts   # rebuilds on save
echo "Listening on $PORT"
```

```javascript
// Debounce a function
const debounce = (fn, ms = 200) => {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
};
```

```python
@cache
def fib(n: int) -> int:
    """Return the n-th Fibonacci number."""
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

```sql
-- Slowest queries first
SELECT user_id, COUNT(*) AS total
FROM orders
WHERE created_at > '2026-01-01'
GROUP BY user_id
ORDER BY total DESC
LIMIT 10;
```

```json
{
  "name": "sudo explain",
  "private": true,
  "version": 1.5,
  "tags": ["java", "design"],
  "draft": null
}
```

```yaml
# CI settings
on:
  push:
    branches: [main]
steps:
  - run: node build.mjs
    name: "Build site"
```

```html
<!-- a link -->
<a href="/posts/" class="nav">Writing</a>
```

```text
Unknown languages stay plain: no colours, still escaped <safely> & "quoted".
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
