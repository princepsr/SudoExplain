---
title: Disk full outage: logs, inodes and log rotation
date: 2026-11-01
description: Why a full disk stops databases and apps, how logs and inodes fill it, and why deleting a log file may not free space until you restart the process.
tags: operations, linux, logging
draft: true
---

## The question

At 03:40 the app starts failing. Writes return errors, the database refuses new data, and even logging into the server is slow. The error is plain:

```text
No space left on device
```

You find a log file of 60 GB and delete it. You run `df` again. The disk is **still full**.

> I deleted the big file. Why is there no free space?

The file is gone from the directory, but a running process still holds it open. Linux frees the space only when the last holder lets go.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why logs fill disks, and the two ways a disk can be "full"
> 2. Why deleting a file a process holds open frees nothing
> 3. How to **diagnose** with `df`, `du` and `lsof`
> 4. How to prevent it with rotation, size limits, retention, separate volumes and alerts

## First, bytes and inodes

A **file system** is how a disk stores files. It tracks two limited things. One is **blocks**, the space for file contents, which we measure in bytes. The other is **inodes**, small records that describe each file: owner, size and where its blocks are. Think of a library. Shelf space is the bytes. The card catalog is the inodes. You can run out of either.

On file systems with a fixed number of inodes, such as ext4, a disk with free bytes but no free inodes still reports `No space left on device`. This happens when millions of tiny files pile up, such as one file per request, per session or per failed job.

Logs are the usual cause of full bytes. An application appends to its log forever unless something stops it. Three causes show up again and again:

- **No rotation or retention.** Nothing renames, compresses or deletes old logs.
- **Debug level left on.** A setting meant for an hour stays on for months.
- **A log loop.** A failure writes an error, and writing that error fails and writes another error.

## The failure: deleted, but still open

Linux keeps a file's data until two things are true: no name in any directory points to it, and **no process has it open**. When you `rm` a log that the application is still writing, the name vanishes. The process keeps its **file descriptor** (its handle to the open file) and keeps writing into a file no one can see.

```diagram
type: sequence
alt: An admin deletes a log file that the app has open, so the name disappears but the disk space stays used.
caption: Figure 1. The name is gone, but the app's open handle keeps every byte on disk.
actors: Admin | Directory | App | Disk
Admin -> Directory: rm app.log
Directory --> Admin: name removed
App -> Disk: keeps writing via open handle !
note Disk: space still used, df unchanged !
```

`du` adds up the files it can **see**, so its total is much smaller than the used space. `df` asks the file system, which still counts the hidden file. The two numbers disagree, and that disagreement is the clue.

## How to diagnose it

**1. See which kind of full.** `df -h` shows bytes, and `df -i` shows inodes:

```bash
df -h
df -i
```

A line with `100%` under `Use%` is the full volume. If `df -h` has room but `df -i` shows `IUse%` at 100%, you ran out of inodes, and the fix is to delete files, not to free bytes.

**2. Find where the space went.** These stay on one file system and sort by size:

```bash
sudo du -xh --max-depth=1 /var | sort -rh | head -10
sudo find /var/log -xdev -type f -size +100M -exec ls -lh {} +
```

Repeat `du` inside the largest directory until you reach the files. Output sizes here depend on your machine.

**3. Look for deleted-but-open files.** If `du` totals much less than `df` reports, list open files that no longer have a name:

```bash
sudo lsof +L1
```

`+L1` selects open files with a link count below one, meaning deleted. Look at the `SIZE/OFF` column for a large number and at the `COMMAND` and `PID` columns for the process that holds it.

**4. Check containers.** `docker system df` summarizes space used by images, containers, volumes and build cache. A container's own log file can be large too. Find its path with `docker inspect --format '{{.LogPath}}' <container>` and check its size. With Docker's default `json-file` log driver, `max-size` is unlimited unless you set it.

**5. Count the inodes per directory** when `df -i` is full. `for d in /var/*; do echo "$(sudo find "$d" -xdev | wc -l) $d"; done | sort -rn | head` shows which directory holds the most files.

## Fix 1: rotate and limit logs

**Log rotation** renames the current log, starts a new one, and removes old ones after a limit. On Linux, `logrotate` does this, usually from a daily job. A sample file in `/etc/logrotate.d/myapp`:

```text
/var/log/myapp/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        kill -HUP "$(cat /run/myapp.pid)"
    endscript
}
```

`rotate 7` keeps seven old files, and `compress` zips them. `delaycompress` postpones compression of the previous file to the next cycle. The `postrotate` script tells the app to reopen its log, which Fix 3 explains. Test a config without changing anything using `logrotate -d /etc/logrotate.d/myapp`.

For containers, set the driver's limits. In `daemon.json`:

```text
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

Docker documents that this applies only to newly created containers, and that you must restart Docker for it to apply. Option values are strings.

## Fix 2: retention, separate volumes and alerts

- **Retention.** Decide how long logs are useful, and delete older ones automatically. Seven to thirty days is common for plain files.
- **Separate volumes.** Put logs on their own volume. A log flood then fills only that volume, and the database keeps working.
- **Alerts.** Page a person at 80 percent used, both for bytes and for inodes, and again at 90. A rising line is worth an alert too, because a log loop fills a disk in minutes.

## Fix 3: lower the volume and ship logs away

Lower the log level in production, and log errors once, not on every retry. Send logs to a central system, then keep only a short local window. A log shipper is a small agent that reads files and forwards them. A shipped log cannot fill the disk if the local copy is small.

## Freeing space right now

If a process holds a deleted file, **restart or signal the process** so it closes the handle. Or truncate the file instead of deleting it. `truncate -s 0 /var/log/myapp/app.log` empties it in place, and space returns at once, even with the process still running. A process that did not open the file in append mode may leave a sparse file at its old offset, so prefer a restart for those.

> [!WARNING]
> Deleting and truncating destroy log data. Make sure you can spare it first, and copy what you need elsewhere. Never run `rm -rf` on a path you have not just listed. For a file shown by `lsof +L1`, prefer a restart of that process.

## When the fix goes wrong

Two of these look like fixes and change nothing, so they come first. The short ones follow.

**1. Deleting a file a process still holds.** The disk is full, you find a 20 GB log, and you run `rm`. You run `df` and it still says 100%. Nothing was freed.

On Linux, a file's name and its data are separate. `rm` removes the name. The data stays on the disk for as long as any process still has the file open. The app has the log open and keeps writing, so the 20 GB stays, and now you cannot see it with `ls` or `du`.

**What to do instead.** Run `sudo lsof +L1`. It lists open files that no longer have a name, and shows which process holds each. Restart that process, or ask it to reopen its logs, and the space comes back. Next time, if you must free space in an emergency without a restart, empty the file instead of deleting it, for example with `truncate -s 0 /var/log/myapp.log`. The process keeps its open file and the space is released at once. This loses the log content, so it is a rescue step, not a routine.

**2. Rotating without telling the process.** Rotation renames `app.log` to `app.log.1` and expects a new `app.log`. But the app does not look up the name on each write. It keeps writing to the file it already opened, and renaming does not change which file that is. So the app writes into `app.log.1`, the new `app.log` stays empty, and the file you meant to cap keeps growing. The rotation looks right in `ls` and the disk still fills.

**What to do instead.** Make the app reopen its log after the rename. In `logrotate`, a `postrotate` script can send the signal the app expects. If the app cannot reopen its log, use `copytruncate`, which copies the file and empties the original, so the app keeps writing to the same file. Its cost is that a few lines can be lost, as the list below says.

Smaller traps:

- **Truncating instead of deleting.** Fast, but it loses data. It is a rescue tool, not a policy.
- **`copytruncate` loses lines.** The `logrotate` manual warns that a small time slice between copying and truncating means some data might be lost.
- **A log loop.** An error handler that logs an error when logging fails can fill a disk fast. Rate-limit repeated messages.
- **Alerting only on bytes.** An inode-full disk looks healthy in a byte graph.

## Which should you use?

| Situation | Reach for |
|---|---|
| Plain log files on a server | **logrotate** with a size or age limit |
| Docker containers | **`max-size` and `max-file`** on the log driver |
| Risk to the database | **A separate volume** for logs |
| Disk already full | **Check `lsof +L1`,** then restart or truncate |
| Any production system | **Alerts at 80 percent** for bytes and inodes |

If you are not sure where to start, run `df -h` and `df -i` today on every server. The numbers show whether you are already close.

## The takeaway

1. A disk can run out of **bytes** or of **inodes**, and each needs its own check.
2. Unrotated and debug-level logs, and **log loops**, are the usual cause.
3. Deleting a file that a process holds open **frees nothing** until the process lets go.
4. Diagnose with **`df -h`, `df -i`, `du` and `lsof +L1`**.
5. Prevent it with **rotation, limits, retention, separate volumes** and an alert at 80 percent.
