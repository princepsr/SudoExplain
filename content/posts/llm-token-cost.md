---
title: LLM token cost: why bills explode and how to cap them
date: 2026-11-14
description: Why an AI feature costs ten times the estimate, how growing history, big prompts and loops multiply tokens, and how to find and cap the spend.
tags: LLM, LLM cost
---

## The question

An AI feature goes live. The estimate was careful: a few cents per conversation. At the end of the month, the bill is ten times higher. Usage did not grow ten times, and nobody changed the code.

> We counted the questions and answers. Where did all those extra tokens come from?

The extra tokens came from text that was **sent again and again**, and from loops nobody was watching.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a conversation's cost grows quadratically with its length, with numbers for 20 and 100 turns
> 2. Three ways tokens multiply: history, big prompts and loops
> 3. How to **diagnose** where the spend goes
> 4. How to cap and reduce it, and where the fixes work against each other

## First, what one call really contains

A call is billed per input and output token, and the input is where the surprise hides. The model itself remembers nothing between calls. So for a chat to feel continuous, your code has to send the earlier conversation again with every new message. One call therefore carries:

```text
one call = system prompt
         + retrieved documents
         + the whole history so far
         + the new question        <- the only new part
```

Everything above the last line is paid for again on every call. So the bill depends less on how much users ask and more on how much you resend.

## The failure: cost grows faster than usage

**1. History is resent every turn.** Say each turn (a question and an answer) adds about 500 tokens to the history. Turn 1 sends no history. Turn 20 sends 19 earlier turns:

```text
turn k resends about 500 x (k - 1) tokens of history

history resent over 20 turns = 500 x (0 + 1 + 2 + ... + 19)
                             = 500 x 190  =  95,000
the new text itself          = 20 x 500   =  10,000

total about 105,000, versus 10,000 if nothing were resent
```

That is roughly **ten times** what you get by counting only the new text, and it is the bill from the question above. The reason is the shape of the growth. Every turn resends everything before it, so the history part grows quadratically, O(n²) in the number of turns: double the turns and that part roughly quadruples.

```diagram
type: sequence
alt: Each turn the app sends the whole earlier conversation to the model again, so turn 20 carries 19 earlier turns.
caption: Figure 1. Every call carries the whole conversation. Late turns are the expensive ones.
actors: App | Model
App -> Model: turn 1: question
App -> Model: turn 2: turn 1 + question
App -> Model: turn 3: turns 1-2 + question
note all: ... each call is bigger than the last
App -> Model: turn 20: 19 turns + question !
```

**2. A big prompt on every call.** The history is not the only thing the model forgets. It also forgets the system prompt and the retrieved chunks, so your code sends them again with every call. Say the system prompt is 3,000 tokens. Before each call, your code also searches your own documents, such as help articles, and pastes in the five best-matching passages. These passages are called chunks, and each one is 800 tokens. That is 7,000 tokens, and every call carries them, even a one-word "thanks". Images, PDFs and the descriptions of any tools you give the model add to it too.

A 20-turn chat is 20 calls, each carrying the same 7,000 tokens:

```text
fixed part over 20 turns = 7,000 x 20 = 140,000 tokens
history over 20 turns    =               95,000 tokens
```

In a chat of this length, the fixed part costs more than the history. It grows only in a straight line, so the history overtakes it only after about 29 turns.

**3. Loops and retries.** An agent works in steps. At each step the model asks for a tool, such as fetching a web page. Your code runs the tool, adds the result to the history, and calls the model again. The model remembers nothing, so that call carries everything so far, including every earlier result. An agent therefore grows its history like a chat does, only faster, because a tool result is much bigger than a chat turn.

Say an agent reads ten web pages of 5,000 tokens each, one per step. The pages add up to 50,000 tokens. But the call at step k carries the k - 1 pages read before it:

```text
5,000 x (0 + 1 + 2 + ... + 9) = 5,000 x 45 = 225,000 tokens
of earlier pages, sent again, on top of the pages themselves
```

That is 4.5 times the size of the pages. The growth is quadratic again, and nothing in the agent stops it. A bug that keeps the loop running for 100 steps would resend 5,000 x 4,950 = 24,750,000 tokens.

**Retries** are a second multiplier. When a call times out (your code gave up waiting) and you try again, the retry carries the whole prompt again, and the first call may still have been billed, depending on the provider. If every step retries 3 times, every step costs up to 4 times as much.

```diagram
type: flow
alt: An agent loop where each tool result is added to the history and the larger history is sent again at the next step.
caption: Figure 2. In a loop, every step re-sends everything so far, including big tool results.
Model asks for a tool -> Tool result added to history -> Whole history sent again -> Model asks again !
```

## How to diagnose it

**1. Log tokens and cost on every call.** Each reply says how many input and output tokens it used (the field names differ by provider). Save those numbers with labels for the feature, user, conversation and model, and work out the cost:

```pseudocode
reply = model.call(prompt)
log(feature, user, conversation, model, turnNumber,
    reply.inputTokens, reply.outputTokens,
    cost = reply.inputTokens * inPrice
         + reply.outputTokens * outPrice)
```

**2. Break the spend down.** Group the cost by feature, by user and by hour. Two views answer "where did it go" quickly: cost per feature, and the top 20 users. Using one API key per feature also helps, because the provider's dashboard may show spend per key.

**3. Plot input tokens against turn number.** The shape of the line shows the cause:

- A line that rises with every turn is resent history.
- A flat line that starts high is a big fixed prompt.
- Sudden jumps are large tool results.

**4. Look for repeats.** Watch for many identical requests, many calls from one user in a short time, or agent runs with hundreds of steps. These point to loops, bots or retries piling up.

## Fix 1: stop resending everything

Send only the last few turns, and optionally a short summary of the older ones. Keeping only the last few turns is a **sliding window**:

```pseudocode
recent  = lastTurns(conversation, 6)
summary = conversation.summaryOfOlderTurns       # updated every few turns
prompt  = systemPrompt + summary + recent + newQuestion
```

How much it saves depends on how long the chats are. I computed the input tokens with the 500 tokens per turn from above, a window of 6 turns and a 300-token summary. The cost of writing the summary is not counted:

| Turns | Full history | Window of 6 | Window + summary |
|---|---|---|---|
| 20 | 105,000 | 59,500 | 63,400 |
| 100 | 2,525,000 | 339,500 | 367,400 |

At 20 turns the window saves less than half. At 100 turns it saves about 87%, because the window turns O(n²) growth into O(n). Once the window is full, every new turn adds the same amount. The summary adds tokens to every call, so it is there to keep old facts, not to save money.

Also trim big tool results before adding them to the history, keeping only the part the next step needs.

## Fix 2: send only what the question needs

- **Retrieve fewer, better chunks.** Choose the number by testing, not by habit: cut from 5 chunks to 3, run about 50 real questions through both versions, and compare the answers (a fixed evaluation set, as in [the hallucinations post](/posts/llm-hallucinations/)). If quality holds, you save 1,600 tokens on every call (2 chunks of 800). Making retrieval find the right text is a topic of its own.
- **Do not attach documents** to a message that does not need them.
- **Keep the system prompt short.** Cut instructions that no longer earn their place.

## Fix 3: set limits everywhere

- **A maximum answer length** on every call (often called `max_tokens`, though the name differs by provider), sized to a sensible answer, because output costs more per token and long answers add up.
- A **maximum number of steps** for any agent loop, and a maximum total cost per run. Both stop an agent that keeps going and never finishes. Stopping such an agent is a topic of its own.
- **Budgets per user and per day**, counted in tokens instead of requests. A runaway client then hits its own cap instead of the company's. Rate limiting is a topic of its own.
- **Timeouts and a small, fixed number of retries**, so one failing call does not turn into twenty.
- A **spending limit and alerts** in your provider's console if it offers them, and a **kill switch** that turns the feature off at once, which you can use at 3 a.m.

A budget check looks like this:

```pseudocode
before the call:
    if user.tokensToday >= DAILY_LIMIT: refuse

after the call:
    user.tokensToday += inputTokens + outputTokens
```

**Put all of this in one place.** Logging, budgets and caps only work if every model call goes through them. Wrap the provider's client in one function, or route calls through a gateway, and let nothing call the model directly. Otherwise a single forgotten call site skips every limit above.

## Fix 4: reuse and right-size

- **Prompt caching.** Many providers charge less when a prompt starts with the same text they saw a moment ago. So put the stable content (instructions, reference material) **first**, and the changing content last. Check your provider's rules for how long a saved start lasts, how short a start can be, and what the discount is.
- **Cache whole answers** for identical questions whose answer does not depend on who is asking.
- **Route by difficulty.** Send simple tasks to a smaller, cheaper model, and use the large one only when needed.

## When the fix goes wrong

**1. Cutting the history too hard.** The model only knows what you send. If the user gave an order number in turn 2 and you send only the last 6 turns, then by turn 10 the assistant has forgotten it. It asks again, or guesses.

A summary can help, but a model writes it, so it can drop or bend a fact, and the next summary builds on the mistake. So keep the facts that must survive, such as order numbers and decisions, in a small record that you send every time. Summarize rarely, and test with questions that depend on early turns.

**2. Breaking the prompt cache.** Prompt caching (Fix 4) works only while the start of the prompt stays the same between calls. A timestamp or a user name at the top changes it every call, so the discount never applies. Keep changing content at the end.

The sliding window from Fix 1 also changes the start, because each call drops the oldest turn. So trim in steps: let the history grow to 10 turns, then cut the oldest 4 at once. The start then stays the same for several calls. The cost is a slightly longer history, between 6 and 10 turns instead of 6.

**3. Caching the wrong thing.** Saving whole answers is safe for "what are your opening hours?". ([The stale cache post](/posts/stale-caches-explained/) covers other ways caches go wrong.) It goes wrong when the answer holds one user's data. Say Ann asks "what is my balance?", and the cache key is the question text. The answer "Your balance is $120" is saved. Ben asks the same words and gets Ann's answer. No error appears.

Cache only answers that do not depend on who is asking. If you must cache personal answers, put the user's ID in the cache key.

**4. A cheaper model that costs more.** Sending simple tasks to a small model looks like a clear saving. But suppose your code tests each small-model answer, and the test fails 7 times in 10. The code retries the small model up to 2 more times, then falls back to the big one. These prices are invented: $0.004 per small call and $0.010 per big call. For 1,000 tasks:

```text
first tries:    1,000 small calls
second tries:     700 (70% failed)
third tries:      490 (70% of 700)
big model:        343 (70% of 490)

small: 2,190 calls x $0.004 = $8.76
big:     343 calls x $0.010 = $3.43
total: $12.19, versus $10.00 for big only
```

The "cheap" route costs more, and it is slower too. Even with no retries, the small model first costs $0.004 + 0.7 x $0.010 = $0.011 per task, against $0.010 for the big model alone. With these prices it only pays when the small model passes more than 40% of the time. So measure the pass rate on your own tasks, and route only the tasks where it passes.

Shorter ones:

- **One big call passes the budget.** The check runs before the call and counts after it, so one large call can still go over. Caps on prompt size and `max_tokens` limit by how much.
- **A cut-off answer.** `max_tokens` cuts the answer off, it does not make it shorter. Ask for a short answer in the prompt too.
- **Expecting caching to stop the growth.** Prompt caching lowers the price per resent token, not the number resent. The history still grows, so Fix 1 is still needed.

## Which should you use?

| Situation | Reach for |
|---|---|
| Long chats are the biggest cost | **A sliding window, trimmed in steps** (add a summary if old facts matter) |
| Every call carries thousands of tokens of context | **Retrieve less,** and shorten the system prompt |
| Agents or retries could loop | **Step limits, cost caps and a fixed number of retries** |
| One user or client could run up the bill | **Per-user token budgets** and a maximum answer length |
| Repeated static instructions | **Prompt caching,** with stable content first and the start of the prompt unchanged |
| The same questions repeat | **Cache whole answers,** only if they do not depend on who asks |
| Simple tasks on an expensive model | **Route to a smaller model,** and measure the pass rate and the total cost |
| You do not know where the money goes | **Log usage per feature, user and call** before changing anything |

If you are not sure, log the token counts first.

## The takeaway

1. The model remembers nothing, so **every call resends** the history, the system prompt and the retrieved text. You pay for all of it each time.
2. History makes cost grow **quadratically**, O(n²): double the turns and the history part roughly quadruples.
3. Loops, retries and big tool results multiply the bill without anyone noticing.
4. Diagnose by **logging tokens and cost** on every call, and plotting input tokens against turn number.
5. Fix it with **a short history, small prompts, hard limits and budgets, caching, and the right model size**. Keep alerts and a kill switch.
