import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Cloud, Database, Globe, Inbox, Monitor, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import { austereComponent } from "../define.js";
import { reportRuntimeError } from "../env.js";
import { LANES, orthogonalPath } from "./_architecture-lanes.js";
import {
  DIRECTIONS,
  EDGE_STYLES,
  EDGE_TONES,
  GROUP_KINDS,
  NODE_KINDS,
  NODE_TONES,
  SIZES,
  DEFAULT_TARGET_WIDTH,
  LEGIBLE_SCALE,
  buildModel,
  wantsWidePage,
  edgePath,
  layoutModel,
  textWidth,
} from "./_architecture-model.js";

const ICONS = {
  frontend: Monitor,
  backend: Server,
  database: Database,
  messagebus: Inbox,
  cloud: Cloud,
  security: ShieldCheck,
  external: Globe,
};
const STYLE_NAMES = { dashed: "async", emphasis: "main path", security: "auth / trust" };
const GROUP_NAMES = { region: "boundary", security: "trust zone" };

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and its detail together.
const T = ({ children, ...rest }) => <text {...rest}>{children} </text>;

function NodeBox({ n }) {
  const Icon = ICONS[n.kind];
  const { padX, icon } = SIZES;
  const left = n.x + padX;
  const top = n.y + 14 + n.tagRow;
  const tagW = n.tagLine ? textWidth(n.tagLine, SIZES.tag) + 14 : 0;
  return (
    <g
      className={`austere-arch-node k-${n.kind}${n.tone ? ` t-${n.tone}` : ""}`}
      data-oui-id={n.named ? n.id : undefined}
      data-oui-c={n.named ? "Node" : undefined}
    >
      <title>{[n.label, n.detail, n.tag].filter(Boolean).join(" · ")}</title>
      <g data-austere-part={n.label}>
        <rect className="austere-arch-node-box" x={n.x} y={n.y} width={n.width} height={n.height} rx="9" />
        <rect className="austere-arch-node-bar" x={n.x} y={n.y + 8} width="3" height={n.height - 16} rx="1.5" />
        <Icon className="austere-arch-node-icon" x={left} y={top - 2} width={icon} height={icon} aria-hidden="true" />
        {n.labelLines.map((line, i) => (
          <T key={i} className="austere-arch-node-label" x={left + icon + 6} y={top + 11 + i * 17}>
            {line}
          </T>
        ))}
        {n.detailLines.map((line, i) => (
          <T key={`d${i}`} className="austere-arch-node-detail" x={left} y={top + 11 + n.labelLines.length * 17 + 4 + i * 15}>
            {line}
          </T>
        ))}
        {n.tone === "danger" ? (
          // Risk is never colour alone.
          <TriangleAlert
            className="austere-arch-node-risk"
            x={n.x + n.width - 22 - (n.tagLine ? tagW + 4 : 0)}
            y={n.tagRow ? n.y + 7 : top - 2}
            width="14"
            height="14"
            aria-label="risk"
          />
        ) : null}
        {n.tagLine ? (
          <g className="austere-arch-node-tag">
            <rect x={n.x + n.width - tagW - 8} y={n.y + 7} width={tagW} height="15" rx="7.5" />
            <T x={n.x + n.width - tagW / 2 - 8} y={n.y + 18} textAnchor="middle">
              {n.tagLine}
            </T>
          </g>
        ) : null}
      </g>
    </g>
  );
}

function ArchitectureView({ props, statementId }) {
  const rawId = useId();
  const uid = `austere-arch-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const model = useMemo(() => buildModel(props), [props]);
  // Room the page gives us, so "auto" can run across on desktop and down on a phone.
  // Measured before the first layout, so a diagram is laid out once for the
  // width it really has.
  const boxRef = useRef(null);
  const [room, setRoom] = useState(null);
  // A diagram wider than its box scrolls; fade the cut edge so that shows.
  const scrollRef = useRef(null);
  const [fade, setFade] = useState(false);
  const checkCut = () => {
    const el = scrollRef.current;
    if (el) setFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const update = () => {
      const w = el.clientWidth;
      setRoom((prev) => {
        if (prev === null) return w > 0 ? w : DEFAULT_TARGET_WIDTH;
        return w > 0 && Math.abs(prev - w) > 40 ? w : prev;
      });
      checkCut();
    };
    if (typeof ResizeObserver === "undefined") {
      update();
      return undefined;
    }
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { layout, error } = useMemo(() => {
    if (room === null) return { layout: null, error: null };
    try {
      return { layout: layoutModel(model, room), error: null };
    } catch (err) {
      return { layout: null, error: String(err?.message || err) };
    }
  }, [model, room]);
  // Known before measuring (it does not depend on the width), so the page can
  // widen first and the diagram is measured in the wider column.
  const wide = useMemo(() => {
    try {
      return wantsWidePage(model);
    } catch {
      return false;
    }
  }, [model]);

  const problems = error ? [`Layout failed: ${error}`] : model.problems;
  const problemKey = problems.join("\n");
  useEffect(() => {
    for (const message of problems) {
      reportRuntimeError({ source: "architecture", statementId, component: "Architecture", message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(checkCut, [layout]);

  return (
    <div className={`austere-arch-box${wide ? " is-wide" : ""}`} ref={boxRef}>
      {error ? (
        <div className="austere-render-error">
          <strong>Diagram failed to lay out.</strong> {error}
        </div>
      ) : layout ? (
        <Drawing layout={layout} uid={uid} fade={fade} scrollRef={scrollRef} checkCut={checkCut} />
      ) : null}
    </div>
  );
}

function Drawing({ layout, uid, fade, scrollRef, checkCut }) {

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const kinds = [...new Set(layout.nodes.map((n) => n.kind))];
  // A tone overrides the style's colour, so a toned main-path edge stays out
  // of the style legend.
  // (Dashes and dots survive a tone, so those edges stay in.)
  const styles = [...new Set(layout.edges.filter((e) => !e.tone || e.style !== "emphasis").map((e) => e.style))];
  const groupKinds = [...new Set(layout.groups.map((g) => g.kind))].filter((k) => k !== "plain");
  const risky = layout.nodes.some((n) => n.tone === "danger") || layout.edges.some((e) => e.tone === "danger");
  const W = layout.width;
  const H = layout.height;
  // Shrink to fit down to the legible scale, then scroll.
  const minWidth = Math.round(Math.min(W, Math.max(320, W * LEGIBLE_SCALE)));
  // Part names: "From → To", plus the label when two edges join the same pair.
  const pairs = new Map();
  for (const e of layout.edges) pairs.set(`${e.from}>${e.to}`, (pairs.get(`${e.from}>${e.to}`) || 0) + 1);
  const partOf = (e) => {
    const base = `${byId.get(e.from)?.label} → ${byId.get(e.to)?.label}`;
    return pairs.get(`${e.from}>${e.to}`) > 1 && e.label ? `${base} (${e.label})` : base;
  };

  return (
    <figure className="austere-arch">
      <div
        className={`austere-arch-scroll${fade ? " is-cut" : ""}`}
        ref={scrollRef}
        onScroll={checkCut}
      >
        <svg
          className="austere-arch-svg"
          viewBox={`0 0 ${W} ${H}`}
          style={{ maxWidth: `${W}px`, minWidth: `${minWidth}px` }}
          role="img"
          aria-label={`Architecture diagram: ${layout.nodes.map((n) => n.label).join(", ")}`}
        >
          <defs>
            {[...EDGE_STYLES, ...EDGE_TONES.map((t) => `t-${t}`)].map((s) => (
              <marker
                key={s}
                id={`${uid}-${s}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerUnits="userSpaceOnUse"
                markerWidth="9"
                markerHeight="9"
                orient="auto-start-reverse"
              >
                <path d="M0,0L10,5L0,10z" className={`austere-arch-arrow ${s.startsWith("t-") ? s : `s-${s}`}`} />
              </marker>
            ))}
          </defs>

          {layout.groups.map((g) =>
            g.kind === "plain" ? null : (
              <g
                key={g.id}
                className={`austere-arch-group g-${g.kind}${g.lane ? " is-lane" : ""}`}
                data-oui-id={g.named ? g.id : undefined}
                data-oui-c={g.named ? "Group" : undefined}
              >
                <rect className="austere-arch-group-frame" x={g.x} y={g.y} width={g.width} height={g.height} rx={g.lane ? 10 : 12} />
              </g>
            ),
          )}

          {layout.edges.map((e) => {
            const d = e.orthogonal ? orthogonalPath(e.points) : edgePath(e.points);
            if (!d) return null;
            return (
              <g
                key={e.id}
                className={`austere-arch-edge s-${e.style}${e.tone ? ` t-${e.tone}` : ""}${e.orthogonal ? " is-orth" : ""}`}
                data-oui-id={e.named ? e.id : undefined}
                data-oui-c={e.named ? "Edge" : undefined}
              >
                <path className="austere-arch-edge-hit" d={d} data-austere-part={partOf(e)} />
                <path className="austere-arch-edge-line" d={d} markerEnd={`url(#${uid}-${e.tone ? `t-${e.tone}` : e.style})`} />
              </g>
            );
          })}

          {/* Labels sit above every line so a crossing edge never hides them. */}
          {layout.groups.map((g) =>
            g.label ? (
              <g
                key={`gl-${g.id}`}
                className={`austere-arch-group g-${g.kind}`}
                data-oui-id={g.named ? g.id : undefined}
                data-oui-c={g.named ? "Group" : undefined}
              >
                {/* Titles stay outside the part: its text becomes the annotation quote. */}
                {g.labelLine !== g.label ? <title>{g.label}</title> : null}
                {g.lane ? (
                  // A lane names its column with a heading inside the top edge.
                  <g className="austere-arch-lane-head" data-austere-part={g.label}>
                    {/* A target the size of the heading text (lines may pass beside it). */}
                    <rect x={g.x + 8} y={g.y + 5} width={textWidth(g.labelLine, LANES.headSize + 1, true) + 12} height={LANES.head - 8} />
                    <T x={g.x + 14} y={g.y + 21}>
                      {g.labelLine}
                    </T>
                  </g>
                ) : (
                  <g className="austere-arch-group-label" data-austere-part={g.label}>
                    <rect x={g.x + 12} y={g.y - 9} width={textWidth(g.labelLine, SIZES.group) + 14} height="18" rx="5" />
                    <T x={g.x + 19} y={g.y + 4}>
                      {g.labelLine}
                    </T>
                  </g>
                )}
              </g>
            ) : null,
          )}
          {layout.edges.map((e) =>
            e.labelBox ? (
              <g
                key={`el-${e.id}`}
                className={`austere-arch-edge s-${e.style}${e.tone ? ` t-${e.tone}` : ""}`}
                data-oui-id={e.named ? e.id : undefined}
                data-oui-c={e.named ? "Edge" : undefined}
              >
                {e.labelBox.lines.join(" ") !== e.label ? <title>{e.label}</title> : null}
                <g className="austere-arch-edge-label" data-austere-part={partOf(e)}>
                  <rect
                    x={e.labelBox.cx - e.labelBox.width / 2}
                    y={e.labelBox.cy - e.labelBox.height / 2}
                    width={e.labelBox.width}
                    height={e.labelBox.height}
                    rx="5"
                  />
                  <text textAnchor="middle">
                    {e.labelBox.lines.map((line, i) => (
                      <tspan key={i} x={e.labelBox.cx} y={e.labelBox.cy + 4 + (i - (e.labelBox.lines.length - 1) / 2) * 13}>
                        {line}{" "}
                      </tspan>
                    ))}
                  </text>
                </g>
              </g>
            ) : null,
          )}

          {layout.nodes.map((n) => (
            <NodeBox key={n.id} n={n} />
          ))}
        </svg>
      </div>
      {kinds.length > 1 || groupKinds.length || risky || styles.some((s) => s !== "solid") ? (
        <figcaption className="austere-arch-legend">
          {kinds.map((k) => {
            const Icon = ICONS[k];
            return (
              <span key={k} className={`austere-arch-legend-item k-${k}`}>
                <Icon size={13} aria-hidden="true" />
                {k}
              </span>
            );
          })}
          {risky ? (
            <span className="austere-arch-legend-item is-risk">
              <TriangleAlert size={13} aria-hidden="true" />
              risk
            </span>
          ) : null}
          {groupKinds.map((k) => (
            <span key={`g-${k}`} className={`austere-arch-legend-item g-${k}`}>
              <svg width="18" height="12" aria-hidden="true">
                <rect x="1" y="1" width="16" height="10" rx="3" />
              </svg>
              {GROUP_NAMES[k]}
            </span>
          ))}
          {styles
            .filter((s) => s !== "solid")
            .map((s) => (
              <span key={s} className={`austere-arch-legend-item s-${s}`}>
                <svg width="22" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="22" y2="4" />
                </svg>
                {STYLE_NAMES[s]}
              </span>
            ))}
        </figcaption>
      ) : null}
    </figure>
  );
}

const nothing = () => null;

const Node = austereComponent({
  name: "Node",
  group: "Content",
  props: z.object({
    label: z.string(),
    kind: z.enum(NODE_KINDS).optional(),
    detail: z.string().optional(),
    tag: z.string().optional(),
    tone: z.enum(NODE_TONES).optional(),
    row: z.number().int().positive().optional(),
  }),
  description:
    "A box in an Architecture. kind sets icon and color (default backend); detail is monospace, up to 2 lines (\\n breaks); tag is a small chip such as \"new\"; tone tints it (danger = risk, strong = where it ends); row pins it to a row (1, 2, ...) in lanes.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

const Edge = austereComponent({
  name: "Edge",
  group: "Content",
  props: z.object({
    from: Node.definition.ref,
    to: Node.definition.ref,
    label: z.string().optional(),
    style: z.enum(EDGE_STYLES).optional(),
    tone: z.enum(EDGE_TONES).optional(),
  }),
  description:
    "An arrow between two Node statements (pass their names, not strings). style: dashed for async, emphasis for the main path, security for auth or trust flows. tone colors it, e.g. danger for a risky write, success for a read.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

const Group = austereComponent({
  name: "Group",
  group: "Content",
  props: z.object({
    label: z.string(),
    members: z.array(Node.definition.ref),
    kind: z.enum(GROUP_KINDS).optional(),
  }),
  description:
    "A boundary around Node statements (a VPC, a cluster, a trust zone); members still sit where their edges put them. A group whose members are a subset of another's is drawn inside it; kind security draws it red, plain draws only its name.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

const Architecture = austereComponent({
  name: "Architecture",
  group: "Content",
  props: z.object({
    nodes: z.array(Node.definition.ref),
    edges: z.array(Edge.definition.ref),
    groups: z.array(Group.definition.ref).optional(),
    direction: z.enum(DIRECTIONS).optional(),
  }),
  description:
    "System diagram laid out automatically: write no coordinates. Every Node, Edge and Group is its own statement and click target. direction auto (default) runs right when that fits the page legibly, else down; lanes makes each top-level Group a column.",
  notes: [
    "- Architecture for systems: services, stores, queues, trust boundaries. Name every Node, Edge and Group. Over ~15 nodes, use lanes or split the diagram.",
    "- lanes: for systems split by owner, repo or tier. Groups are the columns, left to right as listed; put every node in one, in reading order (plain groups for a heading without a frame). About 4 columns fit a laptop; wider ones scroll (check warns). Phones get the lanes stacked as bands. Pin row only to put boxes side by side or line them up.",
  ],
  renderer: ArchitectureView,
  example: [
    `platformMap = Architecture([browser, edge, api, sessions, cache], [toEdge, toApi, readSessions, readCache], [vpc])
browser = Node("Browser", "external")
edge = Node("Edge worker", "cloud", "Cloudflare")
api = Node("API", "backend", "Node :8080")
sessions = Node("Sessions", "database", "Postgres", "new")
cache = Node("Redis", "database", "read-through")
toEdge = Edge(browser, edge, "HTTPS", "emphasis")
toApi = Edge(edge, api)
readSessions = Edge(api, sessions, "SQL")
readCache = Edge(api, cache, "cache", "dashed")
vpc = Group("Platform VPC", [api, sessions, cache])`,
    `ownership = Architecture([web, ordersApi, ledger, ordersDb, billingJob], [placeOrder, writeOrder, readOrders, postLedger], [clients, ordersRepo, billingRepo], "lanes")
web = Node("Web app", "frontend")
ordersApi = Node("Orders API", "backend", "Node :8080")
ordersDb = Node("orders table", "database", "Postgres", null, "success")
billingJob = Node("Nightly billing", "backend", "cron 02:00")
ledger = Node("Ledger", "database", "append-only", null, "info")
placeOrder = Edge(web, ordersApi, "POST /orders")
writeOrder = Edge(ordersApi, ordersDb, "insert")
readOrders = Edge(billingJob, ordersDb, "read unbilled", null, "danger")
postLedger = Edge(billingJob, ledger, "post")
clients = Group("CLIENTS", [web], "plain")
ordersRepo = Group("orders-service", [ordersApi, ordersDb])
billingRepo = Group("billing", [billingJob, ledger])`,
  ],
  stress: [
    `stressAuto = Architecture([a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p], [ab, bc, cd, de, ef, fg, gh, hi, ij, jk, kl, lm, mn, no, op, aa, ac, ac2, Edge(p, a, "loop back to the very beginning of the pipeline", "dashed")], [outer, inner, Group("", [o, p])])
a = Node("SESSIONS_PG_READ_THROUGH_CACHE_TTL_SECONDS_OVERRIDE", "frontend", "a-very-long-unbroken-detail-token-that-must-be-cut.example.internal:65535", "experimental-feature-flag")
b = Node("Billing service with a long human readable name that wraps", "backend")
c = Node("支払いサービス", "database", "東京リージョン")
d = Node("📦 Queue", "messagebus")
e = Node("e", "cloud")
f = Node("f", "security")
g = Node("g", "external")
h = Node("h")
i = Node("i", "backend", "", "")
j = Node("j", "backend")
k = Node("k", "backend")
l = Node("l", "backend")
m = Node("m", "backend")
n = Node("n", "backend")
o = Node("o", "backend")
p = Node("p", "backend")
ab = Edge(a, b, "an edge label that is long enough to crowd its neighbours", "emphasis")
bc = Edge(b, c)
cd = Edge(c, d, "async", "dashed")
de = Edge(d, e, "token", "security")
ef = Edge(e, f)
fg = Edge(f, g)
gh = Edge(g, h)
hi = Edge(h, i)
ij = Edge(i, j)
jk = Edge(j, k)
kl = Edge(k, l)
lm = Edge(l, m)
mn = Edge(m, n)
no = Edge(n, o)
op = Edge(o, p)
aa = Edge(a, a, "self")
ac = Edge(a, c, "twice")
ac2 = Edge(a, c, "twice again")
outer = Group("Outer boundary with a long name", [b, c, d, e, f, g], "region")
inner = Group("Trust zone", [d, e], "security")`,
    `stressLanes = Architecture([users, gw, auth, svcA, svcB, worker, cache, db, bucket, audit, pager], [toGw, gwAuth, gwA, gwB, aCache, aDb, bDb, bBucket, workerDb, svcAWorker, skipAudit, backToGw, alertPage, retryA, Edge(db, users, "a reply that goes all the way back to the very first lane, past everything", "dashed", "info")], [edgeLane, appLane, trustZone, dataLane, Group("ops", [audit, pager], "plain")], "lanes")
users = Node("Users")
gw = Node("API gateway with a long human readable name", "cloud", "envoy :443\nTLS, rate limits, request ids and much more text", "new", "info")
auth = Node("Auth", "security", "OIDC", null, "danger", 1)
svcA = Node("Orders", "backend", "Go", null, null, 2)
svcB = Node("Payments", "backend", "Java", "PCI", "danger", 2)
worker = Node("Worker", "messagebus", "retries\nDLQ")
cache = Node("Redis", "database")
db = Node("支払い DB", "database", "東京", null, "success")
bucket = Node("S3 📦", "cloud", "receipts", null, "warning")
audit = Node("Audit log", "external")
pager = Node("Pager", "frontend", "on-call", null, "strong")
toGw = Edge(users, gw, "HTTPS", "emphasis")
gwAuth = Edge(gw, auth, "verify token (signing keys)", "security")
gwA = Edge(gw, svcA)
gwB = Edge(gw, svcB, "charge", null, "danger")
aCache = Edge(svcA, cache, "read", "dashed", "success")
aDb = Edge(svcA, db, "SQL")
bDb = Edge(svcB, db, "SQL")
bBucket = Edge(svcB, bucket, "put receipt PDF and a long description of it")
workerDb = Edge(worker, db)
svcAWorker = Edge(svcA, worker, "enqueue")
skipAudit = Edge(gw, audit, "access log")
backToGw = Edge(worker, gw, "webhook", "dashed")
alertPage = Edge(audit, pager)
retryA = Edge(svcA, svcA, "retry")
edgeLane = Group("EDGE", [gw], "plain")
appLane = Group("services · k8s", [auth, svcA, svcB, worker])
trustZone = Group("PCI zone", [svcB], "security")
dataLane = Group("DATA STORES WITH A HEADING LONGER THAN THE COLUMN IS WIDE", [cache, db, bucket], "plain")`,
  ],
});

export default [Architecture, Node, Edge, Group];
