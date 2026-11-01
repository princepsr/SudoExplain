---
title: LLM token cost: why bills explode and how to cap them
date: 2026-11-01
description: Why an AI feature costs ten times the estimate, how growing history, big prompts and loops multiply tokens, and how to find and cap the spend.
tags: AI, LLM, scaling
draft: true
---

## The doubt

An AI feature goes live. The estimate was careful: a few cents per conversation. At the end of the month, the bill is ten times higher. Usage did not grow ten times, and nobody changed the code.

> We counted the questions and answers. Where did all those extra tokens come from?

From text that was **sent again and again**, and from loops nobody was watching. The model re-reads everything on every call.

> [!SUMMARY]
> By the end you will know:
>
> 1. What tokens and the context window are, and why a conversation's cost grows faster than its length
> 2. Five ways tokens multiply: history, big prompts, loops, long answers and the wrong model
> 3. How to **diagnose** where the spend goes
> 4. How to cap and reduce it without hurting quality

## First, tokens, context and the stateless model

An **LLM** (large language model) is a program that predicts text, and chat assistants are built on one. It reads and writes **tokens**: small chunks of text, often a few characters, and roughly three quarters of an English word on average. A word like "unbelievable" may be split into several tokens, and different providers split text differently, so counts differ between them.

Providers charge per token, with **input** tokens (what you send) and **output** tokens (what the model writes) priced separately. Output tokens usually cost more.

A model can only read a limited number of tokens per call. That limit is its **context window**, and it covers the input and the output together. A very long conversation can hit it, and then the call fails or the oldest text must be dropped. The size differs by model, so check your provider's documentation.

The key fact: a model has **no memory between calls**. This is called being **stateless**. It does not remember the earlier turns of a conversation. To make a chat work, your code sends the **entire conversation so far** with every new message. Each call includes the **system prompt** (the standing instructions you write before the user's words), any documents you retrieved, the full history, and the new question.

## The failure: cost grows faster than usage

**1. History is resent every turn.** Say each turn (a question and an answer) adds about 500 tokens to the history. Turn 1 sends no history. Turn 20 sends 19 earlier turns:

```text
turn k resends about 500 x (k - 1) tokens of history

history resent over 20 turns = 500 x (0 + 1 + 2 + ... + 19)
                             = 500 x 190  =  95,000
the new text itself          = 20 x 500   =  10,000

total about 105,000, versus 10,000 if nothing were resent
```

That is roughly **ten times** the naive estimate. It is the bill in the doubt. For the history part, doubling a conversation's length roughly quadruples it. A fixed prompt on every call softens this for short chats, but long chats get close to four times.

At an invented price of $3 per million input tokens, 105,000 tokens cost about $0.32 and 10,000 cost about $0.03. That counts everything at the input price for simplicity. The answers themselves are billed as output, which costs more. A few long conversations can cost more than hundreds of short ones.

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

**2. A big prompt on every call.** A system prompt of 3,000 tokens, plus five retrieved chunks of 800 tokens each, is 7,000 tokens on every call before any history is added. Even a "thanks" message pays the system prompt. Tool definitions, images and PDFs count as tokens too.

**3. Loops and retries.** A **tool** is a function your code lets the model ask for, such as a search. An **agent** is a program where the model keeps choosing tools until a task is done. Each step sends the growing history again, and every tool result, such as a web page or a large file, is added to it. Without a step limit, a bug can loop hundreds of times. A retry after a timeout resends the whole prompt, so a retry loop can multiply your input tokens. Check your provider's usage dashboard for what was actually billed.

```diagram
type: flow
alt: An agent loop where each tool result is added to the history and the larger history is sent again at the next step.
caption: Figure 2. In a loop, every step re-sends everything so far, including big tool results.
Model asks for a tool -> Tool result added to history -> Whole history sent again -> Model asks again !
```

**4. Unbounded output.** If you do not set a maximum, the model may write very long answers, billed at the higher output price. Some models also produce hidden "thinking" tokens before answering. Anthropic and OpenAI both bill them as output tokens, even when you do not see all of them.

**5. A model that is too big for the job.** Classifying a support message with the most capable model costs far more than a small one would, for the same result.

## How to diagnose it

**1. Record token counts on every call.** API responses report how many input and output tokens were used (the field names differ by provider). Log them with labels: which feature, which user, which conversation, which model.

**2. Break the spend down.** Group by feature, by user and by hour. A pie chart of cost per feature, and a list of the top 20 users, answer "where did it go" in minutes. Using one API key per feature makes this easier, and your provider's dashboard may show spend per key.

**3. Look at the long tail.** Find the biggest single requests and the longest conversations. A handful of outliers often explain half of the bill.

**4. Look for repeats.** Many identical requests, many calls per user in a short time, or agent runs with hundreds of steps point at loops, bots or retry storms.

**5. Compare the estimate to reality.** Take one typical conversation and add up its tokens by hand. If the real figure is several times the plan, history growth or prompt size is why.

### See it yourself

Write a short script that has a five-turn chat with a model and prints the reported input token count after each turn. Watch the input number grow each time, even though your questions are short. Use a small model and short questions so the test costs almost nothing.

## Fix 1: stop resending everything

Keep the history **bounded**. Send the last few turns, and replace older ones with a short **summary**:

```pseudocode
recent  = lastTurns(conversation, 6)
summary = conversation.summaryOfOlderTurns       # updated every few turns
prompt  = systemPrompt + summary + recent + newQuestion
```

Also trim big tool results before adding them to the history, keeping only the part the next step needs.

## Fix 2: send only what the question needs

Retrieve fewer, better chunks ([the RAG post](/posts/rag-wrong-answers/) covers retrieval quality). Do not attach documents to a message that does not need them. Keep the system prompt short and cut instructions that no longer earn their place.

## Fix 3: set limits everywhere

- **A maximum answer length** on every call (often called `max_tokens`, though the name differs by provider), sized to a sensible answer. It cuts the answer off, it does not make it shorter, so also ask for brevity in the prompt.
- A **maximum number of steps** for any agent loop, and a maximum total cost per run.
- **Budgets per user and per day**, enforced with a rate limit like the one in [the rate limiting post](/posts/rate-limiting-token-bucket/), counting tokens instead of requests. A runaway client then hits its own cap instead of the company's.
- **Timeouts and bounded retries**, so one failing call does not turn into twenty.
- A **spending limit and alerts** in your provider's console if it offers them, and a **kill switch** you can use at 3 a.m.

## Fix 4: reuse and right-size

- **Prompt caching.** Many providers charge less for a prompt start they have seen recently. Put the stable content (instructions, reference material) **first**, and the changing content last. Cached entries expire, so check your provider's rules for how long they last, how long a prefix must be, and what the discount is.
- **Cache whole answers** for identical, non-personal questions.
- **Route by difficulty.** Send simple tasks to a smaller, cheaper model, and use the large one only when needed.
- **Batch work.** Some providers offer cheaper batch processing for jobs that can wait. Check whether yours does.

## When the fix goes wrong

The first three are the easiest to get wrong.

**1. Cutting the history too hard.** The fastest way to save tokens is to send fewer old turns. But the model only knows what you send. If the user said "my order number is 4471" in turn 2 and you send only the last 6 turns, in turn 10 the assistant has forgotten it and asks again, or guesses.

Summaries help, but a summary is written by a model, so it can drop a fact or bend one. The next summary is then built on the bad one, and the error stays. Rewriting older turns also changes the start of the prompt, so a cached copy of it no longer matches (see Fix 4). So keep the facts that must survive, such as order numbers and decisions, in a separate small record that you always send. Then summarize rarely and in big steps, and test with questions that depend on early turns.

**2. Caching the wrong thing.** A **cache** keeps a saved answer so you can skip the work next time (see [the stale cache post](/posts/stale-caches-explained/)). Caching whole answers is cheap and works well for "what are your opening hours?".

It goes wrong when the answer holds one user's data. Say Ann asks "what is my balance?" and the cache key is the question text. The answer "Your balance is $120" is saved. Ben asks the same words, gets Ann's answer, and has seen her private data. No error appears.

Cache only answers that do not depend on who is asking. If you must cache personal answers, put the user's ID in the cache key, so Ann and Ben never share an entry.

**3. A cheaper model that costs more.** Sending simple tasks to a small model looks like a clear saving. But suppose a check on the small model's answer fails 7 times in 10, and your code retries up to 2 more times before it falls back to the big model. These prices are invented (illustrative): $0.004 per small call and $0.010 per big call. For 1,000 tasks:

```text
first tries:    1,000 small calls
second tries:     700 (70% failed)
third tries:      490 (70% of 700)
big model:        343 (70% of 490)

small: 2,190 calls x $0.004 = $8.76
big:     343 calls x $0.010 = $3.43
total: $12.19, versus $10.00 for big only
```

The "cheap" route costs more, and it is slower too. Measure the success rate of the small model on your own tasks before you route to it. Only route the kinds of task where it usually passes, and stop retrying after one try.

Shorter ones:

- **A cache prefix that keeps changing.** Putting a timestamp or user name at the top of the prompt changes the start every call, so the cache never hits.
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

If you are not sure, log the token counts first. Most teams find that one feature or a handful of users account for most of the spend.

## The takeaway

1. A model is **stateless**, so each call resends the history, the system prompt and any retrieved text. You pay for all of it, every time.
2. History makes cost grow **faster than usage**: for the history part of the cost, doubling a conversation's length roughly quadruples that part.
3. Loops, retries, big tool results and unbounded output multiply the bill without anyone noticing.
4. Diagnose by **logging the token counts** per feature and user, and looking at the biggest requests.
5. Control it with **bounded history, small prompts, hard limits, budgets, caching and the right-sized model**. Watch spend with alerts and keep a kill switch.
