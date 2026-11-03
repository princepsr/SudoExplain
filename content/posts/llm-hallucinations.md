---
title: "LLM hallucinations: validate AI output in production"
date: 2026-11-01
description: LLM hallucinations in production: why models invent answers and how to validate AI output with grounding, schemas, fact checks and human review.
tags: LLM
draft: true
---

## The question

A shop adds an AI assistant to its support chat. A customer asks about a refund. The assistant replies, in a calm and confident tone, "Our policy allows refunds within 90 days," and offers to process one.

The real policy is 30 days. The system believed the assistant, issued the refund, and finance found out a month later. Nobody had lied. The model simply produced a sentence that sounded right.

> "The model sounded completely sure and it was completely wrong. How do I stop my system from acting on that?"

You cannot make the model never invent things. You can make sure that nothing it says reaches a customer, a database or a payment without being checked first.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why language models **invent** answers, in plain words
> 2. The ways that trusting model output breaks real systems
> 3. Layers of defense: grounding, schemas, fact checks, citations, "I don't know" and human review
> 4. How to **diagnose** and measure the problem with logs and a fixed test set

## First, why it happens

A **large language model** (LLM) is a program trained on huge amounts of text to predict which words are likely to come next. It does not look facts up. It writes the text that fits the pattern of the question and its context.

When the true answer is common in its training text, the likely text is often correct. When the question is rare, recent, or specific to your company, the model still writes something fluent. That fluent, wrong text is called a **hallucination**.

Think of a very well-read colleague who hates saying "I don't know" and always answers. They are often right, but their tone is the same when they are wrong. The analogy stops here: a person can feel unsure, but a model's confident tone is no reliable sign that it is right.

## The failure on a small case

Suppose an assistant helps support agents and can call a tool to issue refunds. The model must provide an order ID and an amount.

```diagram
type: sequence
alt: The model invents an order ID and the system issues a refund on it without checking.
caption: Figure 1. The system acted on text that nobody verified.
actors: Customer | Model | System
Customer -> Model: refund my last order
Model --> System: refund order A-9999, $50 !
note System: A-9999 was never checked
System -> Customer: refund on unchecked ID !
```

The ID `A-9999` looked plausible, so nothing stopped it. The same pattern shows up in several ways:

- A **function that does not exist.** A coding assistant calls `list.sortByKey()`, and the build fails, or worse, it passes review.
- A **policy that does not exist.** The refund example above.
- A **citation that does not exist.** A report quotes "Smith et al., 2021", which nobody wrote.
- A **database ID that does not exist**, or one that belongs to someone else.

The rule behind every fix: treat model output as **untrusted input**, just like text typed by a stranger.

## How to diagnose it

**1. Log every prompt and output.** Record the full prompt, the retrieved documents, the model's answer, the model version and a request ID. See [the correlation ID post](/posts/correlation-id-logging/). Without logs you cannot study a failure after the fact.

**2. Sample and review.** Each week, read a random sample of answers, and add every complaint. Mark each answer as correct, wrong, or unsupported by the sources.

**3. Build an evaluation set from real failures.** An **evaluation set** is a fixed list of questions with known good answers. Start with every incident you have seen, and add tricky questions: unknown order IDs, questions the documents do not cover, and policy edge cases.

**4. Re-run it on every change.** A new model version, a new prompt or a new document set can all change behavior. A fixed set tells you whether things got better or worse. This post states no failure rates because they depend on the model, the task and the data. Measure your own.

## Fix 1: ground the answer in retrieved sources

**What it is:** **grounding** means giving the model the real documents and telling it to answer only from them. The usual technique, **retrieval**, searches your documents first and pastes the best matches into the prompt.

**How it works:** the model now has the true 30-day policy in front of it, so the likely text is the correct one. See [the RAG post](/posts/rag-wrong-answers/) for how retrieval itself can fail.

**What it costs:** a search system to build and maintain, and longer prompts, which cost more. Grounding reduces invention but does not remove it.

## Fix 2: constrain the output and validate it in code

**What it is:** ask for a fixed shape, such as JSON with named fields, and check it with ordinary code before using it. A **schema** describes the allowed fields and types.

**How it works:** reject anything that is not valid. Many model APIs can enforce a schema while generating. The format is then usually guaranteed, except when the model refuses or the output is cut off at the token limit, so still parse and validate it. Even then the format is guaranteed, not the truth. A perfectly formed `{"orderId": "A-9999"}` can still be invented.

## Fix 3: check every fact against the source of truth

**What it is:** the **source of truth** is the system that really owns the data, such as your orders database. Check each ID, amount and reference against it before acting.

Here is the idea as pseudocode:

```text
result = model.answer(question, documents)
if not matches_schema(result):          reject
order = database.find(result.orderId)
if order is missing:                    reject
if result.amount > order.total:         reject
if result.citation not in documents:    reject
act(result)
```

And a runnable Node version with no libraries. It checks the shape first, then the facts:

```javascript
const orders = new Map([["A-1001", { total: 80, refundable: true }]]);
const sources = ["doc-1", "doc-2"]; // documents we actually gave the model

function validate(out) {
  const errors = [];
  if (typeof out.orderId !== "string") errors.push("orderId must be a string");
  if (!Number.isInteger(out.refundCents) || out.refundCents < 0) errors.push("refundCents must be a non-negative integer");
  if (typeof out.citation !== "string") errors.push("citation must be a string");
  if (errors.length) return errors;               // stop: shape is wrong
  const order = orders.get(out.orderId);           // facts: check the real record
  if (!order) errors.push("order " + out.orderId + " does not exist");
  else {
    if (!order.refundable) errors.push("order is not refundable");
    if (out.refundCents > order.total * 100) errors.push("refund exceeds order total");
  }
  if (!sources.includes(out.citation)) errors.push("citation " + out.citation + " was never provided");
  return errors;
}
```

Run on four sample outputs, the real output was:

```text
{"orderId":"A-1001","refundCents":5000,"citation":"doc-1"} -> ACCEPT
{"orderId":"A-9999","refundCents":5000,"citation":"doc-1"} -> REJECT: order A-9999 does not exist
{"orderId":"A-1001","refundCents":50000,"citation":"doc-7"} -> REJECT: refund exceeds order total; citation doc-7 was never provided
{"orderId":"A-1001","refundCents":"fifty","citation":"doc-1"} -> REJECT: refundCents must be a non-negative integer
```

The $80 order has a total of 8,000 cents, so 50,000 cents is rejected. Working in whole cents avoids rounding errors; see [the money rounding post](/posts/java-bigdecimal-money-rounding/).

**What it costs:** a check per action, and the checks must be maintained as rules change. It is the layer that stops the worst harm.

## Fix 4: require citations, and verify them

Ask the model to name the source for each claim. Then check in code that each cited source was in the documents you supplied, as `validate` does above. A citation to a document you never provided is a red flag. Citing a real document does not prove the document says that, so spot-check the content for important claims.

## Fix 5: allow "I don't know"

Tell the model in the prompt that "I don't know" or "not in the documents" is an acceptable answer. Add test questions with no answer and count a made-up reply as a failure. Without this, a model has no easy way out when the documents do not cover a question.

## Fix 6: keep a human in the loop for what cannot be undone

For actions you cannot reverse, such as large refunds, deleting data or sending email, have a person approve the action. Show them the exact action and the evidence, not just the model's summary. This is the last line of defense, and it costs time on every approval.

## When the fix goes wrong

These three are the ones that look like fixes but are not.

**1. Lowering the temperature.** **Temperature** is a setting that controls how random the output is. It is tempting to turn it down, because a calm model sounds like a careful one.

But a low value only makes the model pick its most likely words more often. Ask "How many days do refunds take?" ten times, and a low setting gives you nearly the same answer each time. If that answer is "90 days" and the policy says 30, you now have the same wrong answer again and again, and it looks even more trustworthy. Repeatable is not the same as true. Use grounding and fact checks (Fixes 1 and 3) for truth, and use temperature only to tune style.

**2. A second model as judge.** The idea is to ask another model "is this answer correct?" before the customer sees it. The trouble is that a judge only has the text in front of it. "Refunds are allowed within 90 days" reads fluent and sure, so a judge with no access to the policy often agrees. Two models trained on similar text can share the same blind spots.

A judge is more useful when it can compare the answer with the retrieved documents, and it can catch some errors. Treat it as one signal. The gate that decides whether money moves must be code that checks the real record, as in Fix 3.

**3. Trusting model-written code or SQL.** A model can write code that calls a function that does not exist, or a query that does too much. Suppose a user says "clean up my old test orders" and the model writes `DELETE FROM orders WHERE status = 'test'`, but some real orders also carry that status. The query is valid, so nothing complains, and the rows are gone.

Protect yourself in layers. Run generated SQL with a database account that can only read. Try generated code in a sandbox, an isolated place where a mistake cannot reach real data. For anything that writes or deletes, show the exact statement to a person first (Fix 6).

Shorter ones:

- **Validation of format only.** Valid JSON with an invented ID passes a schema check. Check the facts.
- **Letting untrusted text steer the model.** A document or web page can contain instructions that the model follows. See [the prompt injection post](/posts/prompt-injection/).
- **No evaluation set.** Without one, every change is a guess.

## Which should you use?

| Risk | Reach for |
|---|---|
| Wrong facts in answers | Grounding with retrieved sources |
| Malformed output | Schema and validation |
| Invented IDs or amounts | Check against the source of truth |
| Invented citations | Verify each citation was supplied |
| Irreversible actions | Human approval |
| "Is it getting better?" | A fixed evaluation set |

If you are not sure, start with the source-of-truth check on every action, because it limits the damage even when everything else fails.

## The takeaway

1. A model **predicts likely text**. It does not look facts up, so it can sound sure and be wrong.
2. Treat model output as **untrusted input** until code has checked it.
3. Layer the defenses: **ground** with sources, validate a **schema**, check **facts** and **citations**, allow "I don't know".
4. Keep a **human** in the loop for actions that cannot be undone.
5. **Log** everything and test on a **fixed set** built from real failures, because lower temperature and a second model do not fix this alone.
