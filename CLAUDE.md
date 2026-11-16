# Sudo Explain: instructions for Claude

Sudo Explain is a zero-dependency Node static site (GitHub Pages, deployed on push to `main`). Read `docs/writing-guide.md` before writing or editing any post. This file holds the rules that must never be forgotten.

## Writing rules for every post

Readers are first-time readers and junior engineers. Teach slowly, in plain words. Do not just state what happens.

1. **Define every technical word where it first appears**, in the same sentence or right after it. Never use a word first and explain it later. This is the "jargon test" in `docs/writing-guide.md`. When unsure whether a word needs explaining, explain it. The author removes explanations they do not need, so too much is safer than too little.
2. **Build the concept step by step.** For each idea: what it is, a tiny picture or analogy, what happens when it goes wrong, then the fix. Do not list facts in a row.
3. **Keep it short and simple.** One idea per paragraph, short sentences, no stacked terms. The opening question is two or three sentences about one problem, with one quoted question. Do not write "obviously" or "simple".
4. **Small made-up numbers.** Label hand-written output as an example. Use real output only when you actually ran the code, and say the Java or database version.
5. Code lines under about 62 characters, with comments on their own line above the code. PostgreSQL syntax for SQL, with the database named once.
6. **"When the fix goes wrong"** keeps only pitfalls that really happen in production and that the post has not already explained. For each: what people try, a small example of what goes wrong, then "What to do instead". If the fix is obvious from the problem, leave out "What to do instead". Merge or drop small pitfalls.
7. **Do not repeat an explanation that another published post already gives.** Link to that post instead. If two posts are close in topic (for example a connection pool and a thread pool queue), say in one line how they differ and link both ways.
8. **Verify claims.** Run code examples and use the real output. Check library and database behaviour against official docs. Say plainly what you could not verify. Never invent a result.

## Publishing rules

- To prepare a draft for publishing: remove `draft: true`, set `date` to today, update its row in `docs/post-roadmap.md`, make the share card, and replace its pending links.
- **Always run these two reading passes on a draft before saying it is ready.** Do not wait to be asked, and do not run them on posts that are already published.
  1. **The jargon test.** Read the post as someone who started programming last month. Go through it in order and list every word they might have to search for. A word used before its explanation counts, so move the definition to the first use. For each word: define it in the same sentence, replace it with a plainer word, or cut it. Include terms in diagrams, tables and headings, and error names such as `OutOfMemoryError`.
  2. **The slow-teaching pass.** The first section that introduces the concept must teach it step by step: why it exists, what the main pieces are, what happens in the normal case, then the catch. A section that only states facts in a row needs rewriting.
  Then tell the author which words you defined, replaced or cut, so they can remove any they do not need.
- A published post must never link to a draft. Use plain text and add a row to `docs/pending-links.md`. When a draft is published, turn its pending rows into links and add the inbound links the new post should receive.
- Every published post links to one or two related published posts and receives at least one link back.
- Title: starts with the phrase people search, at most 60 characters. Description: one sentence under 160 characters. Tags: reuse existing ones. A topic page appears only when `content/topics/<tag>.md` exists and two posts with that tag are published, so check this after a push.
- Every published post needs a share card: `node og-images.mjs`. It takes a few minutes, so run it in the background. It can print `FAILED` for a card that was written fine, so look at the image.
- When you add a diagram, number the figures again so they run 1, 2, 3 in order.
- Run `node build.mjs --check` and `node build.mjs` before saying a post is ready.
- Do not commit or push until the author says so. End commit messages with the `Co-Authored-By` line the session gives. Push posts that link to each other in one commit.
- After a push, check the live page with a script (use `node` and `fetch`, because `curl` is blocked by a hook): title, canonical, `og:image`, sitemap, `llms.txt`, back-links and the topic page.

## How we work

- The author reviews the content, then asks for simplifications one section at a time. Do all the preparation first, then report what changed, what you verified and what you did not.
- Content files may use Windows line endings. Edit scripts must keep them.
- Java 21 is installed, so run Java examples for real.
- **Files for readers.** When a post uses a demo program, thread dump, output or sample file, put it in `static/code/<post-slug>/` and link it from the post as `/code/<post-slug>/<file>`. The build copies `static/` to the site root, so readers download it from the same blog. Do not leave such files in `docs/`.
- **Track every draft.** The author wants all drafts and their working files (demo programs, thread dumps, outputs) on GitHub so nothing is lost. When committing, add new draft posts and their demo files too, not only the post being published. The repo is public, so first scan the new files for names, company details, emails, paths, passwords and tokens.
