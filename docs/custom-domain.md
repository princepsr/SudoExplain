# Moving to sudoexplain.dev

The site currently lives at `https://princepsr.github.io/SudoExplain/`. This guide moves it to `https://sudoexplain.dev/`, with the domain registered and its DNS hosted at Spaceship.

A custom domain helps SEO and branding. Search engines build authority on a domain you control, `robots.txt` only works at a domain's root, and the address stays yours if you ever change host.

## What changes, in short

| Where | Change |
|---|---|
| Spaceship DNS | Delete the placeholder records, add four `A` records and a `www` `CNAME`, and add a verification `TXT` record |
| GitHub account settings, Pages | Verify the domain (recommended, prevents takeover) |
| GitHub repo, Settings, Pages | Enter the custom domain and enable HTTPS |
| `site.config.json` | `url` becomes `https://sudoexplain.dev` and `basePath` becomes `""` |
| Search Console and profiles | Add the new site and update your links |

Do **not** add a `static/CNAME` file. GitHub ignores a `CNAME` file for sites deployed with GitHub Actions, as this one is. The domain is set in the repo settings only.

## Order matters

Do the steps in this order. The site changes from `/SudoExplain/...` to the domain root, so it renders correctly only when the domain is saved in GitHub **and** the config change is deployed. Plan on a few minutes of broken styling between those two moments, and do them back to back.

1. DNS records (steps 1 and 2).
2. Domain verification (step 3).
3. Custom domain in the repo settings, and wait for the DNS check (step 4).
4. Push the config change immediately after the domain is saved (step 5).
5. Enforce HTTPS once the certificate is ready (step 6).

## Step by step

### 1. Look at what Spaceship set up by default

Spaceship adds placeholder records to a new domain. Right now `sudoexplain.dev` answers with two `A` records (`54.149.79.189` and `34.216.117.25`) that are not GitHub's. GitHub's documentation says to remove any default record your DNS provider adds before you continue. Open the DNS records for the domain in Spaceship's domain manager and **delete every default `A`, `AAAA`, `CNAME` or `ALIAS` record on the apex (`@`) and on `www`** that you did not add yourself. Leave the nameserver settings as they are.

### 2. Add the DNS records

Add these in Spaceship's DNS records page for `sudoexplain.dev`. The host `@` means the bare domain.

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `princepsr.github.io` |

Optional IPv6, four `AAAA` records with host `@`: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.

Points to watch:

- The `www` record points to `princepsr.github.io`, **not** to `sudoexplain.dev` and not to the long `*.pages.github.io` name shown in repo settings. GitHub says that pointing a subdomain at the apex domain causes HTTPS problems.
- Setting up `www` alongside the apex is recommended by GitHub. With both in place, `www.sudoexplain.dev` redirects to the apex.
- Do not use a wildcard record (`*`). GitHub warns it allows others to take over subdomains.
- Spaceship offers `ALIAS` records too, and GitHub accepts an `ALIAS` pointing at `princepsr.github.io` for the apex. The four `A` records are the simplest and are what this guide uses.
- The record values come from GitHub's page "Managing a custom domain for your GitHub Pages site". Check them there if they ever fail.

Check from your computer (DNS can take from minutes up to 24 hours to spread):

```bash
nslookup sudoexplain.dev
nslookup www.sudoexplain.dev
```

The first should list the four `185.199.x.153` addresses, and the second should show a `CNAME` to `princepsr.github.io`. If you still see `54.149.79.189`, the old placeholder record is still there or a cache has not expired.

### 3. Verify the domain (recommended)

Verification stops anyone else from claiming your domain on GitHub if the DNS is ever misconfigured.

1. In your **GitHub account** settings (not the repo), open **Pages**, then **Add a domain**, and enter `sudoexplain.dev`.
2. GitHub shows a `TXT` record. The host is `_github-pages-challenge-princepsr` and the value is a code GitHub gives you. Add it in Spaceship as a `TXT` record.
3. Back on GitHub, click **Verify**. It can take a while for DNS to catch up. You can check it with `nslookup -type=TXT _github-pages-challenge-princepsr.sudoexplain.dev`.

### 4. Set the domain in the repo

1. Open the repo **Settings, Pages**.
2. Under **Custom domain**, enter `sudoexplain.dev` and save.
3. GitHub runs a DNS check. If it fails at first, wait a few minutes and retry. When it passes, GitHub requests a free certificate from Let's Encrypt, and a check mark appears beside the domain when it is ready.

### 5. Update the site config and push straight away

In `site.config.json`:

```json
{
  "url": "https://sudoexplain.dev",
  "basePath": ""
}
```

Commit and push right after step 4. Canonical URLs, the sitemap, RSS, `llms.txt`, structured data and the preview-image URLs all follow from these two values. There is nothing else to edit. A dry run of this change was checked: every one of those outputs uses the new domain, and the stylesheet and internal links work from the root.

### 6. Turn on HTTPS

Once the check mark appears and the deploy has finished, tick **Enforce HTTPS** in the repo's Pages settings. `.dev` domains are on the browser HTTPS preload list, so browsers refuse plain `http://` for them anyway. The site will not load until the certificate exists, which is why this step comes only after step 4 succeeds. If the checkbox is greyed out, wait and refresh: the certificate is still being created. GitHub says that if it has not finished several minutes after you saved, click **Remove** next to the domain, type it again and save, which restarts the process. A certificate that never appears is usually caused by extra DNS records, or records that do not point at GitHub's addresses, so recheck step 1 and step 2.

### 7. Check it

- `https://sudoexplain.dev/` loads with styling, and the padlock shows HTTPS.
- `https://www.sudoexplain.dev/` redirects to it.
- The old address `https://princepsr.github.io/SudoExplain/` redirects to the new domain. GitHub does this automatically once a custom domain is set.
- `https://sudoexplain.dev/sitemap.xml`, `/robots.txt` and `/llms.txt` load and show the new domain.
- View source on a post and confirm the canonical link and `og:image` use the new domain.
- Refresh the preview card: paste the home page and a post into LinkedIn's Post Inspector.

## After the move: search and AI visibility

The site already ships the technical basics: one canonical URL per page, a sitemap with last-modified dates, an RSS feed, Open Graph and Twitter cards with a per-post image, `BlogPosting` and breadcrumb structured data, a robots meta tag that allows large snippets and previews, and an `llms.txt` file that lists every published post. These are the steps that need you.

### Tell search engines

1. **Google Search Console.** Add a **Domain** property for `sudoexplain.dev`. Google gives you a `TXT` record to add in Spaceship, and that one property then covers `www` and every path. Submit `https://sudoexplain.dev/sitemap.xml`. After you publish each post, use **URL inspection, Request indexing** on its address.
2. **Bing Webmaster Tools.** Add the site (it can import from Search Console). Bing's results also feed several AI assistants and other search tools. IndexNow, a protocol Bing and some other engines support, can tell them about new posts instantly. Google does not use it.
3. **Do not block crawlers.** `robots.txt` allows everything, including AI crawlers. Keep it that way if you want to be quoted in AI answers.

### Write for answers, not only for rankings

Answer engines and featured snippets quote text that answers a question directly. The posts already follow a pattern that suits this. Keep it going:

- **Put the plain answer near the top.** The "doubt" section and the summary box state the question and what the reader will learn. A one-sentence definition under a question-style heading is easy to lift.
- **Use the searcher's words in headings and titles.** The title starts with the phrase people type, such as "N+1 query problem" or "CORS errors explained".
- **Use tables and numbered steps for comparisons and procedures.** The "Which should you use?" tables and the "Fix 1/2/3" structure are the kind of content that gets summarized accurately.
- **Show who wrote it.** The About page and the `sameAs` links to GitHub and LinkedIn tie each post to a real author, which helps readers and machines trust it. Keep the About page up to date.
- **Keep posts current.** When a post changes, set `updated` in the front matter. The sitemap and the page show the new date.
- **Link your posts to each other.** Every post already links to related ones. When you publish a new post, add links to it from two or three older posts.

### Get linked and seen

- Share each post on LinkedIn with its own card. Post Inspector refreshes the preview.
- If you republish a post on another site such as dev.to or Hashnode, set the canonical URL there to your own address, so your domain gets the credit. Publish on your site first.
- Submit a post to communities where the topic fits and the rules allow it. One genuinely useful answer on a Q&A site that links to the matching post beats ten generic shares.
- Update the site link on your LinkedIn and GitHub profiles to `https://sudoexplain.dev`.

### What to expect

New domains take weeks to build up in search results. Indexing a post can take from a day to a few weeks, and rankings depend on competition, quality and links more than on any technical setting. `llms.txt` is a young convention with unproven effect, which is why it is cheap and harmless rather than a strategy.

## Rolling back

If something goes wrong, remove the custom domain in **Settings, Pages**, set `url` back to `https://princepsr.github.io` and `basePath` back to `/SudoExplain`, then push. The site returns to the original address. Leave the DNS records in place or delete them, as you prefer.
