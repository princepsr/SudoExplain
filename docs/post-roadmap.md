# Post roadmap

Every post teaches a concept **and the production failure that comes with it**: not "what a garbage collector is" but "what happens when it cannot free memory because something still holds a strong reference". Each post follows the usual shape (question, summary, short basics, the failure, how to diagnose it, the fixes, which to use, takeaway) and ends with what goes wrong when the fix is used badly.

All posts below are written as **drafts** (`draft: true`). To publish one: review it, delete `draft: true`, set `date` to the publish day, run `node og-images.mjs` and `node build.mjs --check`, then commit and push. The plan is one post a week.

Status: `done` = published, `draft` = written, waiting for review.

| # | Area | Post | The production failure it is built around | File | Status |
|---|---|---|---|---|---|
| 1 | Auth, scaling | Sessions, JWTs and load balancers explained | Session in one server's memory; random logouts behind a load balancer | sessions-jwt-and-load-balancers | done |
| 2 | Caching, scaling | Stale cache and cache stampede: why servers disagree | Two servers show different data; expiry causes a stampede | stale-caches-explained | done |
| 3 | Java | Java memory leak: strong references and heap dumps | Leak through strong references (static map, listener, ThreadLocal) | java-memory-leak | done |
| 4 | Java | Connection pool exhausted: why the app hangs under load | Leaked connections hang every request; more servers make it worse | connection-pool-exhausted | draft |
| 5 | Java | Unbounded thread pool queue: how it hides overload | Executor queue grows until the server dies | unbounded-thread-pool-queue | draft |
| 6 | Java | Race condition in Java: check-then-act explained | "If absent, put" loses data under load | race-condition-check-then-act | done |
| 7 | Java, database | N+1 query problem: why one page runs 500 queries | One page triggers hundreds of queries after a data growth | n-plus-one-query-problem | draft |
| 8 | Java | Java BigDecimal vs double for money: rounding errors | Floating point and rounding in money | java-bigdecimal-money-rounding | draft |
| 9 | Backend | Cascading failures: timeouts, retries, circuit breakers | One slow dependency takes down every service; retries make it worse | cascading-failures-circuit-breaker | draft |
| 10 | Backend | Idempotency keys: stop retries from charging twice | A timed-out request retried charges twice | idempotency-key-double-charge | draft |
| 11 | Backend, scaling | Spring @Scheduled job runs twice on multiple servers | Scale out and every server runs the cron job | scheduled-job-runs-multiple-times | draft |
| 12 | Backend | Poison message: how one bad message blocks a queue | One bad message blocks a queue forever | poison-message-dead-letter-queue | draft |
| 13 | Backend | Rate limiting an API: token bucket vs fixed window | One client in a retry loop floods the API | rate-limiting-token-bucket | draft |
| 14 | Scaling | Kubernetes readiness vs liveness probes: why deploys fail | A deploy takes the whole site down | readiness-vs-liveness-probes | draft |
| 15 | Backend | Time zones in Java: why dates are off by one day | Everything is off by one day for some users | time-zones-off-by-one-day | draft |
| 16 | Database | Slow SQL query: missing index, EXPLAIN and fixes | A query that was fast with 1,000 rows takes 30 seconds with 10 million | slow-query-missing-index | draft |
| 17 | Database | Database deadlocks: two transactions waiting on each other | Two transactions wait for each other | database-deadlocks | draft |
| 18 | Database | Lost update problem: optimistic locking explained | Two users save the same record; one change vanishes | lost-update-optimistic-locking | draft |
| 19 | Database | Offset vs keyset pagination: skipped rows, slow pages | Offset paging skips rows and crawls on page 5,000 | offset-vs-keyset-pagination | draft |
| 20 | Security | Broken access control (IDOR): seeing others' data | Broken access control (changing an ID in the URL) | broken-access-control-idor | draft |
| 21 | Auth | JWT clock skew: why valid tokens say not yet valid | Clock drift between servers rejects fresh tokens | jwt-clock-skew | draft |
| 22 | Design | Saga pattern: when step 3 of 4 fails across services | A multi-service action fails halfway (saga pattern) | saga-pattern | draft |
| 23 | AI | Prompt injection: when a web page hijacks your AI | A web page hijacks the AI assistant that reads it | prompt-injection | draft |
| 24 | AI | RAG wrong answers: why retrieval fails and how to fix it | A retrieval (RAG) system finds the wrong text | rag-wrong-answers | draft |
| 25 | AI | LLM token cost: why bills explode and how to cap them | Tokens, context growth and retry loops | llm-token-cost | draft |
| 26 | Java | Java GC pauses: why latency spikes and how to find them | Stop-the-world pauses freeze requests every few minutes | java-gc-pauses | draft |
| 27 | Java, containers | Java OOMKilled in Docker (exit code 137): why it dies | The container limit kills the JVM although the heap looks healthy | java-docker-oomkilled | draft |
| 28 | Java | Java thread deadlock: find it with a thread dump | Two threads wait for each other's locks and the service hangs | java-thread-deadlock | draft |
| 29 | Java, backend | Blocked event loop in Netty: why one slow call freezes all | A blocking call on an event-loop thread stalls every request | blocked-event-loop | draft |
| 30 | Java | NoSuchMethodError in production: Java dependency conflicts | Two library versions on the classpath; it works locally and fails after deploy | java-dependency-conflict | draft |
| 31 | Networking | DNS TTL: why traffic still hits the old server | A DNS change does not take effect because of TTLs and caches (including the JVM's) | dns-ttl-caching | draft |
| 32 | Networking, security | Expired TLS certificate: why it takes the site down | A certificate expires unnoticed and every client refuses to connect | expired-tls-certificate | draft |
| 33 | Web | CORS error: no Access-Control-Allow-Origin header, explained | The API works in curl but the browser blocks it | cors-errors-explained | draft |
| 34 | Networking | nginx 502 Bad Gateway: idle timeout mismatch behind a proxy | Random 502s because the proxy reuses a connection the app already closed | 502-bad-gateway-keep-alive | draft |
| 35 | Database | Read replica lag: why users do not see their own writes | A user saves, reloads, and the change is missing | read-replica-lag | draft |
| 36 | Database, deploy | Zero-downtime database migration: add a column safely | A schema change locks a table and blocks production | zero-downtime-migration | draft |
| 37 | Database | Integer ID overflow: when the primary key runs out | An INT id column hits its maximum and inserts start failing | integer-id-overflow | draft |
| 38 | Distributed systems | Distributed lock failures: why Redis locks need fencing | A lock expires while its holder is paused, and two workers proceed | distributed-lock-failures | draft |
| 39 | Distributed systems | Split brain: when two servers both think they lead | A network partition produces two leaders that both accept writes | split-brain | draft |
| 40 | Messaging | Kafka consumer rebalance storm: why processing stalls | Consumers keep leaving and rejoining the group and no one makes progress | kafka-rebalance-storm | draft |
| 41 | Distributed systems | Transactional outbox: fix the dual write problem | The database commit succeeds but the event is never published | transactional-outbox | draft |
| 42 | Security | SQL injection: how one quote breaks your login | User input is run as part of a query | sql-injection | draft |
| 43 | Security | Leaked secret in Git: what to do in the first hour | A password or API key was committed to a repository | leaked-secret-in-git | draft |
| 44 | Security, web | XSS (cross-site scripting): when input runs as code | Stored user text runs as a script in other users' browsers | xss-cross-site-scripting | draft |
| 45 | Kubernetes | Kubernetes CrashLoopBackOff: debug a restarting pod | A container starts, fails and restarts in a loop | crashloopbackoff | draft |
| 46 | Observability | Correlation ID in logs: trace a request across microservices | One failed request is impossible to find among millions of log lines | correlation-id-logging | draft |
| 47 | Scaling, cloud | Kubernetes autoscaling too late: why spikes cause outages | New instances arrive after the traffic spike has already caused errors | autoscaling-too-late | draft |
| 48 | Operations | No space left on device: logs, inodes and log rotation | Logs fill the disk and the server stops working | disk-full-outage | draft |
| 49 | AI | LLM hallucinations: validate AI output in production | The model invents a plausible answer and the system acts on it | llm-hallucinations | draft |
| 50 | AI | Runaway AI agent: cap tool loops before they cost you | An agent calls tools in a loop with no limit | runaway-ai-agent | draft |
| 51 | Database | Slow LIKE '%text%' search: fix it with a GIN index | A search box ignores the index and scans the whole table | like-wildcard-search-gin-index | draft (outline only) |
| 53 | Java | Java weak vs strong references: why WeakHashMap leaks | A `WeakHashMap` "cache" either empties itself on every GC or still leaks | java-weak-vs-strong-references | draft |
| 52 | Database | Covering index: answer a query without touching the table | `SELECT *` forces a table visit for every row; an index-only scan, or `INCLUDE`, avoids it | covering-index-only-scan | idea (no file yet) |

Skipped on purpose: topics with no real production failure (what a URL is, what an index is in the abstract). A topic only earns a post if there is a bug people actually meet.
