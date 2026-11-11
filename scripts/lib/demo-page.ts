// The page the demo's agent writes (PAGE), and the two statements it patches in (PATCH).
// Shared by scripts/demo.ts and scripts/social.ts.
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Session storage migration</title>
<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro, flow, options], "column", "l")
intro = Card([CardHeader("Session storage migration", "Redis → Postgres"), introText])
introText = MarkDownRenderer("Sessions are lost on failover. **Goal:** durable sessions, no forced logout.")
flow = Card([CardHeader("Request path"), flowDiagram])
flowDiagram = Architecture([client, api, pg], [toApi, toPg])
client = Node("Client", "external")
api = Node("API", "backend", "Node :8080")
pg = Node("Postgres", "database", "sessions table", "new")
toApi = Edge(client, api, "HTTPS", "emphasis")
toPg = Edge(api, pg, "SQL")
options = Card([CardHeader("Rollout options"), optionTable])
optionTable = Table([Col("Option", ["Big bang", "Dual-write"]), Col("Effort", ["2 days", "5 days"]), Col("Risk", [Tag("high", null, "sm", "danger"), Tag("low", null, "sm", "success")])])
</script></body></html>
`;
export const PATCH = `pg = Node("Postgres", "database", "sessions + replica", "new")
optionTable = Table([Col("Option", ["Big bang", "Dual-write"]), Col("Effort", ["2 days", "3 days"]), Col("Risk", [Tag("high", null, "sm", "danger"), Tag("low", null, "sm", "success")])])
`;
