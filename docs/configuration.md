# Configuration and SEO

All site-wide settings live in `site.config.json`. The build reads it every time. In `--serve` mode it is watched, so edits apply on save.

## Settings

| Key | Example | Used for |
|---|---|---|
| `title` | `Sudo Explain` | Site name in the header, page titles, footer, share cards, RSS |
| `eyebrow` | `$ sudo explain --topic anything` | Small line above the home page headline |
| `tagline` | `Tech concepts, explained until the doubt is gone.` | Home page headline and home page title |
| `description` | `An engineer's notebook on…` | Default meta description, home page intro, RSS |
| `author` | `Prince Singh` | Footer, `author` meta tag, structured data |
| `lang` | `en` | The `<html lang>` attribute, RSS language |
| `url` | `https://princepsr.github.io` | Scheme and host only. Used for canonical URLs, sitemap, RSS, share tags |
| `basePath` | `/SudoExplain` | Path prefix when the site is not at the root of its host. Use `""` at a domain root |
| `ogImage` | `/og.png` | Link-preview image (1200x630 file in `static/`). Leave out to disable |
| `github` | `https://github.com/princepsr` | Footer link. Leave empty to hide |
| `linkedin` | `https://linkedin.com/in/…` | Footer link. Leave empty to hide |

`url` and `basePath` together decide every absolute link. Keep `url` free of a trailing slash and a path, and put any path in `basePath`.

## Typography

Everything you read (post titles, body text, headings, navigation) uses one system sans-serif family: Segoe UI on Windows, San Francisco on Mac, Roboto on Android. Monospace is used only for code and the small command line above the home page headline. No fonts are downloaded, so text appears instantly and looks native on every device.

Body text is 19px with a 1.65 line height and about 80 characters per line, and the text colour is slightly softened in dark mode to reduce glare.

To try a serif look instead, open `assets/style.css` and set both of these at the top to `var(--serif)`:

```css
--font-read: var(--sans);
--font-display: var(--sans);
```

Every page shares one container (`--wide`), so headings, lists and articles all start at the same left edge as the logo. Article text is capped at `--read-width` (44rem), which gives about 80 characters per line at 19px. If you change the font size or `--read-width`, keep lines under roughly 90 characters, because longer lines are harder to follow.

## SEO that is built in

Nothing here needs configuring.

| Feature | Detail |
|---|---|
| Titles and descriptions | Unique per page. A post without `description` gets an excerpt of its first paragraph |
| Canonical URLs | Every page declares its own canonical address |
| Open Graph and Twitter tags | Title, description, type, site name, and the preview image with its size and alt text |
| Structured data (JSON-LD) | `WebSite` on the home page, `BlogPosting` on posts (headline, dates, author, keywords) |
| Sitemap | `/sitemap.xml`, with last-modified dates for posts. Drafts are excluded |
| RSS feed | `/rss.xml`, latest 20 posts, announced in every page's `<head>` |
| Indexing control | The 404 page and per-topic pages are `noindex, follow`, and the topic pages are not in the sitemap |
| Accessibility and speed | Semantic HTML, one `h1` per page, skip link, light and dark `theme-color`, deferred scripts, system fonts (no font downloads) |
| Dates | Posts expose published and modified dates. Set `updated` when you revise a post |

### Link-preview card

`static/og.png` is the image shown when a link to the site is shared on LinkedIn, X and similar. It is 1200x630. To replace it, overwrite the file with another 1200x630 image. Social networks cache previews, so a new image can take a while to appear. LinkedIn's Post Inspector can refresh it.

### Things to do outside the code

1. **Google Search Console.** Add the site and submit `sitemap.xml`. Do this on the custom domain once it is live, not on the `github.io` address.
2. **Write specific titles.** "Sessions vs JWT: where does your login actually live?" ranks better than "Authentication notes".
3. **Link between posts.** Internal links help readers and search engines find related posts.
4. **Update, don't replace.** When a post changes, edit it and set `updated`, so its URL and standing are kept.

### A limit to know about

`robots.txt` is only read from the root of a domain. While the site lives at `princepsr.github.io/SudoExplain/`, crawlers ignore it. It starts working once the site is on its own domain. Search engines still find the site through the sitemap and links.
