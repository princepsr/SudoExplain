# Pending links

A live post must never link to a draft, because the link would be dead. Where a live post mentions a draft topic, it uses plain text for now. When the draft is published, add the link back and delete the row here.

| Live post | Plain text to turn into a link | Link to add | Waiting for |
|---|---|---|---|
| `slow-query-missing-index` | "GIN index" in Fix 3, the sentence about `LIKE '%smith'` | `/posts/like-wildcard-search-gin-index/` | `like-wildcard-search-gin-index` |
| `connection-pool-exhausted` | "When the fix goes wrong", pitfall 2 (retrying on pool timeout): a link was removed | `/posts/cascading-failures-circuit-breaker/` | `cascading-failures-circuit-breaker` |
| `java-memory-leak` | "Another option: weak references, with care": add "The weak references post covers this in detail" | `/posts/java-weak-vs-strong-references/` | `java-weak-vs-strong-references` |
| `idempotency-key-double-charge` | "Other ways to get the same safety", last bullet: "Queues, and the messages that keep failing in them" | `/posts/poison-message-dead-letter-queue/` | `poison-message-dead-letter-queue` |
| `race-condition-check-then-act` | "Fix 2", "When one statement is not enough: a version number" paragraph, last part: "This is called optimistic locking" | `/posts/lost-update-optimistic-locking/` | `lost-update-optimistic-locking` |
| `race-condition-check-then-act` | "Which should you use?", last table row: "A distributed lock" | `/posts/distributed-lock-failures/` | `distributed-lock-failures` |
| `unbounded-thread-pool-queue` | "Fix 2", last sentence: "Limiting requests at the front door" | `/posts/rate-limiting-token-bucket/` | `rate-limiting-token-bucket` |
| `unbounded-thread-pool-queue` | "When the fix goes wrong", pitfall 3, last sentence: "a retry storm" | `/posts/cascading-failures-circuit-breaker/` | `cascading-failures-circuit-breaker` |
| `connection-pool-exhausted` | "How to diagnose it", step 2 (thread dump): add "If threads are BLOCKED on a lock and not waiting for a connection, see" | `/posts/java-blocked-threads-lock-owner/` | `java-blocked-threads-lock-owner` |
| `unbounded-thread-pool-queue` | "When the fix goes wrong", pitfall 2: add a sentence on threads stuck behind one lock | `/posts/java-blocked-threads-lock-owner/` | `java-blocked-threads-lock-owner` |
| `llm-token-cost` | "Fix 2", first bullet: "Making retrieval find the right text is a topic of its own" | `/posts/rag-wrong-answers/` | `rag-wrong-answers` |
| `llm-token-cost` | "Fix 3", first bullet: "Stopping a runaway agent is a topic of its own" | `/posts/runaway-ai-agent/` | `runaway-ai-agent` |
| `llm-token-cost` | "Fix 3", budgets bullet: "Rate limiting is a topic of its own" | `/posts/rate-limiting-token-bucket/` | `rate-limiting-token-bucket` |
| `llm-hallucinations` | "Fix 2", last paragraph: "Why a lookup itself fails is a topic of its own" | `/posts/rag-wrong-answers/` | `rag-wrong-answers` |
| `llm-hallucinations` | "Fix 4", last paragraph: "Money rounding is a topic of its own" | `/posts/java-bigdecimal-money-rounding/` | `java-bigdecimal-money-rounding` |
| `llm-hallucinations` | "When the fix goes wrong", shorter ones: "Prompt injection is a topic of its own" | `/posts/prompt-injection/` | `prompt-injection` |

Also: when a draft is published, link back to it from 1 or 2 older posts, and make sure it links to 2 or 3 related posts.
