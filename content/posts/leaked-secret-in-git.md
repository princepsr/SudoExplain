---
title: Leaked secret in Git: what to do in the first hour
date: 2026-11-01
description: A cloud key or password was committed to Git. Learn why deleting it is not enough, what to do first in the hour that follows, and how to prevent a repeat.
tags: security, git
draft: true
---

## The question

A developer commits a file called `.env` by mistake. It holds a cloud access key. They notice ten minutes later, delete the file and commit again. The file is gone from the project. They breathe out.

It is not over. The key is still in the old commit, and anyone who cloned in those ten minutes still has it.

> I deleted the file and pushed. Why is the key still a problem?

Because Git is a **history**, not a folder. Deleting a file adds a new commit that says "removed". Every earlier commit still contains it.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why **deleting the commit or the file** does not make a secret safe
> 2. The right order for the first hour: **rotate, check, clean, tell, learn**
> 3. How to **scan** for secrets with open-source tools and GitHub's built-in protection
> 4. The traps, such as rewriting history before rotating, or rotating without updating the services

## First, what a Git repository remembers

**Git** is the version control tool most teams use. A **commit** is a saved snapshot of the project. A **repository** (repo) is the folder plus its full history. When you **push**, you send your commits to a shared server such as GitHub. A **clone** is a complete copy of the repo, history included.

Think of a photo album where every page is a snapshot of the project. Tearing out the newest page does not remove the secret from the older pages. The analogy stops at copying: every person who cloned owns their own album, and you cannot reach into it.

A **secret** is any value that proves identity or grants access: a cloud key, a database password, an API token, a private key.

## The failure: the secret is out and cannot be called back

Once pushed, a secret may live in many places:

- Old commits in the repository, including other branches and open pull requests.
- Clones on teammates' laptops and on build servers.
- **Forks**, which are copies of a repo made on GitHub. GitHub's guide says commits remain reachable in forks.
- Cached views on the hosting site, reachable by commit hash.
- Anything that scrapes public repositories. Automated scanners that look for keys in new public commits are widely reported to find them within minutes, so assume a public leak is copied almost at once. Treat that as a safe working assumption, not an exact figure.

The conclusion: **a leaked secret is a compromised secret**. The only fix that works is to make the secret useless. Cleaning history comes later, and may not even be needed.

```diagram
type: flow
alt: A secret is committed, pushed, copied by clones and scanners, so deleting the file later does not help.
caption: Figure 1. The secret spreads at push time. Later deletion cannot reach the copies.
Secret committed -> Pushed to the server -> Cloned, forked, scraped ! -> File deleted later: copies remain !
```

## The first hour, in order

**1. Revoke or rotate the secret first.** To **rotate** is to create a new secret and disable the old one. Do this before anything else. For an AWS access key (the fake key below is AKIAIOSFODNN7EXAMPLE), you disable it, then create a replacement (an IAM user can have at most two access keys, so delete an unused one first):

```bash
aws iam update-access-key --user-name build-bot \
  --access-key-id AKIAIOSFODNN7EXAMPLE --status Inactive
aws iam create-access-key --user-name build-bot
```

Setting `Inactive` stops the key from working but keeps it for the audit trail. Delete it later with `aws iam delete-access-key`. For a password or token, use the provider's reset or revoke page.

GitHub's own guide says that once a secret can no longer be used, rewriting history may not be necessary.

**2. Check what it was used for.** Rotation stops future use, not past use. Open the provider's audit log and look for actions made with that key. In AWS, CloudTrail records API calls. The command line can search management events from the last 90 days, for one Region at a time, so repeat it with `--region` for each Region you use:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=AKIAIOSFODNN7EXAMPLE
```

Look for calls you do not recognize: new users, new keys, big compute launches, data downloads. If you find any, treat it as a security incident and involve your security team. For database passwords, read the database's connection and query logs.

**3. Only then, clean the history.** The aim is hygiene: remove the secret from the repo so it is not copied further. GitHub's current guide recommends the `git-filter-repo` tool and gives this shape of command (replace the path):

```bash
git filter-repo --sensitive-data-removal --invert-paths --path config/secrets.env
```

`--invert-paths` with `--path` removes that file from every commit. The `--sensitive-data-removal` flag needs git-filter-repo 2.47 or newer. After that you re-add the `origin` remote, which git-filter-repo removes, and force-push the rewritten history with `git push --force --mirror origin`. Follow GitHub's guide for the exact steps, because some references, such as pull request refs, are read-only and need GitHub Support.

> [!WARNING]
> Rewriting history is destructive. It changes every commit ID after the first changed one, and anyone with an older clone can bring the secret back by pushing it. Make a backup first, announce the rewrite, and coordinate with the whole team before you force-push.

**4. Tell people to re-clone.** Old clones still hold the secret and can reintroduce it. GitHub's guide says collaborators should discard old clones and re-clone, and rebase work rather than merge it.

**5. Find out how it got there.** Was `.env` missing from `.gitignore`? Did someone paste a key into a config file for a quick test? Fix the cause, or it will happen again.

## How to diagnose it

**Scan the history, not only the latest files.** Open-source scanners search every commit. Gitleaks and TruffleHog are two common ones:

```bash
gitleaks git -v
trufflehog git file://. --results=verified,unknown
```

Gitleaks prints each finding with the commit and file. TruffleHog can also try to check whether a found credential is still valid (the `verified` result), which helps you rank the urgent ones. Command names change between versions, so run `--help` on yours.

**Use the host's protection.** GitHub **secret scanning** looks for known secret formats in repositories. **Push protection** blocks a push that contains one before it lands. GitHub's documentation says push protection for users is on by default for public repositories, while repository-level push protection is off by default and must be enabled. A person can bypass a block by giving a reason, so treat bypasses as events to review. Bypass alerts appear only when push protection is also enabled for the repository.

## Prevention

- **Keep secrets out of code.** Use a secret manager (a service that stores secrets and hands them to apps at runtime) or environment variables injected when the app starts.
- **Ignore local env files.** Add `.env` to `.gitignore` before the first commit.
- **Scan before commit.** A **pre-commit hook** is a script Git runs before each commit. Gitleaks documents a pre-commit setup. Hooks can be skipped, so also scan in CI (the automated build) and enable push protection.
- **Prefer short-lived credentials.** A token that expires in an hour is far less harmful when leaked than one that lives for years.
- **Use least privilege.** A key that can only read one bucket limits the damage.

## When the fix goes wrong

The first three of these do the most harm, so they get a little more space.

**1. Cleaning the history before rotating.** Rewriting history feels like the real fix, because the secret disappears from the repository. But the repository was never the only copy. Clones, forks and scanners hold their own, and the key still works.

Say the key leaked at 10:00 and you finish a careful clean-up at 12:00. For those two hours anyone holding the key could use it. At 12:01 they still can. The clean-up changed what new visitors see, not what the key can do. Rotate first, as in step 1, and clean afterwards for hygiene.

**2. Rotating, but not updating the services.** To rotate is to disable the old secret, and your own systems use that secret too. If you forget one, such as a nightly job or a staging server, it starts failing with "access denied", maybe at 3 a.m. The temptation is then to switch the leaked key back on.

Avoid this by listing every place that uses the secret before you start: config files, CI settings, the secret manager, other teams. If the provider lets two secrets exist at once (AWS allows two access keys per IAM user), create the new one first, deploy it everywhere, and only then disable the old one. The cost is that the leaked key works a little longer, so do it in minutes, not days. If the audit log already shows abuse, use the order in step 1: disable the old key at once and accept a short outage.

**3. Secrets in other places.** Copies also hide outside Git. A **Docker image** is built in **layers**, and each step in the Dockerfile adds one. Look at this:

```dockerfile
COPY .env /app/.env
RUN rm /app/.env
```

The second line adds a new layer that says "the file is gone". The first layer still holds it, and anyone who can pull the image can unpack that layer and read the file. Logs, build artifacts and chat messages can hold copies in the same way.

So rotate the secret, since the old one is compromised in every copy. Then rebuild the image without it, remove the old images from your registry, and pass secrets in at run time instead of baking them in. Docker's build secrets feature exists for secrets needed only during a build. Keep secret values out of log messages too.

Shorter ones:

- **A secret in a pull request branch.** An unmerged branch still stores the commit, and the pull request keeps a reference to it.
- **Believing it was private.** A private repo can become public, be cloned onto a stolen laptop, or be shared with a contractor. Rotate anyway.
- **Skipping the audit.** Cleaning the repo without reading the audit log leaves you not knowing whether anything was taken.

## Which should you use?

| Situation | Reach for |
|---|---|
| A secret was just pushed | **Rotate first**, then audit |
| Need to know where else it appears | **A history scanner** such as gitleaks or TruffleHog |
| Stop it before it happens again | **Push protection**, a pre-commit hook and CI scans |
| Remove it from the repo | **git-filter-repo**, coordinated with the team |
| Reduce the damage next time | **Short-lived, least-privilege credentials** |

If you are not sure whether to rewrite history, do not. Rotating the secret makes the leaked copy harmless, and that usually matters more than a clean history.

## The takeaway

1. Git keeps history, so **deleting a file or commit does not remove a pushed secret**. Treat it as compromised.
2. First **rotate or revoke**. Second, **audit** what the key did. Third, **clean history** if needed. Then tell people to **re-clone**, and find the **cause**.
3. **Scan history** with gitleaks or TruffleHog, and turn on **push protection**.
4. Prevent repeats: **secret managers, `.gitignore`, hooks, CI scans** and **short-lived credentials**.
5. Rewriting history is **destructive**. Coordinate it, and remember that rotation is what actually protects you.
