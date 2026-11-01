# Deployment

The site is built by GitHub Actions and served by GitHub Pages. There is no manual build or upload step.

## How it works

1. You push to `main`.
2. `.github/workflows/deploy.yml` runs `node build.mjs`, which writes the site to `dist/`.
3. The workflow uploads `dist/` as the Pages artifact and deploys it.
4. The site updates in about a minute.

`dist/` is git-ignored. Generated files are never committed, so `main` holds source only.

## One-time setup

1. Create a **public** repository on GitHub under the account that should own the site. Leave it empty (no README, licence or `.gitignore`).
2. Add it as `origin` and push `main`.
3. In the repo, open **Settings → Pages**, and set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. If the first run failed because Pages was not enabled yet, open it and choose **Re-run all jobs**.

Until a custom domain is set, the site appears at `https://<account>.github.io/<repo>/`, and `site.config.json` needs `basePath` set to `/<repo>`.

## Custom domain (sudoexplain.dev)

The site is served at `https://sudoexplain.dev/`, with the domain registered at Spaceship and DNS also edited there.

**DNS records at Spaceship** (no other `A`, `AAAA`, `CNAME` or `ALIAS` records on `@` or `www`):

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (four records) |
| CNAME | `www` | `princepsr.github.io` (not the apex, not the `*.pages.github.io` name) |
| TXT | `_github-pages-challenge-princepsr` | The code GitHub gave when the domain was verified in the account's **Pages** settings. Keep it, so nobody else can claim the domain |

**GitHub:** repo **Settings → Pages → Custom domain** is `sudoexplain.dev` with **Enforce HTTPS** ticked. Do not add a `CNAME` file to `static/`. GitHub ignores it for sites deployed by a workflow, so the setting in the repo is the only source.

**In the repo:** `site.config.json` has `url` set to `https://sudoexplain.dev` and `basePath` set to `""`. Canonical URLs, the sitemap, RSS, `llms.txt`, structured data and share-card URLs all follow from these two values.

**Check after any change:** `https://sudoexplain.dev/`, `/sitemap.xml`, `/robots.txt` and `/llms.txt` load. `www` redirects to the apex, and the old `princepsr.github.io/SudoExplain/` address redirects to the new domain (GitHub does both).

**If the domain ever stops working:** a missing certificate is usually caused by extra DNS records or records that do not point at GitHub. If provisioning stalls, click **Remove** next to the domain in Settings → Pages, retype it and save. To go back to the github.io address, remove the custom domain, set `url` to `https://princepsr.github.io` and `basePath` to `/SudoExplain`, and push.

## Everyday workflow

```bash
node build.mjs --serve        # write and preview
git add -A
git commit -m "docs: add post about X"
git push
```

Then watch the run in the repo's **Actions** tab. A green run means the site is live.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The site shows a 404 right after setup | The first deploy has not finished, or Pages Source is not set to **GitHub Actions**. Check Settings → Pages, then the Actions tab |
| The workflow fails with a Pages or permissions error | Pages is not enabled. Set Source to **GitHub Actions** and re-run the job |
| The page loads without styling or images | `basePath` does not match where the site is served. At the domain root (sudoexplain.dev) it must be `""`. Under a repository path such as `…github.io/SudoExplain/` it must be `/SudoExplain` |
| The domain shows a certificate or "not secure" error | The certificate is still being issued, or DNS has extra records. See **Custom domain** above |
| A new post is missing | It still has `draft: true`, you have not pushed, or the build failed. Check the Actions log |
| The build fails naming a file | That post's front matter is missing a `title` or has an invalid `date` (`YYYY-MM-DD`) |
| Local preview shows old content | Refresh the browser. The dev server rebuilds on save but does not live-reload |
| Git prints "LF will be replaced by CRLF" | Harmless line-ending notice on Windows. It does not affect the site |
| A push is rejected or asks for credentials | The remote is not using the personal SSH alias. See **Git identity** in the README |

## Pushing to the right account

If you also use a work GitHub account on the same machine, use a repo-local identity and a separate SSH key for this repo (see **Git identity** in the README). Check before pushing:

```bash
git config user.email
git remote -v
```

The email should be the personal one and the remote should use the personal SSH alias. The GitHub CLI (`gh`) may be signed in to a different account, so do not use it to create or push this repo.
