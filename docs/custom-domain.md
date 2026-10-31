# Moving to a custom domain

The site currently lives at `https://princepsr.github.io/SudoExplain/`. This guide moves it to your own domain, for example `https://sudoexplain.dev/`.

A custom domain is worth doing for SEO and branding. Search engines build authority on a domain you control, and `robots.txt` only works at a domain's root.

## What changes, in short

| Where | Change |
|---|---|
| Domain registrar | Buy the domain and add DNS records pointing at GitHub |
| GitHub repo, Settings → Pages | Enter the custom domain and enable HTTPS |
| `site.config.json` | `url` becomes the new domain, and `basePath` becomes `""` |
| Search Console and profiles | Re-add the site and update links |

Do **not** add a `static/CNAME` file. GitHub ignores a `CNAME` file for sites deployed with GitHub Actions, as this one is. The domain is configured in the repo settings only.

## Checklist

### 1. Buy the domain

Use a registrar such as Cloudflare Registrar, Namecheap or Porkbun. Before paying, check the exact name is free and search the name on Google to avoid clashing with an established site. A `.dev` domain costs roughly 12 USD a year, and `.dev` requires HTTPS (which GitHub Pages provides).

### 2. Add DNS records

In your registrar's DNS settings, add the records for the form of address you want. This guide assumes the **apex** (`sudoexplain.dev`) as the main address, with `www` redirecting to it.

**Apex domain** (`sudoexplain.dev`): four `A` records, all with host `@`:

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |

Optional IPv6, four `AAAA` records with host `@`: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.

**`www` subdomain**: one `CNAME` record:

| Type | Host | Value |
|---|---|---|
| CNAME | `www` | `princepsr.github.io` |

If you prefer a subdomain as the main address (for example `blog.example.com`), add only a single `CNAME` for that host pointing to `princepsr.github.io`.

Check GitHub's current values before relying on these. They are listed in the "Managing a custom domain for your GitHub Pages site" page of GitHub's documentation.

### 3. Verify the domain (recommended)

In your GitHub **account** settings, open **Pages** and add the domain under **Add a domain**. GitHub gives you a TXT record to add at your registrar. This stops anyone else from claiming your domain on GitHub if the DNS is ever misconfigured.

### 4. Set the domain in the repo

1. Open the repo's **Settings → Pages**.
2. Under **Custom domain**, enter the domain (`sudoexplain.dev`) and save.
3. GitHub runs a DNS check. If it fails at first, wait a few minutes (DNS can take up to a day) and retry.
4. When it passes and the certificate is ready, tick **Enforce HTTPS**.

### 5. Update the site config, and push straight away

In `site.config.json`:

```json
{
  "url": "https://sudoexplain.dev",
  "basePath": ""
}
```

Commit and push. Do this right after step 4. The site changes from `/SudoExplain/…` to the domain root, so the pages are served correctly only once both the domain and the config are in place. Expect a few minutes where CSS or links look wrong between step 4 and the deploy finishing.

Canonical URLs, the sitemap, RSS, structured data and the preview-image URL all follow from these two values. There is nothing else to edit.

### 6. Check it

- `https://sudoexplain.dev/` loads with styling, and the padlock shows HTTPS.
- `https://www.sudoexplain.dev/` redirects to it.
- The old address `https://princepsr.github.io/SudoExplain/` redirects to the new domain. GitHub does this automatically once a custom domain is set.
- `https://sudoexplain.dev/sitemap.xml` and `/robots.txt` load, and show the new domain.
- View source on a post and confirm the canonical link and `og:image` use the new domain.
- Run the home page through LinkedIn's Post Inspector to refresh the preview card.

### 7. Tell search engines

1. Add the new domain to **Google Search Console** (a "Domain" property with the DNS TXT method is the easiest) and submit `https://sudoexplain.dev/sitemap.xml`.
2. Optionally add it to **Bing Webmaster Tools**.

### 8. Update links elsewhere

Change the site link on your LinkedIn profile, GitHub profile and bio, and any posts you shared. Old links keep working through the redirect, but new ones should use the domain directly.

## Rolling back

If something goes wrong, remove the custom domain in **Settings → Pages**, set `url` back to `https://princepsr.github.io` and `basePath` back to `/SudoExplain`, then push. The site returns to the original address.
