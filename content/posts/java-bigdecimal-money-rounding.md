---
title: Floating point and money in Java: BigDecimal rounding
date: 2026-11-01
description: Why doubles cannot hold money, how invoices end up one cent off between systems, and how to store and round amounts correctly in Java.
tags: java, money, debugging
draft: true
---

## The doubt

Finance reports that an invoice total is **one cent** different from what the ledger says. The ledger is the official book of record. Not often, and never by more. The totals on two screens disagree, a refund leaves a stray cent behind, and a reconciliation report, which matches one system's numbers against another's, never quite balances. Nobody can point to a line of code that is wrong.

> It is only ever one cent. Where does a cent come from?

It comes from the way computers store decimals, and from where rounding happens. Both are easy to get wrong in a way that looks fine for months.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why `double` cannot store money exactly
> 2. The second cause: rounding each line versus rounding the total
> 3. How to **diagnose** a cent-level mismatch
> 4. How to store, calculate and round money correctly, and where `BigDecimal` still bites

## First, why a double is the wrong tool

A `double` stores a number in **binary**. Just as one third cannot be written exactly in decimal (0.3333...), many everyday decimal fractions cannot be written exactly in binary. 0.1 is one of them. The computer stores the nearest value it can, which is very slightly off:

```java
System.out.println(0.1 + 0.2);        // 0.30000000000000004

double total = 0;
for (int i = 0; i < 10; i++) total += 0.1;
System.out.println(total);            // 0.9999999999999999, not 1.0
```

You can see the true stored value if you ask for it:

```java
System.out.println(new BigDecimal(0.1));
// 0.1000000000000000055511151231257827021181583404541015625
```

The errors are tiny, around the seventeenth digit. For physics that is nothing. For money, they matter because people compare, add up and round money, and `==` on two such values can be false for amounts that look equal.

## Failure 1: the double in the middle

The most common version is a `double` somewhere in the chain. A price is stored as `FLOAT` in the database, or parsed by a JSON library as a double, or computed as `price * quantity * 1.05`. Each step adds a tiny error, and a rounding step later can turn one into a visible cent.

Here is a classic case. The value 1.005 is stored as slightly less than 1.005, so rounding it to two decimals goes the wrong way:

```java
System.out.println(Math.round(1.005 * 100) / 100.0);   // 1.0, not 1.01
```

## Failure 2: rounding in different places

Even with exact arithmetic, **where you round** changes the answer. Take three lines of 10 cents each, with a 5% tax, rounded half up to the cent:

```diagram
type: flow
alt: The screen rounds each of three lines and gets 0.33, while the ledger rounds the total and gets 0.32.
caption: Figure 1. Same invoice, two rounding rules, one cent apart.
Screen rounds per line: 3 x 0.11 = 0.33 -> Ledger rounds the total: 0.32 -> Reports disagree by one cent !
```

Each line is 0.10 x 1.05 = 0.105, which rounds to 0.11. The total is 0.30 x 1.05 = 0.315, which rounds to 0.32. The mode matters too: with half even, the same lines give 0.10 each.

The same invoice gives 0.33 or 0.32, depending on the order. If the invoice screen rounds per line, and the ledger rounds the total, they are off by one cent. Neither side has a bug. They simply follow different rules, and no one wrote the rule down.

## How to diagnose it

**1. Find the shape of the mismatch.** A difference that is always a cent or two, and only on certain amounts, points at rounding or precision, not at a missing record.

**2. Search for `float` and `double` anywhere money appears.** In Java classes, in database columns (`FLOAT`, `DOUBLE PRECISION`, even `REAL`), in DTOs (plain objects that carry data between layers), and in JSON. JavaScript numbers are all doubles, so a browser or a Node service that parses money from JSON may already have damaged it.

**3. Compare how two systems round.** Take one disputed invoice. Calculate it by hand both ways (per line, per total) and with each rounding mode. Usually one of them reproduces the other system's number exactly, and that shows where the rule differs.

## Fix 1: use exact decimals

Use `BigDecimal`, which stores decimal digits exactly. Build it from a **String**, never from a `double`:

```java
BigDecimal price = new BigDecimal("0.10");       // exact
// new BigDecimal(0.10) would copy the double's error, so do not do that
```

If you are handed a `double` you cannot avoid, `BigDecimal.valueOf(double)` is the safer conversion, because it goes through the number's printed form.

An alternative is to keep money as a whole number of the smallest unit, called **minor units**, such as cents in a `long`. Addition on integers is exact. Applying a tax rate or dividing still needs a rounding rule.

In the database, use `DECIMAL`/`NUMERIC` (for example `DECIMAL(19, 4)`), never `FLOAT`.

## Fix 2: choose one rounding rule, once

Decide, and write down, three things: **where** rounding happens (per line or per total), **to how many digits**, and **which rounding mode**:

```java
BigDecimal tax = price.multiply(new BigDecimal("0.05"))
                      .setScale(2, RoundingMode.HALF_UP);
```

The **scale** of a `BigDecimal` is the number of digits after the decimal point, so `setScale(2, ...)` keeps two.

`HALF_UP` rounds 0.125 to 0.13, which is what most people expect. It rounds exact halves away from zero, so -0.125 becomes -0.13. That matters for refunds. `HALF_EVEN`, called banker's rounding, rounds an exact half to the nearest even digit, so errors tend to cancel out across many calculations. Some systems require it. Either is fine. Using **both**, in different parts of the system, is the bug.

Put the rule in **one place**, a single `Money` helper, and have the screen, the API and the ledger all call it.

## Fix 3: move money around safely

When money crosses a boundary, use a form that cannot lose precision:

- In JSON, send amounts as **strings** (`"12.50"`) or as integers in minor units (`1250`), not as numbers.
- Always send the **currency** with the amount.
- In the database, store an exact decimal or integer, and the currency code beside it.

## When the fix goes wrong

- **`BigDecimal.equals` and scale.** `new BigDecimal("2.0").equals(new BigDecimal("2.00"))` is **false**, because the two have different scales. Use `compareTo(...) == 0` to compare values. The same applies to using `BigDecimal` as a `HashMap` key.
- **Division.** `BigDecimal.ONE.divide(new BigDecimal(3))` throws `ArithmeticException: Non-terminating decimal expansion`. Give `divide` a scale and a rounding mode: `divide(new BigDecimal(3), 2, RoundingMode.HALF_UP)`.
- **Splitting an amount.** Splitting 100.00 three ways gives 33.33 + 33.33 + 33.33 = 99.99. Compute the shares, then give the leftover cent to the first share instead of rounding each one.
- **A `double` sneaking back in.** Calling `.doubleValue()` for a quick calculation, or reading a column through a `double`, undoes everything.
- **Cents are not universal.** Japanese yen has no minor unit, and Kuwaiti dinar has three decimal places. A `long` of cents is wrong for them. Ask the currency with `Currency.getInstance("JPY").getDefaultFractionDigits()`.
- **Rounding hidden values.** Do not round intermediate values that are never shown or stored, because the errors add up. Round exactly at the points your written rule names, such as each invoice line, and nowhere else.

## Which should you use?

| Situation | Reach for |
|---|---|
| Amounts in Java code | **`BigDecimal`** built from strings, with an explicit scale and rounding mode |
| Storing amounts | **`DECIMAL`/`NUMERIC`,** or integer minor units. Never `FLOAT` |
| Sending amounts over JSON | **Strings or minor-unit integers,** plus the currency |
| Invoices and ledgers must always agree | **One shared rounding rule,** in one helper |
| Heavy financial math | **A money library** such as Joda-Money, which handles currencies and rounding for you |

If you are not sure, find every place that rounds money and check that they all agree. Mismatched rounding is a very common cause of cent-level bugs.

## The takeaway

1. A **`double` cannot store most decimal amounts exactly**, so it is the wrong type for money.
2. Mismatched totals often come from **rounding in different places**, not from bad arithmetic.
3. Diagnose by searching for `float`/`double` in money paths and by comparing how two systems round.
4. Store money as `BigDecimal` made **from strings**, or as integer minor units, with a `DECIMAL` column in the database.
5. Pick **one rounding rule, in one place**. Compare `BigDecimal` with `compareTo`, and send money as strings or integers.
