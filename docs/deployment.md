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

The site then appears at `https://<account>.github.io/<repo>/`. For a repository named `<account>.github.io`, it appears at `https://<account>.github.io/` and `basePath` should be `""`.

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
| The page loads without styling or images | `basePath` does not match where the site is served. For `…github.io/SudoExplain/` it must be `/SudoExplain`. At a domain root it must be `""` |
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
