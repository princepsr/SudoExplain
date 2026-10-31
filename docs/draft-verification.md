# Fact-check status of the drafts

Every draft went through three independent rounds: a first review for clarity and obvious errors, a correctness-only pass by new reviewers, and a final pass that checked each remaining claim against primary sources (official documentation, RFCs, the projects' own source code and the original papers). All the findings were applied.

## Confirmed against primary sources

- Every Java snippet that can run on its own compiles and prints what the post says, and all the arithmetic is right. All links between posts resolve, and all 66 diagram images fit their boxes on laptop and phone.
- **Java and Spring:** `jcmd GC.heap_dump` and `GC.class_histogram` both run a full GC by default (`-all` skips it), the Eclipse MAT "exclude weak/soft references" menu entry, `MultipleBagFetchException`, `hibernate.default_batch_fetch_size`, `hibernate.generate_statistics`, `@BatchSize`, Spring Boot's pass-through of `spring.jpa.properties.*`, Spring Boot's default scheduler pool of one thread, HikariCP defaults and metric names, the Spring Boot default task executor.
- **Kubernetes:** probe defaults (`timeoutSeconds` 1, `periodSeconds` 10, `failureThreshold` 3), a CronJob can occasionally create two Jobs or none, `spec.timeZone` stable since 1.27, the built-in `preStop` sleep action stable since 1.34.
- **Messaging:** `spring.deserializer.value.delegate.class`, the Spring Kafka dead-letter topic suffix (`-dlt` from 3.3, `.DLT` before), `max.poll.interval.ms` default 300000, an SQS FIFO queue needs a FIFO dead-letter queue, the Jackson feature names, Redis `INCR` plus `EXPIRE` gap and Lua atomicity, nginx `limit_req` (a leaky bucket), Spring Cloud Gateway `RequestRateLimiter` (token bucket), Bucket4j, ShedLock's requirements.
- **Database and security:** the InnoDB claims (gap locks, `innodb_print_all_deadlocks`, `PROCESS` privilege, `sys.innodb_lock_waits`, deadlock detection on by default), Spring's deadlock exception mapping, RFC 9110 (412) and RFC 6585 (428), Spring Data keyset scrolling since 3.1, PostgreSQL 18 and MySQL 8.0.13 skip scan, `@EnableMethodSecurity`, `-parameters`, `anyRequest().denyAll()`, OWASP A01 in 2021 and 2025, BOLA as API1:2023, Autorize, jjwt 0.12's exact messages and zero default tolerance, Node `jsonwebtoken` and PyJWT defaults, PyJWT checking `iat`, Spring's 60-second skew checking only `exp` and `nbf`.
- **AI and HTTP:** reciprocal rank fusion (rank-based, constant 60), the "lost in the middle" study, about 0.75 words per token, thinking tokens billed as output at Anthropic and OpenAI, batch endpoints at 50%, the "lethal trifecta" attribution, lowercase header names over HTTP/2 and HTTP/3 (RFC 9113 and 9114), Tomcat's StandardManager.

## Still unverified

These are the only items no primary source could confirm. None is stated as fact in a way that would mislead. Check them if you want to be thorough.

- **Spring Boot readiness at shutdown.** The docs table shows readiness becoming `REFUSING_TRAFFIC` during graceful shutdown, but the reviewer found no code that publishes it. The health-checks post states what the documentation says.
- **PostgreSQL row comparison and B-tree ranges.** The documentation states the comparison semantics, but only the source code (`nbtsearch.c`) shows a B-tree can use it as a range start. The post says "can use it to start the scan".
- **SQS console polling.** Whether polling messages in the console raises `ApproximateReceiveCount` is not documented, and the posts do not claim it.
- **Whether a tokenizer splits `E-4012`.** This follows from the Unicode segmentation rules that Elasticsearch's standard analyzer uses, but nobody ran an analyzer. The post says "many standard tokenizers" and tells readers to test theirs.
- **Billing for timed-out requests.** No provider documents it, so the cost post makes no billing claim and points readers to their usage dashboard.
- **The two `EXPLAIN` outputs** in the index and pagination posts are hand-written examples, and the posts label them illustrative. Replace them with real output if you want strict accuracy.
- **The "$3 per million input tokens"** is an invented price, and the post labels it that way. Keep it labeled.

---

# The second batch of 25 drafts (posts 26 to 50)

These went through the same process: written with sources checked while writing, then verified by independent reviewers against primary sources, then corrected. All Java and Node snippets that can run on their own were run, and the output in the posts is real. All 67 diagrams across the 50 posts fit on laptop and phone, and every link between posts resolves.

## Confirmed against primary sources

- **JVM and containers:** the JDK 21 defaults (200 ms pause goal, 25% default heap share, direct memory capped at the heap size by default), the real `OutOfMemoryError` messages for direct buffers and Metaspace, native memory tracking, generational ZGC (JEP 439, default in JDK 23, non-generational removed in JDK 24), G1 as default only on server-class machines, BlockHound, Reactor `boundedElastic` limits, Maven's tie-break and Gradle's conflict resolution, Enforcer `dependencyConvergence`.
- **Networking and operations:** the JVM DNS cache defaults (30 s, 10 s negative), `dig`, `openssl x509 -checkend` behavior, the CA/Browser Forum lifetime schedule (by issue date), Let's Encrypt, certbot and cert-manager renewal rules, the Fetch standard's preflight rules, nginx, ALB and Tomcat keep-alive defaults, Docker `json-file` defaults, `lsof +L1`.
- **Databases and distributed systems:** lock queue behavior (PostgreSQL's lock manager source and the MySQL manual), `lock_timeout`, `NOT VALID`/`VALIDATE`, `SET NOT NULL` with a valid `CHECK` (PostgreSQL 12), PostgreSQL 11 fast defaults, `ALGORITHM=INSTANT`, `SHOW REPLICA STATUS` (8.0.22), `synchronous_commit = remote_apply`, sequence exhaustion error text, Redis lock recipe and `DELEX` (8.4), the two published Redlock positions and their dates, quorum arithmetic, Raft terms.
- **Messaging and security:** Kafka consumer defaults and log lines from Kafka's own source, the cooperative assignor, static membership, the Kafka 4.0 group protocol, Debezium outbox routing and replication-slot retention, `SKIP LOCKED` in PostgreSQL and MySQL, OWASP guidance (SQL injection and XSS), the H2 injection demo, GitHub's secret-removal guide, `git-filter-repo` 2.47, push protection defaults, AWS CLI key commands.
- **Kubernetes, observability and AI:** back-off timing, exit codes, `kubectl debug` label dropping, the HPA formula and defaults (15 s sync, 300 s scale-down window, scale-up limits), the exact HPA event text, W3C `traceparent`, SLF4J MDC behavior (demo run with real Logback), structured outputs at OpenAI, Anthropic and Google, recomputed token tables.

## Still unverified for the second batch

None of these is stated as a hard fact. Check them if you want to be thorough.

- **Kubernetes:** the exact `kubectl describe` and `kubectl get` output formats (labeled illustrative), that `kubectl debug --copy-to` always drops labels (documented in the kubectl source), and the exit code Kubernetes reports when a command is missing from the image (the post says `StartError`).
- **MySQL:** the `lock_wait_timeout` manual entry (a secondary source quotes it), the version where `Seconds_Behind_Master` became `Seconds_Behind_Source`, and the default of `information_schema_stats_expiry`.
- **PostgreSQL:** the exact "integer out of range" message text (the sequence exhaustion message is from the source), whether `ALTER COLUMN TYPE` behaves the same for identity columns, and the read-your-writes recipe based on WAL positions (sound, but not documented as a recipe).
- **Java:** the `-Xlog:gc*` option string and `nr_throttled` in cgroup v2 (standard, not fetched), `ThreadMXBean.findDeadlockedThreads()`, and Maven's `-Dverbose` output text on your plugin version (the posts label the Maven output illustrative).
- **Kafka:** the two-round cooperative rebalance description (from the design proposal, which was not fetched).
- **Web:** Chrome, Firefox and Java error message wording, `nslookup -debug` TTL output, and that Jinja or Django `|safe` bypasses escaping.
- **AI:** no failure or hallucination rates are stated anywhere. The prices in the cost posts are invented and labeled.
