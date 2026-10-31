# Blog

Hand-built static blog. No npm packages, no CDN, no external fonts. Needs only Node 20+.

## Write a post

Create `content/posts/my-post.md`:

```markdown
---
title: My post title
date: 2026-11-01
description: One sentence shown in lists and search results.
tags: java, concepts
draft: false
updated: 2026-11-05   # optional, set when you revise a post (feeds search engines)
---

Your Markdown here.
```

Supported: headings, paragraphs, **bold**, *italic*, `code`, links, images, lists (nested), tables, blockquotes, fenced code blocks, horizontal rules, and raw HTML blocks (handy for inline SVG diagrams). Set `draft: true` to hide a post from the published site.

Code blocks are highlighted at build time (no client JS) when you tag the fence with a language: `java`, `javascript`/`js`/`ts`, `python`, `bash`/`sh`, `sql`, `json`, `yaml`, `html`/`xml`. Other tags (or none) render as plain, escaped text. To add a language, add an entry to `LANGS` and `LANG_ALIASES` in `build.mjs`.

Put post images in `static/` (copied to the site root) and reference them as `/my-image.png`.

## Preview locally

```bash
node build.mjs --serve
```

Open http://localhost:4000. Drafts are visible, and the site rebuilds when you save a file (refresh the browser to see changes).

## Publish on GitHub Pages

1. Create a repo named `<your-username>.github.io` and push this folder to its `main` branch.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Edit `site.config.json` so `url` is `https://<your-username>.github.io`.
4. Every push to `main` rebuilds and deploys via `.github/workflows/deploy.yml`.

If you use a project repo instead (`<user>.github.io/<repo>/`), set `"basePath": "/<repo>"` in `site.config.json`.

## Custom domain later

1. Buy the domain and add a file `static/CNAME` containing just the domain (for example `princesingh.dev`).
2. Point DNS at GitHub Pages (see GitHub's custom domain docs), then set it under **Settings → Pages → Custom domain** and enable HTTPS.
3. Update `url` in `site.config.json` to the new domain.

## SEO

Built in: unique title and description per page (a post without `description` gets an auto-excerpt from its first paragraph), canonical URLs, Open Graph and Twitter tags with a link-preview image, JSON-LD (`WebSite` on the home page, `BlogPosting` on posts), a sitemap with last-modified dates, an RSS feed, light/dark `theme-color`, and semantic HTML. Thin pages (404 and per-topic pages) are `noindex, follow` and left out of the sitemap.

The link-preview card is `static/og.png` (1200x630), referenced by `"ogImage"` in `site.config.json`. Replace the file to change it.

**When you add your custom domain:** add `static/CNAME`, set `"basePath": ""` and change `"url"` in `site.config.json`. Canonical URLs, the sitemap, RSS, JSON-LD and the preview image URL all follow automatically.

After going live (ideally on your own domain), add the site in Google Search Console and submit `sitemap.xml`.

## Layout

| Path | Purpose |
|---|---|
| `content/posts/*.md` | Posts |
| `content/about.md` | About page |
| `assets/style.css` | All styling (design tokens at the top) |
| `assets/theme.js` | Theme toggle and code-copy buttons |
| `static/` | Copied as-is to the site root (favicon, CNAME, images) |
| `site.config.json` | Title, tagline, links, URL |
| `build.mjs` | The generator |
