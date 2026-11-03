# Ideas for later

Things we talked about and decided to leave out for now. Nothing here is built. Each entry says why it waits and what the simplest route would be.

The site is a static site on GitHub Pages: it serves files and cannot store anything itself. Anything that needs to remember data from visitors (likes, comments, view counts, email addresses) needs an outside service. The site currently loads no scripts from other hosts and sets no cookies, and the footer's "no trackers" line depends on that. If you add any of these, reword that line.

## Likes

Decided: not now. A like total that every reader sees must be stored somewhere, which a static host cannot do.

| Option | Shared count | Needs | Notes |
|---|---|---|---|
| Local-only button | No, it is 0 or 1 for that reader | Nothing, uses the browser's `localStorage` | Call it "Saved" or "Helpful", not a counter, so it does not mislead |
| GitHub reactions through Giscus | Yes | A GitHub sign-in for readers, and one script from another host | Free. Comes with comments |
| A hosted counter (Supabase, Firebase, Cloudflare Workers KV) | Yes | A short script of your own, and protection against repeat likes | Free tiers exist. Avoid storing IP addresses |

Simplest route if wanted later: Giscus, because it gives comments and likes together.

## Comments

Decided: not now.

- **Giscus** stores comments as GitHub Discussions on the repo. Free and open source, with one script tag. Readers sign in with GitHub, which suits a developer audience and keeps spam low, but it is a barrier for other readers. Turn on Discussions in the repo settings first. The plan was a `comments` switch in `site.config.json` and a theme that follows light and dark mode.
- **Utterances** is the same idea using GitHub Issues.
- **Disqus** needs no GitHub sign-in but adds ads and trackers, which conflicts with the "no trackers" promise.

## Views count

Decided: later, now that the site has its own domain. A static page cannot count its own visitors, so this needs an analytics service. Search Console already shows impressions and clicks from Google search for free, with no code, so look there first.

Options that avoid cookies and cookie banners (check current pricing and terms before choosing):

- **GoatCounter**: free for non-commercial use, simple, no cookies.
- **Cloudflare Web Analytics**: free, no cookies, needs a Cloudflare account.
- **Plausible**: privacy-friendly, paid.

A public number shown on each post (not just a private dashboard) needs the service to offer a public count or an API, and a small script on the post page. The home page already shows "N min read" for each post, so a view count would go next to it.

## Email subscribe

Decided: not now. RSS already works: the feed is at `/rss.xml` and every page announces it, so readers can follow with Feedly, Inoreader, NetNewsWire and similar.

Email reaches readers who do not use feed readers, but it needs a service to hold the addresses and send mail. Options: Buttondown, MailerLite or Substack, set up to email subscribers from the RSS feed. The site would only need a plain HTML form that posts to their address, with no script. Say in one line next to the form that the address goes to that company. Add it once there are a few posts and readers are asking, because until then there is nothing to send.

## Ask a question about this post (LLM)

Idea from a reader of the project, for if the site grows: a box on each post where a reader asks a question, and an LLM answers using that post's text as its context. Not decided and not planned yet.

A static site cannot call an LLM safely on its own. Calling a model API from the page would expose the API key to everyone, so this needs a small backend, such as a serverless function, that holds the key and sends the post text plus the question to the model. Things to settle before building it:

- **Cost.** Every question is billed to you. It needs a per-visitor rate limit and a spending cap, or one abusive visitor can run up the bill.
- **Abuse.** Without limits the box can be used as a free general chatbot. The system prompt should keep answers to the post, and the answer should say so when the post does not cover the question.
- **Accuracy.** The model can still state wrong things confidently. Show that answers are generated, and link back to the section of the post that supports each one.
- **Privacy.** Questions leave the site and go to the model provider. Say so next to the box, and do not log anything personal. This also ends the "no scripts from other hosts, no tracking" claim for those pages.
- **Value.** It is worth building only if readers ask questions the posts do not already answer. Comments or Search Console queries can show whether they do first.

Simplest first step if wanted: one serverless function plus a small script that loads only on post pages, with the post text sent as context, a daily cap, and no stored history.

## Other ideas

- **IndexNow for Bing:** tells Bing and some other engines about new posts at once. Google does not use it. Bing's results also feed several AI assistants, so it can help, but the sitemap already works without it.
- **Runnable lab per post:** a small repo with a Docker Compose setup that reproduces the failure, so readers can break it and fix it. Strongest for trust and links, but real work per post, so only for the best posts.
- **Interactive diagrams:** a tiny script that lets a reader switch something on or off, such as sticky sessions or an expiring hot cache key, and watch the failure happen.
- **"Tested on" line:** for example "Checked with Java 21 and PostgreSQL 17" near the top of a post. It also shows which posts need updating when versions change.
- **Glossary page:** short definitions of terms (quorum, idempotency, backpressure), each linking to the posts that use them.
- **LinkedIn posts from the diagrams:** one diagram plus a link back. This is distribution, not code, and may be the best source of early readers.
- **More topic hub introductions:** `content/topics/<tag>.md` for tags that do not have one yet (concurrency, apis, messaging and others). See "Topic hubs" in [configuration.md](configuration.md).
- **A "Start here" page** that gives a reading order for a new reader, once there are enough posts.
