// The fixed review-page tasks. Every tool gets the same prompt, the same
// reviewer note, and is scored on the same facts.
//
//   facts         strings the first page must contain (case-insensitive): a cheap
//                 check that a short page did not get short by dropping content
//   playbooks     lavish-axi playbooks that match the task. lavish's --help says to
//                 open every matching playbook before writing HTML, so its prompt
//                 includes them, as an agent following lavish's guidance would see
//   feedback      one reviewer note. `anchor` is text on the page the note is
//                 attached to; `expect` must appear in the page after the revision

const COMMON =
  "No existing design system applies; this is a standalone review page. Use only the facts below; do not invent extra data.";

export interface Task {
  id: string;
  title: string;
  playbooks: string[];
  prompt: string;
  facts: string[];
  feedback: { anchor: string; note: string; expect: string[] };
}

export const TASKS: Task[] = [
  {
    id: "migration-plan",
    title: "Migration plan",
    playbooks: ["plan", "diagram", "input"],
    prompt: `Make a review page for this migration plan, so the reviewer can approve it and pick a rollout strategy. ${COMMON}

Plan: move user sessions from Redis to Postgres.
- Why: sessions live only in Redis and are lost on failover. Last month that forced 38,214 users to log in again.
- Goal: durable sessions, no forced logout, auth p99 stays at or under 45 ms (today 41 ms).
- Request path after the change: Client -> API (Node, port 8080) -> Postgres (new "sessions" table). Redis stays as a read-through cache in front of Postgres.
- Phases: 1) create the sessions table and dual-write (1 week); 2) backfill existing sessions (2 days); 3) switch reads to Postgres behind the sessions_pg flag (1 week); 4) remove Redis writes (1 day).
- Risks: write latency on login (mitigation: async write with a 50 ms timeout); table bloat from expired rows (mitigation: nightly partition drop).
- Extra cost: $140/month.
- Decision needed: rollout strategy, either "Big bang" (one deploy, high risk) or "Dual-write" (gradual, low risk). Let the reviewer pick one and send the decision.`,
    facts: ["38,214", "45 ms", "sessions_pg", "8080", "Dual-write", "Big bang", "$140", "partition", "backfill"],
    feedback: {
      anchor: "table bloat",
      note: "Add a third risk: connection pool exhaustion during the dual-write phase. Mitigation: put PgBouncer in transaction mode in front of Postgres.",
      expect: ["PgBouncer"],
    },
  },
  {
    id: "code-review",
    title: "Code review",
    playbooks: ["code", "table"],
    prompt: `Make a review page for my review of this pull request: the findings with their severity, and the diff they refer to, so the author can see each finding next to the code. ${COMMON}

PR #482 "Add user search endpoint" (src/routes/users.js, +9 -1, 31 tests passed).

\`\`\`diff
diff --git a/src/routes/users.js b/src/routes/users.js
--- a/src/routes/users.js
+++ b/src/routes/users.js
@@ -12,7 +12,15 @@ router.get("/users/:id", async (req, res) => {
   res.json(user);
 });
 
-router.get("/users", listUsers);
+router.get("/users", async (req, res) => {
+  const q = req.query.q;
+  const rows = await db.query(
+    "SELECT id, name, email FROM users WHERE name LIKE '%" + q + "%'"
+  );
+  res.json(rows);
+});
+
+router.get("/users/export", exportUsers);
 
 module.exports = router;
\`\`\`

Findings:
1. High: SQL injection. The query concatenates req.query.q into the SQL string (line 18).
2. Medium: no pagination. The search returns every matching row; with 2.1M users this can time out.
3. Medium: the email column is returned to any logged-in user (line 18). Return only id and name.
4. Low: /users/export has no test.
Verdict: request changes.`,
    facts: ["#482", "SQL injection", "pagination", "2.1M", "export", "request changes", "LIKE"],
    feedback: {
      anchor: "SQL injection",
      note: "Raise this finding to Blocker and show the fix: a parameterized query, `WHERE name ILIKE $1` with the value `%${q}%`.",
      expect: ["Blocker", "$1"],
    },
  },
  {
    id: "architecture-decision",
    title: "Architecture decision",
    playbooks: ["comparison", "diagram", "input"],
    prompt: `Make a review page for this architecture decision record, so the reviewer can accept or reject it. ${COMMON}

ADR-017: Event bus for order events.
- Context: the Orders service calls Billing, Shipping and Notifications over HTTP in sequence. One slow call blocks checkout; last quarter there were 3 incidents from this.
- Options:
  - Kafka: throughput 1M msg/s, replay yes, ops cost high (we would run a 3-broker cluster), team experience: none.
  - NATS JetStream: throughput 200k msg/s, replay yes, ops cost medium, team experience: one engineer.
  - Amazon SQS + SNS: throughput effectively unlimited, replay no (14-day retention only), ops cost low (managed), team experience: high.
- Proposed decision: SQS + SNS. Orders publishes "order.placed" to an SNS topic; Billing, Shipping and Notifications each read from their own SQS queue.
- Consequences: no event replay, so we keep an outbox table in the Orders database; at-least-once delivery, so every consumer must be idempotent.
- Status: proposed. The reviewer should be able to Accept or Reject, with an optional comment.`,
    facts: ["ADR-017", "Kafka", "NATS", "SQS", "order.placed", "outbox", "idempotent", "1M", "200k"],
    feedback: {
      anchor: "NATS",
      note: "Add a row (or criterion) for monthly cost estimate: Kafka about $2,400, NATS JetStream about $900, SQS + SNS about $310 at our volume.",
      expect: ["2,400", "$310"],
    },
  },
  {
    id: "comparison-table",
    title: "Comparison table",
    playbooks: ["comparison", "table"],
    prompt: `Make a review page that compares these vector databases, so the reviewer can shortlist two. ${COMMON}

Use case: semantic search over 40M document chunks, 768-dim embeddings, p95 query latency target 50 ms.

| | Pinecone | Weaviate | Qdrant | Milvus |
|---|---|---|---|---|
| Hosting | managed only | managed or self-host | managed or self-host | self-host (Zilliz for managed) |
| p95 latency at 40M (our test) | 38 ms | 61 ms | 44 ms | 52 ms |
| Est. monthly cost | $3,100 | $1,900 | $1,250 | $1,400 + ops time |
| Hybrid (keyword + vector) search | yes | yes | yes | partial |
| Metadata filtering | good | good | very good | good |
| License | proprietary | BSD-3 | Apache-2.0 | Apache-2.0 |

Our recommendation: shortlist Qdrant (best latency per dollar) and Pinecone (lowest latency, no ops). Let the reviewer change the shortlist with checkboxes and send it.`,
    facts: ["Pinecone", "Weaviate", "Qdrant", "Milvus", "40M", "38 ms", "$1,250", "Apache-2.0", "BSD-3"],
    feedback: {
      anchor: "Milvus",
      note: "Add pgvector as a fifth option: self-host on our existing Postgres, p95 latency 95 ms, about $400/month, hybrid search yes (with tsvector), metadata filtering good, license PostgreSQL.",
      expect: ["pgvector", "95 ms"],
    },
  },
  {
    id: "dashboard",
    title: "Dashboard",
    playbooks: ["table", "explanation"],
    prompt: `Make a weekly service-health dashboard page for the checkout service, for the Monday review. ${COMMON}

Week of 2026-10-26.
- Requests: 48.2M (up 6% week over week).
- Error rate: 0.21% (SLO 0.5%).
- p95 latency: 312 ms (target 300 ms): breached.
- Error budget left this month: 64%.
- Daily p95 latency (ms), Mon to Sun: 288, 295, 340, 331, 305, 297, 330.
- Daily errors, Mon to Sun: 9,800; 10,400; 15,900; 12,100; 9,900; 8,700; 9,300.
- Incidents:
  - INC-1042, Tue, Sev2, 38 min: payment provider timeouts. Status: resolved.
  - INC-1047, Wed, Sev3, 12 min: bad config push to the cart cache. Status: resolved.
  - INC-1051, Sun, Sev3, ongoing: elevated p95 from a slow inventory query. Status: investigating.
- Action items: add an index on inventory(sku, warehouse_id) (owner: Priya, due Nov 4); add a timeout alert for the payment provider (owner: Marco, due Nov 6).`,
    facts: ["48.2M", "0.21%", "312 ms", "64%", "INC-1042", "INC-1051", "Priya", "warehouse_id", "15,900"],
    feedback: {
      anchor: "INC-1047",
      note: "INC-1047 was Sev2, not Sev3, and lasted 47 minutes. Fix the row and add a postmortem link label \"PM-1047\".",
      expect: ["PM-1047", "47 min"],
    },
  },
  {
    id: "release-triage",
    title: "Release triage",
    playbooks: ["table", "input"],
    prompt: `Make a review page to triage these open bugs for release 3.8, so the reviewer can set a decision for each bug and send them all back at once. ${COMMON}

Release 3.8 ships Thursday. Code freeze is Wednesday 18:00.

| Bug | Title | Severity | Users affected | Fix estimate |
|---|---|---|---|---|
| BUG-311 | Checkout button disabled after coupon removal | high | ~4% of carts | 0.5 day |
| BUG-318 | Dark mode: unreadable table headers in Reports | low | Reports users | 1 hour |
| BUG-322 | CSV export drops rows over 10,000 | medium | 120 accounts | 2 days |
| BUG-327 | Push notification sent twice on Android 15 | medium | ~9% of Android | unknown |

For each bug the reviewer picks one of: "fix for 3.8", "defer to 3.9", "won't fix". My suggestion: fix BUG-311 and BUG-318, defer BUG-322 and BUG-327.`,
    facts: ["3.8", "BUG-311", "BUG-318", "BUG-322", "BUG-327", "10,000", "defer to 3.9", "won't fix", "Android 15"],
    feedback: {
      anchor: "BUG-327",
      note: "Add BUG-330 \"Password reset email links expire after 5 minutes instead of 60\", severity high, all users who reset a password, fix estimate 1 hour. Suggest: fix for 3.8.",
      expect: ["BUG-330"],
    },
  },
];
