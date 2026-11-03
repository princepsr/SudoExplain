---
title: Time zones in Java: why dates are off by one day
date: 2026-11-01
description: Why birthdays shift a day and daily reports miss late orders, the difference between an instant and a calendar date, and how to handle time zones in Java.
tags: java, dates
draft: true
---

## The question

A user in India enters their birthday as 15 May. Another screen shows 14 May. A "today's orders" report misses everything placed after midnight local time. Everything works on your laptop and in the test environment, and the bug only appears for certain users, or only at certain hours.

> The date is saved correctly. Why does it show a different day?

Because a point in time and a date on the calendar are different things, and code that treats them as the same breaks as soon as users live in more than one place.

Think of a phone call at noon in London. It is already evening in Delhi, so "which day is it?" only makes sense once you say where you are standing.

> [!SUMMARY]
> By the end you will know:
>
> 1. The difference between an **instant**, a **local date-time** and a **date**
> 2. Four classic shapes of the off-by-one-day bug
> 3. How to **diagnose** it by changing the time zone
> 4. How to store, calculate and display times safely in Java

## First, three different ideas

- An **instant** is one exact moment on the global timeline, such as `2026-03-01T19:00:00Z`. The `Z` means UTC, the world's reference time. Everyone on Earth agrees on this moment. In Java, it is `Instant`. Computer people also call it a **timestamp**.
- A **local date-time** is what a wall clock shows, such as `2026-03-02 00:30`, with **no** zone. It does not say which moment it means. In Java, it is `LocalDateTime`.
- A **date** is a calendar day, such as 15 May 1990, with no time and no zone. In Java, it is `LocalDate`.

A time zone is described by its **offset**: how many hours it is ahead of or behind UTC. India is `+05:30`, which is five and a half hours ahead.

The same instant is a **different date** in different places. When it is 19:00 in London, it is already 00:30 **the next day** in India. So "what day is it?" has no answer until you say where:

```java
ZoneId india = ZoneId.of("Asia/Kolkata");
Instant placed = Instant.parse("2026-03-01T19:00:00Z");

System.out.println(placed.atZone(india).toLocalDate());            // 2026-03-02
System.out.println(placed.atZone(ZoneOffset.UTC).toLocalDate());   // 2026-03-01
```

## The failures

**1. "Today" computed on the server.** A server in UTC groups orders by its own calendar. An order placed at 00:30 on 2 March in India is stored as 19:00 UTC on 1 March, so the 2 March report misses it, and the 1 March report includes it.

```diagram
type: flow
alt: An order placed just after midnight in India is stored as the previous day in UTC, so the local daily report misses it.
caption: Figure 1. The server's day is not the customer's day.
Order at 00:30, 2 Mar in India -> Stored as 19:00 UTC, 1 Mar -> Server groups by UTC day -> Missing from the 2 Mar report !
```

**2. A date stored as a timestamp.** A birthday is a date, but the code stores it as midnight and sends it as a timestamp. Take a user in India who picks 15 May. Midnight there is 18:30 UTC on 14 May. A server in UTC that reads that back as a date shows **14 May**.

The same thing happens in reverse for the US. The value `1990-05-15T00:00:00Z` is midnight UTC, which is 20:00 on **14 May** in New York. A browser there shows the day before. This is the classic birthday bug.

```diagram
type: flow
alt: A birthday picked as 15 May in India is sent as an instant, read back in UTC, and shown as 14 May.
caption: Figure 2. Turning a date into a moment shifts it.
Birthday 15 May, midnight in India -> Sent as 14 May 18:30 UTC -> Read back as a UTC date -> Shows 14 May !
```

**3. The server's default time zone.** `LocalDateTime` has no zone, and old classes such as `Calendar` and `SimpleDateFormat`, and `Date.toString()`, quietly use the JVM's default zone (the zone the Java process picks up from its machine). Your laptop is in one zone, the server in another, so the same code means different moments in each.

**4. Daylight saving time.** "Add one day" and "add 24 hours" are not the same on a day when the clocks change:

```java
ZonedDateTime t = ZonedDateTime.of(2026, 3, 8, 1, 30, 0, 0, ZoneId.of("America/New_York"));
System.out.println(t.plusDays(1));    // 2026-03-09T01:30-04:00[America/New_York]  (same wall-clock time)
System.out.println(t.plusHours(24));  // 2026-03-09T02:30-04:00[America/New_York]  (24 hours later; clocks moved)
```

So `plusDays(1)` here is really only 23 hours of elapsed time. A job scheduled for 02:30 on that day has a bigger problem: in New York, 02:30 **does not exist** on 8 March, because the clock jumps from 02:00 to 03:00. In autumn, 01:30 happens **twice**. Java shifts a missing time forward, and for a repeated time it picks the earlier of the two.

## How to diagnose it

**1. Change the zone and see.** The fastest test is to run the code in another zone:

```bash
java -Duser.timezone=America/Los_Angeles -jar app.jar
```

If results change, something depends on the default zone. Run the test suite under a few zones: Asia/Kolkata (a half-hour offset), Pacific/Kiritimati (+14) and Pacific/Pago_Pago (-11), plus one that has daylight saving. The last two sit on opposite sides of the date line.

**2. Find where the conversion happens.** Trace one wrong value from the database to the screen. Look for the place where an instant becomes a date, or a date becomes a timestamp. Quiet conversions hide in the database driver or ORM (the layer that maps objects to tables) time zone setting, in the database session's zone, and in how your JSON library writes dates.

**3. Check the database column type.** In PostgreSQL, `timestamp` has no zone, and `timestamptz` stores an instant (in UTC) and converts it on output. Storing real moments in a plain `timestamp` loses the zone.

**4. Compare around midnight.** Test with values a few minutes before and after midnight in the **user's** zone, not yours.

## Fix 1: store instants in UTC

Record when something happened as an **instant**: `Instant` in Java, `timestamptz` in the database, and an ISO-8601 string with an offset in APIs (`2026-03-01T19:00:00Z`). ISO-8601 is the standard international format for dates and times. An instant is unambiguous, sorts correctly and needs no zone to interpret.

## Fix 2: keep real dates as dates

Things that are calendar days, such as birthdays, invoice dates and holidays, should be `LocalDate` in Java and `date` in the database, and sent as `"1990-05-15"`. They have no time, so no zone can shift them.

## Fix 3: convert to the user's zone only at the edge

Do calculations in UTC, and convert for the **user** only when you show something. When you need "today" for a user, use that user's zone, then convert the day's boundaries back to instants:

```java
ZoneId userZone = ZoneId.of("Asia/Kolkata");
LocalDate today = LocalDate.now(userZone);

Instant start = today.atStartOfDay(userZone).toInstant();
Instant end   = today.plusDays(1).atStartOfDay(userZone).toInstant();
// query: WHERE placed_at >= start AND placed_at < end
```

Store the user's zone as a **name** such as `Asia/Kolkata`, never as a fixed offset like `+05:30`. A name knows about daylight saving changes. An offset does not.

## Fix 4: make "now" testable

Do not call `LocalDate.now()` deep inside business code. Pass in a `java.time.Clock` instead, and use `Clock.fixed(...)` in tests. Then a test can pin the exact instant and the zone, and reproduce a midnight bug on demand.

## When the fix goes wrong

Fix 1 says to store moments as instants in UTC. That is right for moments that already happened, but two traps follow from using it too widely.

**1. Using UTC for future events.** A meeting that has not happened yet is not a past moment. It is a promise about a wall clock: "9 a.m. on that day, where the people are". Converting it to UTC today turns the promise into a fixed moment, and that is where it breaks.

Imagine a meeting booked for 9:00 next July, in a country that is UTC+2 in summer. You convert it now and store `07:00 UTC`. Later the government scraps summer time, so the country stays at UTC+1 all year. Your stored `07:00 UTC` now shows as 08:00 on the screen, while everyone still turns up at 9:00. The rule changed, but your stored value did not.

Rules like these do change. Governments edit daylight-saving dates and offsets, and the time zone database that Java uses is updated for that reason. So store the **local date-time plus the zone name**, such as `2027-07-15T09:00` and `Europe/Paris`. Work out the instant only when you need it, for example when you send the reminder. By then your zone data is as current as it can be.

**2. Parsing dates in JavaScript.** `new Date("2026-03-01")` looks like "1 March". But a string with only a date is read as **midnight UTC**, not local midnight. In New York, which is UTC-5 in early March, that moment is 19:00 on 28 February. A page that shows the local date prints 28 February, and the user sees the day before. This is the browser version of the birthday bug.

Be careful: a string that has a date **and** a time but no offset, such as `"2026-03-01T00:00:00"`, is read as **local** time. Adding a time silently changes the meaning. Do not rely on either form for a calendar date. Split the string and build the date from its parts, as in `new Date(2026, 2, 1)`, where months count from 0. Or keep it as the text `"2026-03-01"` and never turn it into a `Date`.

Smaller traps, in short:

- **`LocalDateTime` for real moments.** It has no zone, so it cannot tell you when something truly happened. Use it only for "a wall-clock time whose zone is known elsewhere".
- **Offsets instead of zone names.** `+01:00` is right in winter and wrong in summer for the same place. Store `Europe/Paris`.
- **The legacy classes.** `SimpleDateFormat` is not thread-safe, which makes it a race condition waiting for a busy server. [The race conditions post](/posts/race-condition-check-then-act/) explains the idea. `Date.toString()` also uses the default zone. Prefer `java.time` throughout.
- **JSON dates as numbers.** Some libraries write dates as numbers or arrays by default. Make them write ISO-8601 strings.
- **Relying on the server's zone.** Setting the server to UTC is a good safety net, but still pass zones explicitly in code.

A scheduled job also reads its time in some zone. [The scheduled job post](/posts/scheduled-job-runs-multiple-times/) shows where that bites.

## Which should you use?

| What you are storing | Reach for |
|---|---|
| When something happened (order placed, login) | **`Instant`,** `timestamptz`, ISO string with `Z` |
| A calendar day (birthday, invoice date) | **`LocalDate`,** `date`, `"1990-05-15"` |
| A future appointment at a local time | **Local date-time + zone name** |
| A user's preference | **Zone name** like `Asia/Kolkata`, not an offset |
| "Today" for a user | **`LocalDate.now(userZone)`** and boundaries converted to instants |

If you are not sure, ask: "Is this a moment, or a day on the calendar?" A moment is an `Instant`. A day is a `LocalDate`. Mixing them up is the cause of most bugs here.

## The takeaway

1. An **instant** is one global moment. A **date** is a calendar day. They are not interchangeable.
2. The same instant falls on **different dates** in different zones, so "today" needs a zone.
3. Typical bugs: server-side "today", dates stored as timestamps, the **default zone**, and **daylight saving**.
4. Diagnose by running with a **different time zone** and testing around midnight.
5. Store **instants in UTC**, keep real dates as `LocalDate`, store zone **names**, and convert only when displaying.
