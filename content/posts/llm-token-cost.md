---
title: LLM token cost: why bills explode and how to cap them
date: 2026-11-14
description: Why an AI feature costs ten times the estimate, how growing history, big prompts and loops multiply tokens, and how to find and cap the spend.
tags: LLM, cost
---

## The question

An AI feature goes live. The estimate was careful: a few cents per conversation. At the end of the month, the bill is ten times higher. Usage did not grow ten times, and nobody changed the code.

> We counted the questions and answers. Where did all those extra tokens come from?

The extra tokens came from text that was **sent again and again**, and from loops nobody was watching.

> [!SUMMARY]
> By the end you will know:
>
> 1. Why a conversation's cost grows faster than its length, with numbers for 20 and 100 turns
> 2. Three ways tokens multiply: history, big prompts and loops
> 3. How to **diagnose** where the spend goes
> 4. How to cap and reduce it, and where the fixes work against each other

## First, what one call really contains

You know a call is billed per input and output token. What decides the bill is **what goes into the input**. The model keeps no memory between calls, so your code rebuilds the whole context every time:

```text
one call = system prompt
         + retrieved documents
         + the whole history so far
         + the new question        <- the only new part
```

Everything above the last line is paid for again on every call. Output is priced separately, usually higher per token, and the context window caps the total. So the bill depends less on how much users ask and more on how much you resend.

## The failure: cost grows faster than usage

**1. History is resent every turn.** Say each turn (a question and an answer) adds about 500 tokens to the history. Turn 1 sends no history. Turn 20 sends 19 earlier turns:

```text
turn k resends about 500 x (k - 1) tokens of history

history resent over 20 turns = 500 x (0 + 1 + 2 + ... + 19)
                             = 500 x 190  =  95,000
the new text itself          = 20 x 500   =  10,000

total about 105,000, versus 10,000 if nothing were resent
```

That is roughly **ten times** the simple estimate. It is the bill from the question above. For the history part, doubling a conversation's length roughly quadruples it. A fixed prompt on every call softens this for short chats, but long chats get close to four times.

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

**2. A big prompt on every call.** Say your system prompt is 3,000 tokens, and retrieval adds five chunks of 800 tokens each. That is 7,000 tokens on every call before any history is added. Even a one-word "thanks" pays all 7,000. Images, PDFs and the descriptions of any tools you give the model count too.

**3. Loops and retries.** An agent grows its history like a chat does, only faster, because tool results are much bigger than chat turns. Say an agent reads ten web pages of 5,000 tokens each, one per step. The new text is 50,000 tokens, but call k carries the k - 1 pages read so far:

```text
5,000 x (0 + 1 + 2 + ... + 9) = 5,000 x 45 = 225,000 tokens
of earlier pages, sent again, on top of the pages themselves
```

Without a step limit, a bug can run hundreds of steps. A retry after a timeout resends the whole prompt, so a retry loop multiplies your input tokens. Check your provider's usage dashboard for what was actually billed.

```diagram
type: flow
alt: An agent loop where each tool result is added to the history and the larger history is sent again at the next step.
caption: Figure 2. In a loop, every step re-sends everything so far, including big tool results.
Model asks for a tool -> Tool result added to history -> Whole history sent again -> Model asks again !
```

## How to diagnose it

**1. Record token counts on every call.** Every reply reports the input and output tokens used (the field names differ by provider). Log them with labels, and compute the cost at the same time:

```pseudocode
reply = model.call(prompt)
log(feature, user, conversation, model, turnNumber,
    reply.inputTokens, reply.outputTokens,
    cost = inputTokens * inPrice + outputTokens * outPrice)
```

**2. Break the spend down.** Group by feature, by user and by hour. A pie chart of cost per feature, and a list of the top 20 users, answer "where did it go" in minutes. One API key per feature helps, because your provider's dashboard may show spend per key.

**3. Plot input tokens against turn number.** The shape of the line tells you the cause. A line that rises with every turn is resent history. A flat line that starts high is a big fixed prompt. Sudden jumps are large tool results.

**4. Look for repeats.** Many identical requests, many calls per user in a short time, or agent runs with hundreds of steps point at loops, bots or retries piling up.

## Fix 1: stop resending everything

Send only the last few turns, and replace older ones with a short summary. This is a **sliding window**:

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

At 20 turns the window saves less than half. At 100 turns it saves about 87%, because the cost stops growing faster than the chat and grows in a straight line. The summary adds tokens to every call, so it is there to keep old facts, not to save money.

**Trim in steps, not on every turn.** A window that slides each turn changes the start of the prompt every time, so the prompt cache in Fix 4 never hits. Instead, let the history grow to 10 turns, then cut the oldest 4 at once. The start then stays the same for several calls in a row.

Also trim big tool results before adding them to the history, keeping only the part the next step needs.

## Fix 2: send only what the question needs

Retrieve fewer, better chunks. Choose the number by testing, not by habit: cut from 5 chunks to 3, run about 50 real questions through both versions, and compare the answers (a fixed evaluation set, as in [the hallucinations post](/posts/llm-hallucinations/)). If quality holds, you just saved 1,600 tokens on every call (2 chunks of 800). Making retrieval find the right text is a topic of its own. Do not attach documents to a message that does not need them. Keep the system prompt short and cut instructions that no longer earn their place.

## Fix 3: set limits everywhere

- **A maximum answer length** on every call (often called `max_tokens`, though the name differs by provider), sized to a sensible answer, because output costs more per token and long answers add up. It cuts the answer off, it does not make it shorter, so also ask for brevity in the prompt.
- A **maximum number of steps** for any agent loop, and a maximum total cost per run. Stopping a runaway agent is a topic of its own.
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

It checks before and counts after, so one big call can still pass the limit. The caps on prompt size and `max_tokens` decide how far it can overshoot.

**Put all of this in one place.** Logging, budgets and caps only work if every model call goes through them. Wrap the provider's client in one function, or route calls through a gateway, and let nothing call the model directly. Otherwise a single forgotten call site skips every limit above.

## Fix 4: reuse and right-size

- **Prompt caching.** Many providers charge less when a prompt starts with the same text they saw a moment ago. So put the stable content (instructions, reference material) **first**, and the changing content last. Do not put a timestamp or a user name at the top, because that changes the start of every prompt and the discount never applies. That is also why Fix 1 trims in steps. Saved starts expire, so check your provider's rules for how long they last, how short a start can be, and what the discount is. Caching lowers the price per resent token. It does not lower the number of tokens resent, so the history still grows with every turn, and Fix 1 is still needed.
- **Cache whole answers** for identical questions whose answer does not depend on who is asking.
- **Route by difficulty.** Send simple tasks to a smaller, cheaper model, and use the large one only when needed.
- **Batch work.** Some providers offer cheaper batch processing for jobs that can wait. Check whether yours does.

## When the fix goes wrong

**1. Cutting the history too hard.** The fastest way to save tokens is to send fewer old turns. But the model only knows what you send. If the user said "my order number is 4471" in turn 2 and you send only the last 6 turns, in turn 10 the assistant has forgotten it and asks again, or guesses.

Summaries help, but a summary is written by a model, so it can drop a fact or bend one. The next summary is then built on the bad one, and the error stays. So keep the facts that must survive, such as order numbers and decisions, in a separate small record that you always send. Then summarize rarely and in big steps, and test with questions that depend on early turns.

**2. Caching the wrong thing.** Caching whole answers is cheap and works well for "what are your opening hours?". ([The stale cache post](/posts/stale-caches-explained/) covers other ways caches go wrong.)

It goes wrong when the answer holds one user's data. Say Ann asks "what is my balance?", and the cache key is the question text. The answer "Your balance is $120" is saved. Ben asks the same words, gets Ann's answer, and has seen her private data. No error appears.

Cache only answers that do not depend on who is asking. If you must cache personal answers, put the user's ID in the cache key, so Ann and Ben never share an entry.

**3. A cheaper model that costs more.** Sending simple tasks to a small model looks like a clear saving. But suppose your code tests each small-model answer, and the test fails 7 times in 10. The code retries the small model up to 2 more times, then falls back to the big one. These prices are invented (illustrative): $0.004 per small call and $0.010 per big call. For 1,000 tasks:

```text
first tries:    1,000 small calls
second tries:     700 (70% failed)
third tries:      490 (70% of 700)
big model:        343 (70% of 490)

small: 2,190 calls x $0.004 = $8.76
big:     343 calls x $0.010 = $3.43
total: $12.19, versus $10.00 for big only
```

The "cheap" route costs more, and it is slower too. Measure the success rate of the small model on your own tasks before you route to it. Only route the kinds of task where it usually passes, and retry at most once.

Two shorter ones:

- **Budgets that block good customers.** A hard cap that stops a heavy but legitimate user is its own incident. Warn first, and have a clear path to raise the limit.
- **Counting characters, not tokens.** Code, numbers and many non-English languages produce more tokens per word than plain English. Use the provider's tokenizer or the reported counts, not a guess.

## Which should you use?

| Situation | Reach for |
|---|---|
| Long chats are the biggest cost | **A sliding window plus a summary** of older turns |
| Every call carries thousands of tokens of context | **Retrieve less,** and shorten the system prompt |
| Agents or retries could loop | **Step limits, cost caps and bounded retries** |
| Repeated static instructions | **Prompt caching,** with stable content first |
| Simple tasks on an expensive model | **Route to a smaller model** and measure quality |
| You do not know where the money goes | **Log usage per feature, user and call** before changing anything |

If you are not sure, log the token counts first.

## The takeaway

1. A model is **stateless**, so each call resends the history, the system prompt and any retrieved text. You pay for all of it, every time.
2. History makes cost grow **faster than usage**: for the history part of the cost, doubling a conversation's length roughly quadruples that part.
3. Loops, retries and big tool results multiply the bill without anyone noticing.
4. Diagnose by **logging the token counts** per feature and user, and plotting input tokens against turn number.
5. Control it with **a bounded history trimmed in steps, small prompts, hard limits, budgets, caching and the right-sized model**. Watch spend with alerts and keep a kill switch.
