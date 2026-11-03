---
title: Lost update problem: optimistic locking explained
date: 2026-11-01
description: How two people editing the same record silently overwrite each other, how to confirm it, and how version numbers and ETags turn it into a clear conflict.
tags: databases, concurrency, apis
draft: true
---

## The question

Two support agents open the same customer record. One updates the phone number and saves. The other, a minute later, fixes the name and saves. Afterwards the phone number is **back to the old one**. Nobody got an error. The first agent insists they saved it, and they did.

> Both saves succeeded. Where did the first change go?

The second save wrote back the **whole record**, including the old phone number it had loaded earlier. It overwrote a change it never knew about.

> [!SUMMARY]
> By the end you will know:
>
> 1. What a **lost update** is and why no error appears
> 2. How to **diagnose** one from your data
> 3. How **optimistic locking** (a version number) detects the clash, in SQL, JPA and HTTP
> 4. Why locking the row for the whole edit is the wrong tool

## First, a very long "check then act"

Think of two people editing a shared paper form. Each takes a photocopy, writes on it, and puts it back in the filing cabinet in place of the original. Whoever files last wins, and the other person's writing is gone. Nobody is told.

A **race condition** is a bug where the result depends on which of two actions happens first. A **check-then-act** race is one where you look at the data, decide, and then write, while someone else changes the data in between. The [race conditions post](/posts/race-condition-check-then-act/) covers the short version. This is the same race, stretched over minutes.

A person opens a form, which **reads** the record. They think and type, and then press save, which **writes** it. Between those two moments, anyone else can change the record, and nothing in the read-then-write sequence notices.

```diagram
type: sequence
alt: Agent A saves a new phone number. Agent B then saves the old phone number back together with a new name.
caption: Figure 1. B's save carries A's old phone number back in, so A's change is gone and no error appears.
actors: Agent A | Agent B | Database
Database -> Agent A: record: phone 111, Ann
Database -> Agent B: record: phone 111, Ann
Agent A -> Database: save phone 222, Ann
Agent B -> Database: save phone 111, Anna !
note Database: A's phone change is gone !
```

The default behavior is called **last write wins**. The last save replaces everything, whether or not it was based on the latest data.

## How to diagnose it

**1. Look at the history.** If you keep an audit log (a record of every change), you will see two saves whose "before" values are the same: both started from the same version.

**2. Look at the SQL your code sends.** Turn on SQL logging (in Hibernate, the `org.hibernate.SQL` logger at DEBUG). By default, Hibernate's `UPDATE` sets **every** column, even unchanged ones. That is the root cause here. Two saves from different users whose `SET` lists carry the same stale values confirm it.

**3. Check timestamps.** Two updates to the same row a short time apart, where the later one restores a value the earlier one changed, is the pattern.

**4. Ask about the symptoms.** Complaints such as "my change disappeared" or "it reverted itself", with no error anywhere, point here.

**5. Reproduce it with two browser tabs.** Open the same record in both, change different fields, save one and then the other. If the first change disappears, you have the bug.

## Fix 1: optimistic locking with a version number

"Optimistic" means: assume clashes are rare, let everyone edit freely, and **detect** a clash at save time. Add a **version** column that goes up on every change. A save must say which version it was based on:

```sql
UPDATE customers
SET phone = '222', name = 'Ann', version = version + 1
WHERE id = 7 AND version = 3;
-- rows affected: 1 -> saved
-- rows affected: 0 -> someone else saved first; the record has moved on
```

When zero rows change, you know the record is newer than the one the user edited. Tell them instead of overwriting.

```diagram
type: sequence
alt: Agent B's save names version 3, but the record is now at version 4, so the database changes zero rows and B is told to reload.
caption: Figure 2. The save says which version it started from. A stale save changes zero rows and is refused.
actors: Agent A | Agent B | Database
Agent A -> Database: save, based on version 3
Database --> Agent A: ok, now version 4
Agent B -> Database: save, based on version 3 !
Database -x Agent B: 0 rows changed: refused !
note Agent B: reload, then retry the edit
```

In JPA (the standard Java persistence API), one annotation adds the check:

```java
@Entity
public class Customer {
    @Id private Long id;
    @Version private long version;       // checked and incremented on every update
    private String name;
    private String phone;
}
```

If the version has changed, the save fails with an `OptimisticLockException` (in Spring, `ObjectOptimisticLockingFailureException`), and you turn it into a clear message. The exception is thrown when the transaction flushes, usually at commit, not necessarily inside the `save()` call. Catch it where the transaction boundary is.

The annotation is not enough on its own. The check only works if the version the user **saw** reaches the save. Send it to the browser, send it back with the edit, and compare it with the loaded entity:

```java
if (dto.version() != entity.getVersion()) {
    throw new ConflictException("Someone else changed this record");
}
```

If the save endpoint loads the entity fresh and copies the form fields onto it, the version is already current, and the protection silently does nothing.

## Fix 2: carry the version across HTTP

An API can express the same idea with standard headers. The server returns the version as an **ETag** (a label for one version of a resource). The client sends it back in `If-Match` when it saves:

```text
GET /customers/7
-> 200 OK
   ETag: "3"

PUT /customers/7
If-Match: "3"
{ "name": "Anna", "phone": "222" }
-> 412 Precondition Failed      (someone changed it; the ETag is no longer "3")
```

`412 Precondition Failed` is the standard answer when `If-Match` does not match. It tells the client to reload, show the user what changed, and let them decide. A write that arrives with no `If-Match` at all can be refused with `428 Precondition Required`.

## Fix 3: change only what was changed

Much of the damage came from sending the **entire** record. If the form updates only the changed fields, the two agents above would not have clashed at all: one changes the phone, the other the name. Use `PATCH` with only the modified fields, or update specific columns. For numbers, let the database do the arithmetic instead of reading and writing:

```sql
UPDATE products SET stock = stock - 1 WHERE id = 7 AND stock > 0;   -- not: read stock, then write stock - 1
```

Check that one row was affected, or the item was out of stock.

## Why not just lock the row?

A **pessimistic lock** (`SELECT ... FOR UPDATE`) stops other writers from changing the row while you hold it. It is right for a short operation inside one transaction. It is wrong for a human editing a form:

- People walk away mid-edit. The row stays locked for minutes or hours, or you need locks that expire.
- A transaction should not stay open across web requests, since each request is separate.
- Everyone else is blocked, even if they want to change a different field.

For anything involving a person, use optimistic locking. If you want to warn people, add a "Ann is editing" notice with an expiry as a courtesy, and keep the version check as the safety net.

## When the fix goes wrong

The first two are the ones that quietly bring the bug back.

**1. A code path that skips the version.** You add `@Version` to the entity and think the table is safe. But the check only works for writers that use it. A nightly batch job might run a plain `UPDATE customers SET phone = '333' WHERE id = 7`, with no version in it. That statement is allowed, and it leaves `version` unchanged.

Take the record at version 3, phone 111. An agent opens it. The batch job then sets the phone to 333, and the version stays 3. The agent saves a new name, based on version 3. The database sees a match and accepts the save, which carries phone 111 back in. The job's change is lost, with no error. Both halves of the rule were broken: the job ignored the check, and it did not raise the version.

So every writer must follow the rule: raise the version on every change (`version = version + 1`), and add `AND version = ...` when the change is based on data that was read earlier. Search for raw SQL and batch jobs that touch the same table.

**2. Retrying with stale data.** When a save fails with a version conflict, the easy fix is a retry: catch the exception, reload the record to get the new version, and save again.

Look at what happens. Agent A saved phone 222, so the record is at version 4. Agent B's form still holds phone 111 and the new name Anna, based on version 3. B's save fails. The retry reloads version 4, copies **all** of the form's fields onto it, and saves. The version now matches, so it succeeds, and phone 111 overwrites A's 222. The lost update is back, and the version check was the thing that let it through.

A retry is safe only if you re-apply what the user **meant to change** on the fresh data. Here that is only the name. Reload, apply the changed fields, and save. If both people changed the same field, or you cannot tell, show the user the new values and let them decide.

Shorter ones:

- **Swallowing the exception.** Catching `OptimisticLockException` and logging it, then returning success, tells the user their change saved when it did not.
- **A bad user experience.** "Error 412" with no explanation is useless. Say what happened: "Someone else changed this record. Reload to see their changes."
- **Counters updated by read-modify-write.** Optimistic locking will detect these conflicts but make busy counters fail constantly. Use an atomic `UPDATE ... SET n = n + 1` instead.
- **`PATCH` does not cover everything.** It does not help when both people edit the same field, or when a rule spans several fields, such as a start date that must be before an end date. Keep the version check as well.
- **Timestamps as versions.** A version number or a hash of the content works. A timestamp with one-second resolution can miss two quick saves.

## Which should you use?

| Situation | Reach for |
|---|---|
| People editing records through a form or an API | **Optimistic locking:** a version column, or ETag and `If-Match` |
| A short read-modify-write inside one transaction | **`SELECT ... FOR UPDATE`** or an atomic `UPDATE` |
| Counters and quantities | **Atomic arithmetic** in the `UPDATE` itself |
| Different people editing different fields | **Partial updates** (`PATCH`), so they do not clash |
| A record that is edited rarely | **Optimistic locking** still, because it is cheap |

If you are not sure, add a version column. It costs one number per row and turns a silent loss into an error you can handle.

## The takeaway

1. A **lost update** happens when two saves are based on the same old data, and the later one overwrites the earlier one with no error.
2. It is a **check-then-act race** stretched over the time a person spends on a form.
3. Diagnose it from **two saves with the same "before" value**, or reproduce it with two browser tabs.
4. Fix it with **optimistic locking**: a version number in SQL and JPA, or `ETag` with `If-Match` over HTTP, and handle the conflict clearly.
5. Do not hold database locks while a person types. Update **only changed fields**, and use **atomic arithmetic** for counters.
