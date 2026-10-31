# How to write a post

This guide takes you from an empty folder to a published post, and then shows how to explain things so a complete beginner can follow. It assumes nothing. Every command and every new word is explained where it first appears.

It has two parts:

1. **The mechanics.** How to create, preview and publish a post. About ten minutes to learn.
2. **The craft.** How to structure and word a post so beginners understand it. This is the part that makes the blog good.

The [sessions post](../content/posts/sessions-jwt-and-load-balancers.md) is the worked example throughout. Open it next to this guide.

## What you need

- This project, on your computer.
- **Node.js**, the program that builds the site. Check it is installed by typing `node --version` in a terminal.
- A text editor. Any one will do.
- A **terminal**: the text window where you type commands. In the Claude desktop app and in most editors there is one built in.

## Part 1: The mechanics

### Step 1: Create a draft

A post is a text file written in **Markdown**, which is plain text with a few symbols for formatting (for example `##` before a heading). It lives in the folder `content/posts/`. The site builder turns each file into a web page.

Create a new post with one command. Replace the title with yours:

```bash
cd C:\Users\PrinceSingh\Sciforma\SudoExplain
node new-post.mjs "How DNS works"
```

This creates `content/posts/how-dns-works.md`, filled in from the template at [post-template.md](post-template.md). Three things to know:

- The **file name becomes the web address**: `how-dns-works.md` is published at `/posts/how-dns-works/`.
- The post starts as a **draft**, so it cannot be published by accident.
- If a post with that name already exists, the command stops and tells you.

You can also create the file by hand. Use lowercase letters, digits and hyphens only, with no spaces, and end the name with `.md`.

### Step 2: Fill in the top block

Every post starts with a block between two `---` lines. It is called **front matter**: information about the post that readers do not see as text.

```markdown
---
title: How DNS works
date: 2026-11-05
description: How a name like example.com becomes an address your computer can reach.
tags: networking, web
draft: true
---
```

| Field | What to write |
|---|---|
| `title` | Plain and specific, ideally under 60 characters so search results do not cut it off |
| `date` | The publish date, as `YYYY-MM-DD` |
| `description` | One sentence under 160 characters saying what the reader will understand. It appears in lists and in search results |
| `tags` | Two to four topics, separated by commas. Look at the Topics page and reuse existing tags, because related posts are matched by tag. Write plain words in lowercase (`networking`, `system-design`) and the site capitalises them for you. Write acronyms in capitals (`AI`, `JWT`), because `ai` would be shown as "Ai" |
| `draft` | Leave `true` while writing. Delete the line when you are ready to publish |

There are a few more optional fields, such as `updated`. They are listed in [writing.md](writing.md).

### Step 3: Preview while you write

Start the preview:

```bash
node build.mjs --serve
```

Open http://localhost:4000/posts/how-dns-works/ in your browser. Drafts are visible in the preview. Each time you save the file, the site rebuilds. Refresh the browser to see the change. Stop the preview with `Ctrl+C`.

While the preview runs, the terminal also prints **writing checks** after every rebuild. They are suggestions, not errors. Step 5 explains them.

### Step 4: Write in Markdown

You only need these symbols. The full list is in [writing.md](writing.md).

| You want | You type |
|---|---|
| A section heading | `## Heading` on its own line |
| **Bold** and *italic* | `**bold**` and `*italic*` |
| A link | `[the words](https://example.com)` |
| A bulleted list | Lines starting with `- ` |
| A numbered list | Lines starting with `1. `, `2. `, ... |
| `Code` inside a sentence | Put it between single backticks |
| A block of code | Three backticks, the language name, the code, then three backticks again |
| A quote | A line starting with `> ` |
| A highlighted box | `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]` or `> [!SUMMARY]`, then the text on the next `> ` lines |
| A table | Rows written with `\|` between columns, and a `\|---\|---\|` line under the header |

Leave a blank line between paragraphs, lists and blocks, or they will run together.

### Step 5: Run the writing checks

```bash
node build.mjs --check
```

This builds the site including drafts and then reviews every post. It never fails the build. It points at things that make text harder for a newcomer:

| Suggestion | Why it matters | What to do |
|---|---|---|
| Sentences over 35 words | Readers lose the start of the sentence by the time they reach the end | Split into two or three sentences |
| Average sentence over 22 words | The whole post feels heavy | Use shorter sentences and plainer words |
| Paragraph over 110 words | A wall of text is tiring | Split it, or turn part of it into a list |
| Missing or long description | Search results show a blank or a cut-off line | Write one sentence under 160 characters |
| Title over 60 characters | Search results cut it off | Shorten it |
| No tags | Related posts and topic pages cannot find it | Add two to four tags |
| Code block without a language | No colouring | Add `java`, `bash`, `pseudocode` or `text` |
| Image without alt text | Screen readers say nothing | Describe the image between the `[ ]` |
| Empty section | A heading followed straight by another heading | Fill it in or delete the heading |
| Long post with no summary box | Skimmers cannot tell what is inside | Add a `[!SUMMARY]` box at the top |
| Template text still present | Text like `[First thing...]` is still there | Replace it with your own words |

Aim for `ok` on your post. The checks cannot judge whether your explanation is clear. For that, use Part 2.

### Step 6: Publish

1. Delete the line `draft: true` from the front matter.
2. Run `node build.mjs --check` one last time.
3. Save your work and send it to GitHub:

```bash
git add -A
git commit -m "docs: add post about DNS"
git push
```

A **commit** saves a labelled snapshot of your changes. A **push** sends your saved snapshots to GitHub. When the push arrives, GitHub builds the site and publishes it, which takes about a minute. Watch it in the **Actions** tab of the repository. When the run turns green, the post is live.

This repository commits as your personal account, set up for this repo only, so you do not need to change any identity settings.

### Step 7: Fix mistakes after publishing

Edit the file, add `updated: 2026-11-12` (the date of the fix) to the front matter, then commit and push as above. Readers will see "Updated" next to the date, and the address stays the same.

### Changing a post's address

If the post changes so much that its title no longer matches its address, rename the file to match, then list the old name under `aliases` in the front matter:

```markdown
---
title: Sessions, JWTs and load balancers explained
aliases: sessions-vs-jwt
---
```

The old address then forwards to the new one, so links people already shared keep working, including links to a section such as `#fix-2-a-shared-session-store`. Do the rename before the post is widely shared if you can, because search engines take a little while to follow the move.

## Part 2: How to explain so a beginner understands

### The one idea

**Write for the person you were before you understood it.** Once you know a topic, you cannot easily remember what it was like not to. Words that feel obvious to you are not obvious to a newcomer. Almost every unclear post comes from skipping a step that felt too small to mention.

### The shape of a post

Every post follows the same shape. The sessions post is shown on the right as an example.

| Section | The question it answers | In the sessions post |
|---|---|---|
| **The doubt** | What confused me, and why does the reader care? | "How can an app with sessions run on several servers?" |
| **The promise** | What will they understand by the end? | The "In this post" summary box |
| **The basics** | What words do they need first? | What HTTP, cookies, sessions and JWTs are |
| **The problem** | What goes wrong, shown on a small case? | Session lost when a second server appears |
| **How to diagnose it** | How do they confirm it is this problem? | The `curl` loop and what its output means |
| **The fixes** | What can they do, and what does each cost? | Sticky sessions, shared store, JWT |
| **The decision** | Which one should they pick? | The "Which should you use?" table |
| **The takeaway** | What is the one thing to remember? | Five numbered lines |

You do not need every row for every post. A short post can be a doubt, the basics and a takeaway. Keep the order: doubt first, solution last.

### Ten habits

1. **Start from a real question.** Use the question you actually asked yourself, in your own words, as a quote. Readers share the doubt before they see the answer.
2. **Promise the outcome.** A summary box listing what they will know by the end tells readers it is worth staying.
3. **Define every word where it first appears.** Put the meaning in the same sentence or in brackets right after it: "HTTP, the set of rules browsers and servers use to exchange pages and data." Never use a word first and explain it later.
4. **Use an analogy, then say where it stops.** A session is like a coat-check ticket: a meaningless number that points to something stored elsewhere. Then add the precise meaning, so the analogy helps without misleading.
5. **Show it breaking before you fix it.** Readers only care about a solution once they have felt the problem. Show the failure on the smallest case you can, with what they would see on screen.
6. **Pseudocode for ideas, real code for facts.** Pseudocode (plain steps, no language rules) teaches the concept to everyone. Use real code only when the exact syntax is the point, such as one short Java snippet for decoding a token.
7. **One idea per paragraph, in short sentences.** Four sentences or fewer per paragraph. Aim for an average of 20 words per sentence. Prefer "use" to "utilise" and "start" to "initiate".
8. **Draw things that talk to each other.** If your explanation says "A sends to B, which asks C", draw it. Give the figure a caption that says what to notice.
9. **Be honest about trade-offs.** Every fix costs something, so say what. Write "this is simplified" when you simplify. Avoid "always" and "never" unless they are literally true.
10. **Let the reader try it.** A two-minute "See it yourself" exercise, such as looking at a real cookie in the browser tools, turns reading into understanding. Add a warning when an exercise could be risky.

### Before and after

These rewrites show the difference between writing for yourself and writing for a beginner.

| Instead of | Write |
|---|---|
| "Sessions are server-side stateful constructs." | "A session is a record the server keeps about you." |
| "Use a distributed cache for horizontal scalability." | "Keep sessions in one shared place, so any server can use them." |
| "Obviously, just configure the load balancer." | "Here is the setting, and here is what it changes." |
| "It's simple." | Delete it. Telling a reader something is simple makes them feel slow when it is not. |
| "The token is stateless." | "The server remembers nothing. The token carries everything it needs." |

### The jargon test

Before publishing, read the post once as someone who started programming last month. Every time you reach a word they might have to search for, stop and choose one of three actions:

1. **Define it** in the same sentence or just after it.
2. **Replace it** with a plainer word.
3. **Cut it**, if the post does not need it.

Technical words are fine once they are explained. The aim is that nobody has to leave the page to understand it.

### Keep examples made up

Use invented names and numbers (`user 42`, `Server A`, `example.com`) and write examples from scratch. This keeps posts free of real systems, real data and anyone's private details. It also makes examples simpler, which is better for beginners.

### Before you publish: a checklist

- [ ] The title is specific and under 60 characters
- [ ] The description is one sentence under 160 characters
- [ ] The tags are two to four, and reuse existing ones where they fit
- [ ] There is a summary box that says what the reader will know
- [ ] Every technical word is explained where it first appears
- [ ] Each section covers one idea, and each paragraph has four sentences or fewer
- [ ] Code blocks have a language, and each fits on one screen width
- [ ] Every diagram has a caption and alt text
- [ ] Any exercise has a warning if it could cause harm
- [ ] Examples use made-up names and data
- [ ] You have read the post aloud once, and fixed anything that made you stumble
- [ ] `node build.mjs --check` shows `ok`
- [ ] `draft: true` has been removed

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The preview shows nothing new | Refresh the browser. The preview rebuilds on save but does not reload by itself |
| The post is missing from the live site | The front matter still has `draft: true`, or you have not pushed |
| The build stops with an error naming your file | The `title` or `date` is missing, or the date is not `YYYY-MM-DD` |
| Text runs together | A blank line is missing between paragraphs, lists or code blocks |
| A table does not appear | The `\|---\|---\|` line under the header row is missing |
| A diagram is tiny or has to be scrolled on phones | Give it an upright version in `<div class="diagram diagram-tall">`, as described in [writing.md](writing.md) |
| Related posts look wrong | Tags are inconsistent. Use the same spelling as other posts |
