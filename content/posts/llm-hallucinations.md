---
title: "LLM hallucinations: diagnose and fix them in production"
date: 2026-11-17
description: Why an AI assistant states wrong facts with confidence, how to find where a wrong answer came from, and the fixes production teams use.
tags: LLM, LLM hallucinations
---

## The question

A shop's AI assistant tells a customer, calmly and confidently, "Our policy allows refunds within 90 days," and issues the refund. The real policy is 30 days, and finance finds out a month later.

> The assistant sounded completely sure and was completely wrong. How do I stop my system from acting on that?

You cannot make a model never invent things. You can make sure it never has the last word on a fact or an action.

> [!SUMMARY]
> By the end you will know:
>
> 1. How an AI assistant produces an answer, and the three places where a wrong answer can come from
> 2. Real cases where a made-up answer caused real damage
> 3. How to **diagnose** which place went wrong, by reading a record of the answer
> 4. Four fixes that production teams use, and which place each one protects

## First, how an assistant answers

**The model.** An AI assistant is built on a language model, a program trained on huge amounts of text. It has one skill: given some text, it writes the words that are most likely to come next. It does not look facts up, and it has no built-in way to say "I do not know".

**What your code adds.** A company assistant is more than the model. Before the model sees a question, your code usually looks up documents that match it, such as your refund policy. This lookup is called **retrieval**. Your code then puts the question and the documents together into one block of text, the **prompt**, and sends it to the model. The model writes its answer from that prompt.

```diagram
type: flow
alt: A question goes through a document lookup, becomes a prompt with the documents, and the model writes the answer from it.
caption: Figure 1. How an assistant produces an answer.
Question -> Your code looks up documents -> Question + documents become the prompt -> Model writes the answer -> Answer reaches the user
```

**Where a wrong answer can come from.** Follow the flow in Figure 1, and a wrong answer can start in three places:

1. **The right fact never reached the prompt.** The lookup found nothing, or found an old version of the document, or the fact is in no document at all. The model has nothing true to go on, so it writes likely-sounding text. The 90-day refund policy is this kind.
2. **The right fact was in the prompt, but the answer changed it.** The document says "30 days, unopened items only", and the answer says "any item within 30 days".
3. **The answer contains something nobody gave the model.** An order ID, a function name or a citation. It has the right shape, so it looks real.

In all three cases the wrong answer looks exactly like a right one: the same tone and the same format. Nothing in the text itself tells you it is wrong.

## The failure: someone acts on it

Suppose an assistant helps support agents, and it can use a **tool**: a function your code lets the model ask for, such as "refund this order". The model must provide an order ID and an amount.

```diagram
type: sequence
alt: The model invents an order ID and the system issues a refund on it without checking.
caption: Figure 2. The system acted on text that nobody verified.
actors: Customer | Model | System
Customer -> Model: refund my last order
Model --> System: refund order A-9999, $50 !
note System: A-9999 was never checked
System -> Customer: refund on unchecked ID !
```

The ID `A-9999` looked plausible, so nothing stopped it. The same pattern has happened in real systems:

- **Air Canada, 2024.** Its chatbot told a customer he could claim a bereavement fare discount after his trip. The airline's real policy did not allow that. A Canadian tribunal (Moffatt v. Air Canada) held the airline responsible for what its chatbot said and ordered it to pay about $812.
- **A lawyer's court brief, 2023.** Two New York lawyers filed a brief with case citations from ChatGPT. Six of the cases did not exist, and the judge fined the lawyers and their firm $5,000 (Mata v. Avianca).
- **Package names, 2024.** A study of 16 code-generation models found that about 5% of the packages recommended by commercial models, and about 22% from open models, did not exist. An attacker can publish a real, malicious package under a name that models keep inventing.

## How to diagnose it

When a complaint arrives, do not start with "why did the model lie?" Start with "what did the model actually see?" Diagnosing means finding which of the three places went wrong. You can only do that if you saved what happened.

**1. Save a record of every answer.** For each answer, keep the question, the documents the lookup found (with their version numbers), the model version, any tool results, and the answer. Such a record is often called a **trace**. Keep it in a plain database table, or in a tool made for this, such as Langfuse, LangSmith or Arize Phoenix. Without it you are guessing. This is the record of a refund complaint (the values are made up):

```json
{
  "requestId": "r-1",
  "question": "Can I still get a refund?",
  "modelVersion": "model-2026-05",
  "documents": [
    { "doc": "refund-policy", "version": 3,
      "text": "Refunds are allowed within 90 days." }
  ],
  "toolResults": [],
  "answer": "Our policy allows refunds within 90 days."
}
```

**2. Read the record with three questions.** Each question points to one of the three places:

1. Is every ID in the answer also in the prompt (the documents and tool results)? An ID that only the answer contains could not have been read anywhere, so the model made it up (place 3).
2. Are the documents the newest versions? If not, the model was given an old fact (place 1).
3. Is every number in the answer also in the documents? If not, the number was a guess, because the real fact was missing (place 1).

If all three pass and the answer is still wrong, the model probably changed what the document says (place 2). Only a person, or the second-model check in step 3 (called "the checker" below), can judge that.

The first three questions are simple comparisons, so code can ask them. [Triage.java](/code/llm-hallucinations/Triage.java) does it. ("Triage" means sorting cases by their cause.) This is its main method, shortened:

```java
// the newest version of each document in the real system
static final Map<String, Integer> CURRENT =
    Map.of("refund-policy", 4);

static List<String> triage(Trace t) {
    // everything the model was shown
    String seen = textOfDocumentsAndToolResults(t);
    List<String> found = new ArrayList<>();

    // 1. IDs in the answer that the model was never shown
    Matcher id = ID.matcher(t.answer());
    while (id.find()) {
        if (!seen.contains(id.group()))
            found.add("invented ID: " + id.group());
    }
    // 2. documents that are not the newest version
    for (Document d : t.documents()) {
        int now = CURRENT.getOrDefault(d.doc(), 0);
        if (d.version() < now)
            found.add("old document: " + d.doc() + " v"
                + d.version() + ", newest is v" + now);
    }
    // 3. numbers in the answer that no document contains
    // (same idea as 1, with a number pattern)
    ...
    return found;
}
```

Run on three records with Java 21.0.2, the real output was:

```text
r-1 -> [old document: refund-policy v3, newest is v4]
r-2 -> [nothing found: send to the checker]
r-3 -> [invented ID: A-9999]
```

Here is how to read it:

- **r-1** is the record above. The model did not invent "90 days". It copied a document faithfully, and that document was version 3 of a policy that is now at version 4. Without the record, the blame would have gone to the model.
- **r-2** has the newest document, "30 days, unopened items only", and the answer says "any item within 30 days". Every number is present, so the code finds nothing. The meaning changed, and this case needs the checker.
- **r-3** says "I have refunded order A-9999", but the tool results list only A-1001 and A-1002. The ID appears nowhere the model could have read it, so the model made it up.

**3. Watch all answers, not only complaints.** Steps 1 and 2 find one case at a time. To watch everything, let a second model check a sample of real answers in the background. It gets the answer and the documents, and must say whether the documents back up each statement. Without the documents it would have nothing to check against, and would often just agree. The prompt:

```text
Documents: {documents}
Answer: {answer}

For each statement in the answer, reply SUPPORTED or
UNSUPPORTED, and quote the sentence from the documents
that backs it. Reply as JSON.
```

A statement the documents do not back up is an **unsupported claim**. Save the count for each answer, and graph the rate. This query (PostgreSQL) gives the rate per prompt version over the last week:

```sql
SELECT prompt_version,
       count(*) AS checked,
       round(avg((unsupported_claims > 0)::int), 3)
           AS unsupported_rate
FROM answer_checks
WHERE checked_at > now() - interval '7 days'
GROUP BY prompt_version
ORDER BY prompt_version;
```

Set an alert for when the rate rises.

## Fix 1: let your systems supply the facts

Give each part the job it is good at. The model understands the question and writes the reply. Your systems hold the facts, such as an order status, a balance or the refund window. So the model should not write a fact. It asks a tool, and the reply is built from what the tool returns. In the opening story, the "30 days" would come from the policy system, and the model could not "remember" 90.

When the model must choose an ID, it chooses from a list your code supplied, and code turns the choice into the real ID:

```pseudocode
orders  = ordersFor(customer)        # code supplies the choices
choice  = model.pick(question, options = orders)
orderId = orders[choice].id          # code maps it to the real ID
```

**What it costs:** a tool for each fact. Facts that live only in documents still need Fix 2.

## Fix 2: fix the documents and the lookup first

When the answer comes from documents, check what the lookup returned before you blame the model. Two common problems:

- **An old version is still searchable.** Remove old versions, and give every document a version number.
- **A rule is separated from its exception.** Documents are cut into small pieces for searching. Cut by section, so a rule and its exception stay together.

Also let the lookup decide whether to answer. Each result has a match score. If the best score is too low, do not let the model answer from memory. Reply "I do not have that" and hand the question to a person. Why a lookup itself fails is a topic of its own.

## Fix 3: check each statement against its documents

When the answer must stay close to a document, make the model show its proof. Ask it to quote, word for word, the sentence that backs each statement. Then let code check that the quote really appears in the documents. A statement without a real quote is dropped, or the answer goes to a person. Anthropic's guidance on reducing hallucinations recommends quotes for this reason.

Some services offer a ready-made version. Amazon Bedrock Guardrails has a "contextual grounding check" that scores an answer against the source text and blocks it below a score you set.

**What it costs:** extra tokens (see [the token cost post](/posts/llm-token-cost/)) and a delay on every answer, so use it where a wrong statement is expensive.

## Fix 4: put a guard in front of every action

The model proposes, and code decides. Before an action runs, code checks what the model cannot know. Does the order exist? Does it belong to this customer? Is the amount allowed?

```java
// above this amount, a person must approve
static final long AUTO_LIMIT_CENTS = 5000;

static String guard(String customerId, Request req) {
    Order order = ORDERS.get(req.orderId());
    if (order == null)
        return "reject: order does not exist";
    if (!order.customerId().equals(customerId))
        return "reject: order belongs to someone else";
    if (!order.refundable())
        return "reject: order is not refundable";
    long cents = req.refundCents();
    if (cents <= 0)
        return "reject: bad amount";
    if (cents > order.totalCents())
        return "reject: refund exceeds order total";
    if (cents > AUTO_LIMIT_CENTS)
        return "needs approval: above the automatic limit";
    return "allow";
}
```

`ORDERS` maps each order ID to the real order. [Guard.java](/code/llm-hallucinations/Guard.java) has the whole program. Run on five requests with Java 21.0.2, the real output (customer, order, amount in cents) was:

```text
c-7 A-1001 3000 -> allow
c-7 A-9999 3000 -> reject: order does not exist
c-9 A-1001 3000 -> reject: order belongs to someone else
c-7 A-1001 7000 -> needs approval: above the automatic limit
c-7 A-1001 50000 -> reject: refund exceeds order total
```

**How to guard an action.** Do this for every action the model can ask for:

1. **List what the model supplies.** For a refund, an order ID and an amount. Treat both as guesses.
2. **Write one check for each.** The order must exist and belong to this customer, and the amount must be above zero and within the order total. Each check is one `if` in the code above.
3. **Match the approval to the risk.** A small refund passes the guard alone (the $50 limit is `AUTO_LIMIT_CENTS`). Large or irreversible actions, such as a big refund, deleting data or sending email, also wait for a person. Not everything, or the assistant saves nobody any time.

Log every rejection with its reason. A jump in "order does not exist" after a prompt change is a problem you found before a customer did.

Money is kept in whole cents to avoid rounding errors. Money rounding is a topic of its own.

**What it costs:** rules to write and keep current. This is the layer that limits the harm when everything else fails.

## When the fix goes wrong

These two look like fixes but are not.

**1. Turning the temperature down.** *Temperature* is a setting that controls how random the model's word choice is. Turning it down feels safer, because a calm model sounds careful.

But a low temperature only makes the model pick its most likely words more often. Ask "How many days do refunds take?" ten times, and you get nearly the same answer each time. If that answer is "90 days" and the policy says 30, you now have the same wrong answer every time, and it looks even more trustworthy. Repeatable is not the same as true. Use Fixes 1 to 3 for truth, and use temperature only to tune style.

**2. Trusting model-written code or SQL.** A model can write code that calls a function that does not exist, or a query that does too much. Suppose a user says "clean up my old test orders" and the model writes `DELETE FROM orders WHERE status = 'test'`, but some real orders also carry that status. The query is valid, so nothing complains, and the rows are gone.

Protect yourself in layers. Run generated SQL with a database account that can only read. Try generated code in a sandbox where a mistake cannot reach real data. For anything that writes or deletes, show the exact statement to a person first (Fix 4).

Shorter ones:

- **Checking only the format.** Valid JSON with an invented ID passes a format check. Fix 4 checks the facts.
- **Letting untrusted text steer the model.** A document or web page can contain instructions that the model follows. Prompt injection is a topic of its own.

## Which should you use?

| Where it went wrong | Reach for |
|---|---|
| A fact that lives in a system (order, balance, policy value) | **Let a tool return it,** and let the model only word it (Fix 1) |
| The document was missing or out of date | **Fix the documents and the lookup,** and answer only above a minimum score (Fix 2) |
| The answer changed what the document says | **Quote and verify,** or use a managed check against the documents (Fix 3) |
| The model asks for an action | **A guard in code,** with approval by risk (Fix 4) |
| "Is it getting better?" | **The sampled check on live answers** (diagnose step 3) |

If you are not sure, start with the guard on every action (Fix 4), because it limits the damage even when everything else fails.

## The takeaway

1. A model writes the words that are most likely to come next. It does not look facts up, so it can sound sure and be wrong.
2. A wrong answer starts in one of three places: the right fact **never reached the prompt**, the answer **changed** it, or the model **made something up**.
3. Diagnose by saving a **record of every answer**, and asking it three simple questions. Then watch a sampled check for unsupported claims.
4. Let **systems supply the facts**, fix the documents and the lookup, check statements against their documents, and put a **guard in front of every action**. The model proposes, code decides.
