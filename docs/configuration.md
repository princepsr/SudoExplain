# Configuration and SEO

All site-wide settings live in `site.config.json`. The build reads it every time. In `--serve` mode it is watched, so edits apply on save.

## Settings

| Key | Example | Used for |
|---|---|---|
| `title` | `Sudo Explain` | Site name in the header, page titles, footer, share cards, RSS |
| `eyebrow` | `$ sudo explain --topic anything` | Small line above the home page headline |
| `tagline` | `The why behind the tech, explained clearly.` | Home page headline and home page title |
| `description` | `An engineer's notebook on…` | Default meta description, home page intro, RSS |
| `author` | `Prince Singh` | Footer, `author` meta tag, structured data |
| `lang` | `en` | The `<html lang>` attribute, RSS language |
| `url` | `https://sudoexplain.dev` | Scheme and host only. Used for canonical URLs, sitemap, RSS, share tags |
| `basePath` | `""` | Path prefix when the site is not at the root of its host. Empty at a domain root, as now. Would be `/SudoExplain` on a github.io project address |
| `ogImage` | `/og.png` | Link-preview image (1200x630 file in `static/`). Leave out to disable |
| `github` | `https://github.com/princepsr` | Footer link. Leave empty to hide |
| `linkedin` | `https://linkedin.com/in/…` | Footer link. Leave empty to hide |

`url` and `basePath` together decide every absolute link. Keep `url` free of a trailing slash and a path, and put any path in `basePath`.

## Typography

Everything you read (post titles, body text, headings, navigation) uses one system sans-serif family: Segoe UI on Windows, San Francisco on Mac, Roboto on Android. Monospace is used only for code and the small command line above the home page headline. No fonts are downloaded, so text appears instantly and looks native on every device.

Body text is 18px with a 1.65 line height and about 80 characters per line. The text colour is softened in both themes to reduce glare: dark brown-grey on cream in light mode (about 11:1 contrast) and warm off-white in dark mode (about 13:1). Both are far above the 4.5:1 accessibility minimum.

To try a serif look instead, open `assets/style.css` and set both of these at the top to `var(--serif)`:

```css
--font-read: var(--sans);
--font-display: var(--sans);
```

Every page shares one container (`--wide`), so headings, lists and articles all start at the same left edge as the logo. They also all start the same distance below the header (`--top-gap`), and the side panels (the contents list on posts and the terminal on the About page) begin at that height and stick there (`--sticky-top`), so they do not shift when you start to scroll. Article text is capped at `--read-width` (42rem), which gives about 80 characters per line at 18px. If you change the font size or `--read-width`, keep lines under roughly 90 characters, because longer lines are harder to follow.

On large monitors the whole design scales up together: from 1600px wide the base font size is 112.5%, and from 2200px it is 125%. Because everything is sized in `rem`, the container, the text and the reading column all grow in step, so a line still holds about 80 characters and the empty margins shrink. Laptops below 1600px wide (most 14" and 15" screens) are not affected. To change or remove this, edit the two `@media (min-width: ...)` rules next to the `html` rule in `assets/style.css`.

## SEO that is built in

Nothing here needs configuring.

| Feature | Detail |
|---|---|
| Titles and descriptions | Unique per page. A post without `description` gets an excerpt of its first paragraph. The site name is added to the page title only when the result stays within 60 characters, because search results cut longer titles |
| Canonical URLs | Every page declares its own canonical address |
| Open Graph and Twitter tags | Title, description, type, site name, and the preview image with its size and alt text |
| Structured data (JSON-LD) | `WebSite` on the home page, `BlogPosting` and `BreadcrumbList` on posts (headline, dates, image, reading time, author with links to GitHub and LinkedIn) |
| Search and AI crawler hints | A robots meta tag allowing large snippets and image previews on indexable pages, and `/llms.txt`, a plain-text list of every published post with its summary (drafts are never listed) |
| Sitemap | `/sitemap.xml`, with last-modified dates for posts. Drafts are excluded |
| RSS feed | `/rss.xml`, latest 20 posts, announced in every page's `<head>` |
| Indexing control | The 404 page is `noindex, follow`. A topic page is `noindex` too, unless it has an introduction in `content/topics/<topic>.md` and at least two published posts. Then it becomes an indexable hub, with its own title, description, `CollectionPage` structured data, and a sitemap entry (see Topic hubs below) |
| Icons | `favicon.ico`, SVG and PNG icons and an Apple touch icon, made from `static/favicon.svg` with `node icons.mjs`. Search engines need the ICO or PNG, an SVG alone is not enough |
| Accessibility and speed | Semantic HTML, one `h1` per page, skip link, light and dark `theme-color`, deferred scripts, system fonts (no font downloads) |
| Dates | Posts expose published and modified dates. Set `updated` when you revise a post |

### Topic hubs

Every tag has a page at `/tags/<tag>/`. To make one worth indexing, add `content/topics/<tag>.md` with a title (60 characters or fewer, starting with the phrase people search for), a description (about 160 characters) and a short introduction of 80 to 200 words:

```markdown
---
title: Caching explained through real production failures
description: How caches go wrong in production: stale data, stampedes and inconsistent servers.
---

A short introduction that says what the topic covers and who it is for.
```

The page stays `noindex` and out of the sitemap until the topic has two published posts, so a hub never appears as a thin list of one link. Do not link to specific posts in the introduction, because the post list below it is built automatically and a link to a draft would break. Introductions exist for caching, java, databases, scaling, reliability, security, performance and debugging.

### Link-preview card

`static/og.png` is the image shown when a link to the site's home page is shared on LinkedIn, X and similar. It is 1200x630. To replace it, overwrite the file with another 1200x630 image.

Each post has its own card in `static/og/<post-name>.png`, showing the post's title and topics. Make them with `node og-images.mjs` (needs Edge or Chrome installed). Posts without a card fall back to the home page image, and `node build.mjs --check` tells you which ones are missing. If you retitle a post, run the command again. The old address of a renamed post also carries the post's title and card, so a link shared before the rename still previews correctly.

Social networks cache previews, so a changed image or title can take a while to appear. LinkedIn's Post Inspector (search for it) and the X card validator can refresh a link.

### Things to do outside the code

1. **Google Search Console.** Add a **Domain** property for `sudoexplain.dev` (Google gives a `TXT` record to add at Spaceship) and submit `https://sudoexplain.dev/sitemap.xml`. After publishing a post, use **URL inspection, Request indexing** on its address.
2. **Bing Webmaster Tools.** Add the site (it can import from Search Console). Bing also feeds several AI assistants. Google does not use IndexNow, so it is not needed for Google.
3. **Keep `robots.txt` open.** It allows every crawler, AI crawlers included. Keep it that way to be quoted in AI answers.
4. **Write specific titles.** "Sessions vs JWT: where does your login actually live?" ranks better than "Authentication notes". Start with the phrase people search for.
5. **Answer first.** Put a plain answer near the top, and use tables and numbered steps for comparisons and procedures. These are the parts snippets and AI answers quote.
6. **Link between posts.** When a post is published, link to it from two or three older ones.
7. **Update, don't replace.** When a post changes, edit it and set `updated`, so its URL and standing are kept.
8. **Cross-posting.** If a post is republished elsewhere (dev.to, Hashnode), set the canonical URL there to the sudoexplain.dev address, and publish here first.

Search results take weeks to build for a new domain, and indexing a post can take from a day to a few weeks. `llms.txt` is a young convention with unproven effect, which is why it is only a cheap extra.
