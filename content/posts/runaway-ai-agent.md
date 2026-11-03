---
title: "Runaway AI agent: cap tool loops before they cost you"
date: 2026-11-01
description: How a runaway AI agent loops on tools and burns money, and how to cap it with step, cost and repeat limits, approvals and a kill switch.
tags: AI, agents, reliability
draft: true
---

## The question

You build an assistant that can search your documents and file support tickets. It works in testing. Over a weekend, one user asks for something the search tool cannot answer, and the search service starts returning errors.

On Monday you find 3,000 identical search calls from one session, and a bill far larger than any normal day. Nothing crashed. The agent just kept trying.

> "The agent was doing exactly what it was built for. Why did it never stop?"

Because nothing in the design tells it to stop. A program that loops until it is satisfied will loop forever if it can never be satisfied, unless you add the limits yourself.

> [!SUMMARY]
> By the end you will know:
>
> 1. What an **agent loop** is, and why it has no natural stopping point
> 2. Why each extra step costs more than the one before
> 3. The usual causes of loops, and how to **spot** them in traces
> 4. Limits that contain them: steps, cost, time, repeats, approvals, budgets and a kill switch

## First, what an agent loop is

A **large language model** (LLM) predicts text. An **agent** wraps it in a loop and gives it **tools**: functions it can ask your code to run, such as "search documents" or "create ticket".

Each round goes like this. The model decides what to do. Your code runs the tool. The result goes back to the model. The model decides again. The loop ends only when the model answers instead of calling a tool.

Think of a new assistant who is told "find that contract" and is never told when to give up. A person gets tired or embarrassed. The loop does neither, and the analogy stops there: the model has no sense of time or money spent unless you give it one.

## Why cost grows with every step

The model has no memory between calls. Each step sends the whole conversation again: the instructions, the task and every earlier tool call and result. See [the token cost post](/posts/llm-token-cost/) for how tokens are billed.

Say the instructions and task take 2,000 tokens, and each step adds 500 tokens of call and result. Step `n` sends `2000 + 500 * (n - 1)` input tokens. Add them up:

| Steps | Input tokens sent in total |
|---|---|
| 10 | 20,000 + 500 * 45 = 42,500 |
| 20 | 40,000 + 500 * 190 = 135,000 |
| 40 | 80,000 + 500 * 780 = 470,000 |

Doubling the steps from 20 to 40 more than triples the input, because each step carries all the earlier ones. Prompt caching can lower the price of the repeated part, but the history still grows. A huge tool result makes it worse, since it is resent on every later step.

```diagram
type: flow
alt: A tool fails, the error goes back to the model, the model retries the same call, and the loop repeats while cost grows.
caption: Figure 1. Nothing in the loop says stop, so the same failure repeats.
Model calls a tool -> Tool returns an error -> Error goes back to model -> Model retries the same call !
```

## Common causes of loops

- **A tool error the model keeps retrying.** The service is down, but the model reads "503" as "try again".
- **An ambiguous goal.** "Find the best option" has no end, so the model keeps searching.
- **No definition of done.** The model is never told what a finished answer looks like.
- **Huge tool results.** A big result crowds the context, the model loses track of what it did, and it repeats work.
- **An unreachable goal.** The data does not exist, but the model cannot know that without checking and then admitting it.

## The loop with limits built in

Here is the loop as pseudocode, with every limit in place:

```text
steps = 0; cost = 0; errors = 0; seen = {}
loop:
    if steps >= MAX_STEPS or cost >= MAX_COST or elapsed >= MAX_TIME: stop
    call = model.next(history)
    if call is a final answer: return it
    key = call.tool + call.arguments
    seen[key] += 1
    if seen[key] >= MAX_REPEATS: stop and tell the user why
    if call.tool is irreversible: wait for human approval
    result = run(call)
    if result is an error: errors += 1 else errors = 0
    if errors >= MAX_ERRORS: stop and tell the user why
    history.add(call, truncate(result)); steps += 1; cost += price(call, result)
```

And a runnable Node version with a fake model that never gives up and a tool that always fails:

```javascript
const fakeModel = () => ({ tool: "search", args: { q: "refund policy" } });
const tools = { search: () => { throw new Error("503 service unavailable"); } };

const LIMITS = { maxSteps: 10, maxCostCents: 5, maxRepeats: 3, maxToolErrors: 3 };
const COST_PER_STEP_CENTS = 1;

function runAgent() {
  let steps = 0, cost = 0, errors = 0;
  const seen = new Map();
  while (true) {
    if (steps >= LIMITS.maxSteps) return "stopped: max steps";
    if (cost >= LIMITS.maxCostCents) return "stopped: max cost";
    const call = fakeModel();
    steps++; cost += COST_PER_STEP_CENTS;
    const key = call.tool + JSON.stringify(call.args);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    console.log(`step ${steps}: ${call.tool} ${JSON.stringify(call.args)} (cost so far ${cost}c)`);
    if (n >= LIMITS.maxRepeats) return "stopped: same call repeated " + n + " times";
    try { tools[call.tool](call.args); errors = 0; }
    catch (e) {
      errors++;
      console.log("  tool error: " + e.message);
      if (errors >= LIMITS.maxToolErrors) return "stopped: repeated tool errors";
    }
  }
}
console.log(runAgent());
```

The real output was:

```text
step 1: search {"q":"refund policy"} (cost so far 1c)
  tool error: 503 service unavailable
step 2: search {"q":"refund policy"} (cost so far 2c)
  tool error: 503 service unavailable
step 3: search {"q":"refund policy"} (cost so far 3c)
stopped: same call repeated 3 times
```

Several limits could fire here, and the repeat limit came first, after three calls. Without it, the error limit would have stopped it at step 3 too. With both off, the cost limit would fire after step 5, and the step limit at step 10 only if every other limit were off.

## How to diagnose it

**1. Trace every step.** Record, for each step: the run ID, the step number, the tool name, the arguments, the result size, the tokens used and the cost. A **trace** is this full record of one run. See [the correlation ID post](/posts/correlation-id-logging/) for tying the steps together.

**2. Look for repeats.** Group steps by tool name and arguments within a run. The same pair many times is the loop's fingerprint.

**3. Watch spend.** Chart cost per run and per user, and alert when one run is far above the median. A run with an enormous step count is the first thing to open.

**4. Look at the ends of long runs.** The last tool errors and the last messages usually show what the model could not get past.

## Fix 1: hard limits per run

**What it is:** a maximum number of steps, a maximum cost and a maximum elapsed time for each run.

**How it works:** check all three before every step, as in the code above. When one trips, stop and return a clear message, such as "I could not finish this in 10 steps."

**What it costs:** some legitimate long tasks get cut off. Pick limits from the real size of your normal runs, plus a margin.

## Fix 2: detect repeats and repeated errors

**What it is:** stop when the same tool is called with the same arguments several times, or when a tool fails several times in a row.

**How it works:** keep a counter keyed on tool and arguments. On the first error, tell the model what failed and that retrying the same call will not help. After the limit, stop and tell the user.

**What it costs:** a little bookkeeping. It catches the cheapest and most common loop.

## Fix 3: make side effects safe

**What it is:** tools that change things, such as sending email or charging cards, must be safe to run twice, or not run at all.

**How it works:** give each action an **idempotency key**, a unique label so a repeat is recognized and ignored. See [the idempotency key post](/posts/idempotency-key-double-charge/). Offer a **dry-run mode** that reports what would happen without doing it. Require **human approval** before irreversible actions. This also limits damage when untrusted text steers the model; see [the prompt injection post](/posts/prompt-injection/).

**What it costs:** extra work in each tool, and a person's time per approval.

## Fix 4: budgets per user and a kill switch

**What it is:** a daily spending cap for each user or account, plus a switch that stops all agent runs at once.

**How it works:** check the user's remaining budget before starting a run. The kill switch is a flag that every loop reads before each step, so you can turn it off without a deploy.

**What it costs:** some users hit the cap. The kill switch must be tested, or it will fail when you need it.

## When the fix goes wrong

Each limit can fail in a quiet way. These are the ones that hurt most.

**1. A step limit so high it protects nothing.** A limit looks like safety: "stop after 1,000 steps, just in case." But a limit only helps if it trips before the damage is done.

Use the same numbers as the cost table (2,000 tokens to start, 500 more per step). A normal run of 10 steps sends 42,500 input tokens in total. A run that reaches 1,000 steps sends 2,000 * 1,000 + 500 * (1,000 * 999 / 2) = 251,750,000 tokens. That is about 5,900 times the cost of a normal run, and the limit has not even tripped yet. The run would also need a context window big enough for the history, so it may fail on its own long before step 1,000.

**What to do instead.** Look at your real runs and find the longest good one. Say it takes 20 steps. Set the limit near 30, and add a cost limit as well, because a cost limit still works if one step is much bigger than the others. When a run hits the limit, treat it as a bug to investigate, not as normal.

**2. Partial side effects when a run is cut off.** A limit stops the loop, but it does not undo what the loop already did. Say the agent must email 5 customers. It sends 3 emails, then hits the step limit at step 7. Now 3 customers know and 2 do not.

If a person or a retry job simply starts the task again, the first 3 customers get a second email. If nobody restarts it, the other 2 never hear anything. Both are wrong, and neither shows up as an error.

**What to do instead.** Write down each completed action as it happens, with an idempotency key (a unique label, so a repeat is recognized and ignored; see Fix 3). A restart then reads the list, skips the 3 finished emails and sends the missing 2. For actions that cannot be repeated or undone, ask a person before they run.

Smaller pitfalls:

- **Retrying with the same arguments.** Retrying an unchanged call after a failure repeats the failure. Change something, or stop.
- **Letting the model decide its own budget.** The model has no real sense of cost. Enforce limits in your code, outside the model.
- **Huge tool results.** Truncate or summarize results before adding them to the history.
- **A silent stop.** If the run just ends, the user thinks it worked. Always report why it stopped.

## Which should you use?

| Problem | Reach for |
|---|---|
| Endless looping | Max steps, cost and time |
| Same failing call again and again | Repeat and error detection |
| Duplicate side effects | Idempotency keys and dry runs |
| Irreversible actions | Human approval |
| One user burning the budget | Per-user budgets |
| Something is on fire right now | Kill switch |

If you are not sure, start with a step limit, a cost limit and a repeat detector. These three catch most runaway loops, and each takes a few lines of code.

## The takeaway

1. An agent loop continues until the model answers, so it needs **limits you add yourself**.
2. Each step resends the whole history, so total cost grows **faster than the step count**.
3. Trace every step with the **tool, arguments and cost**, and treat repeated identical calls as the sign of a loop.
4. Cap **steps, cost, time, repeats and errors**, and always tell the user why a run stopped.
5. Make side effects **idempotent**, ask a human before irreversible actions, set per-user budgets and keep a **kill switch**.
