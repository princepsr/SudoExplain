# Sudo Explain

A hand-built static blog about tech concepts, system design and the problems I run into. Plain HTML and CSS generated from Markdown by one small script.

- **Zero dependencies.** No npm packages, no CDN, no web fonts, no frameworks. Needs only Node 20+.
- **Fast and private.** No trackers, no cookie banner, no client-side framework.
- **Hosted free** on GitHub Pages, deployed automatically on every push to `main`.

Live site: https://princepsr.github.io/SudoExplain/

## Quick start

```bash
node build.mjs --serve
```

Open http://localhost:4000. Drafts are visible and the site rebuilds when you save a file (refresh the browser to see changes).

To build once without serving:

```bash
node build.mjs            # published posts only, output in dist/
node build.mjs --drafts   # include drafts
```

## Publish a post

1. Create `content/posts/my-post.md` (see [Writing posts](docs/writing.md)).
2. Preview it with `node build.mjs --serve`.
3. Commit and push to `main`. GitHub Actions builds and deploys in about a minute.

## Documentation

| Guide | What it covers |
|---|---|
| [Writing posts](docs/writing.md) | Front matter, supported Markdown, code highlighting, images, drafts |
| [Configuration and SEO](docs/configuration.md) | Every `site.config.json` setting, and the SEO that is built in |
| [Deployment](docs/deployment.md) | How GitHub Pages and the workflow are set up, plus troubleshooting |
| [Custom domain](docs/custom-domain.md) | Step-by-step checklist for moving to your own domain |

## Project layout

| Path | Purpose |
|---|---|
| `content/posts/*.md` | Posts |
| `content/about.md` | About page |
| `assets/style.css` | All styling (design tokens at the top, light and dark themes) |
| `assets/theme.js` | Theme toggle and code-copy buttons |
| `static/` | Copied as-is to the site root (favicon, social card, post images) |
| `site.config.json` | Site name, tagline, links, URL |
| `build.mjs` | The generator: Markdown, templates, highlighting, RSS, sitemap, dev server |
| `.github/workflows/deploy.yml` | Builds and deploys to GitHub Pages |
| `docs/` | These guides |
| `dist/` | Build output (git-ignored) |

## Git identity

This repo commits as the personal GitHub account, separate from any work account. The settings are repo-local:

- `user.name` and `user.email` are set in this repo's git config.
- The `origin` remote uses the SSH host alias `github-princepsr`, which maps to `github.com` with the `~/.ssh/princepsr` key.
