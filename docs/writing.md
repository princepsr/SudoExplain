# Writing posts

Every post is one Markdown file in `content/posts/`. The filename becomes the URL: `sessions-vs-jwt.md` is published at `/posts/sessions-vs-jwt/`.

## Front matter

Each post starts with a block between `---` lines:

```markdown
---
title: Sessions vs JWT: where does your login actually live?
date: 2026-10-31
description: One sentence shown in post lists and search results.
tags: authentication, web, system-design
---
```

| Field | Required | Meaning |
|---|---|---|
| `title` | Yes | Page heading and browser title |
| `date` | Yes | Publish date, `YYYY-MM-DD`. Posts are sorted newest first |
| `description` | No | Shown in lists and search results. Aim for under 160 characters. If omitted, the first paragraph is used |
| `tags` | No | Comma-separated. Each tag gets its own topic page |
| `draft` | No | `true` hides the post from the published site. Drafts are visible in `--serve` and `--drafts` builds |
| `updated` | No | `YYYY-MM-DD`. Set it when you revise a post, so search engines see the new date |
| `slug` | No | Overrides the filename in the URL |

A missing `title` or an invalid date stops the build with an error that names the file.

## Supported Markdown

- Headings `#` to `######`. Each one gets an anchor link and a unique id
- Paragraphs, **bold**, *italic*, `inline code`, links, images
- Bulleted and numbered lists, including nested lists
- Tables, with column alignment (`:---`, `:---:`, `---:`)
- Blockquotes and horizontal rules
- Fenced code blocks, with syntax highlighting
- Raw HTML blocks, which is useful for inline SVG diagrams. A block that starts with `<` is passed through unchanged, and it ends at the first blank line, so keep blank lines out of it. Wrap a wide diagram in `<div class="diagram">…</div>` so it keeps a readable size and scrolls sideways on phones. Use `currentColor` and `var(--accent)` for strokes and text so it follows the light and dark themes

Not supported: footnotes, task lists, underscore-style italics (`_text_`), and inline HTML mixed into a paragraph.

## Code highlighting

Tag the opening fence with a language and the code is coloured at build time. This adds no JavaScript for readers:

````markdown
```java
public final class Greeter { }
```
````

| Tag | Aliases |
|---|---|
| `java` | |
| `javascript` | `js`, `jsx`, `mjs`, `typescript`, `ts`, `tsx` |
| `python` | `py` |
| `bash` | `sh`, `shell`, `zsh` |
| `sql` | |
| `json` | |
| `yaml` | `yml` |
| `html` | `xml`, `svg` |

Any other tag, or none, renders as plain text with special characters escaped. Use `text` for output you do not want coloured, and `pseudocode` for language-neutral concept snippets (the tag shows as a small label on the block). The highlighter is a regex tokenizer, so unusual syntax can occasionally be coloured imperfectly.

To add a language, add an entry to `LANGS` and its names to `LANG_ALIASES` in `build.mjs`. Colours live in `assets/style.css` under the `--tok-*` variables.

## Images

Put image files in `static/`. They are copied to the site root, so `static/diagram.png` is referenced as:

```markdown
![A diagram of the request flow](/diagram.png)
```

Always write meaningful alt text. It is used by screen readers and by search engines. Keep images small (compress them first) so pages stay fast.

## Drafts and previewing

- Set `draft: true` while you write, and preview with `node build.mjs --serve`.
- Remove `draft: true` (or set it to `false`) when the post is ready, then push.
- `content/posts/writing-showcase.md` is a draft that demonstrates every element. It is never published. Delete it whenever you like.

## "On this page" contents list

Posts with three or more `##` sections get a sticky contents list in the right-hand column on screens 1100px and wider. The article starts at the same left edge as every other page. It is built automatically from your `##` headings, so give them short, clear names. Nothing to configure.

## Other pages

- **About page:** `content/about.md`. It needs only a `title` in its front matter.
- **Navigation** (Writing, Topics, About) is fixed in `build.mjs`. Edit the `layout` function to change it.
