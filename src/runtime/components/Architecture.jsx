import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Cloud, Database, Globe, Inbox, Monitor, Server, ShieldCheck } from "lucide-react";
import { austereComponent } from "../define.js";
import { reportRuntimeError } from "../env.js";
import {
  DIRECTIONS,
  EDGE_STYLES,
  GROUP_KINDS,
  NODE_KINDS,
  SIZES,
  DEFAULT_TARGET_WIDTH,
  buildModel,
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

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and its detail together.
const T = ({ children, ...rest }) => <text {...rest}>{children} </text>;

function NodeBox({ n }) {
  const Icon = ICONS[n.kind];
  const { padX, icon } = SIZES;
  const left = n.x + padX;
  const top = n.y + 14;
  const tagW = n.tag ? textWidth(n.tag, SIZES.tag) + 14 : 0;
  return (
    <g
      className={`austere-arch-node k-${n.kind}`}
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
        {n.detailLine ? (
          <T className="austere-arch-node-detail" x={left} y={top + 11 + n.labelLines.length * 17 + 4}>
            {n.detailLine}
          </T>
        ) : null}
        {n.tag ? (
          <g className="austere-arch-node-tag">
            <rect x={n.x + n.width - tagW - 10} y={n.y - 9} width={tagW} height="17" rx="8.5" />
            <T x={n.x + n.width - tagW / 2 - 10} y={n.y + 3} textAnchor="middle">
              {n.tag}
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
  const boxRef = useRef(null);
  const [room, setRoom] = useState(DEFAULT_TARGET_WIDTH);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setRoom((prev) => (Math.abs(prev - w) > 40 ? w : prev));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { layout, error } = useMemo(() => {
    try {
      return { layout: layoutModel(model, room), error: null };
    } catch (err) {
      return { layout: null, error: String(err?.message || err) };
    }
  }, [model, room]);

  const problems = error ? [`Layout failed: ${error}`] : model.problems;
  const problemKey = problems.join("\n");
  useEffect(() => {
    for (const message of problems) {
      reportRuntimeError({ source: "architecture", statementId, component: "Architecture", message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);

  if (error) {
    return (
      <div className="austere-render-error" ref={boxRef}>
        <strong>Diagram failed to lay out.</strong> {error}
      </div>
    );
  }
  if (!layout) return <div ref={boxRef} />;

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const kinds = [...new Set(layout.nodes.map((n) => n.kind))];
  const styles = [...new Set(layout.edges.map((e) => e.style))];
  const W = layout.width;
  const H = layout.height;
  const minWidth = Math.round(Math.min(W, Math.max(320, W * 0.7)));

  return (
    <figure className="austere-arch" ref={boxRef}>
      <div className="austere-arch-scroll">
        <svg
          className="austere-arch-svg"
          viewBox={`0 0 ${W} ${H}`}
          style={{ maxWidth: `${W}px`, minWidth: `${minWidth}px` }}
          role="img"
          aria-label={`Architecture diagram: ${layout.nodes.map((n) => n.label).join(", ")}`}
        >
          <defs>
            {EDGE_STYLES.map((s) => (
              <marker
                key={s}
                id={`${uid}-${s}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0L10,5L0,10z" className={`austere-arch-arrow s-${s}`} />
              </marker>
            ))}
          </defs>

          {layout.groups.map((g) => (
            <g
              key={g.id}
              className={`austere-arch-group g-${g.kind}`}
              data-oui-id={g.named ? g.id : undefined}
              data-oui-c={g.named ? "Group" : undefined}
            >
              <rect className="austere-arch-group-frame" x={g.x} y={g.y} width={g.width} height={g.height} rx="12" />
            </g>
          ))}

          {layout.edges.map((e) => {
            const d = edgePath(e.points);
            if (!d) return null;
            return (
              <g
                key={e.id}
                className={`austere-arch-edge s-${e.style}`}
                data-oui-id={e.named ? e.id : undefined}
                data-oui-c={e.named ? "Edge" : undefined}
              >
                <path className="austere-arch-edge-hit" d={d} />
                <path className="austere-arch-edge-line" d={d} markerEnd={`url(#${uid}-${e.style})`} />
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
                <g className="austere-arch-group-label" data-austere-part={g.label}>
                  <rect x={g.x + 12} y={g.y - 9} width={textWidth(g.label, SIZES.group) + 14} height="18" rx="5" />
                  <T x={g.x + 19} y={g.y + 4}>
                    {g.label}
                  </T>
                </g>
              </g>
            ) : null,
          )}
          {layout.edges.map((e) =>
            e.labelBox ? (
              <g
                key={`el-${e.id}`}
                className={`austere-arch-edge s-${e.style}`}
                data-oui-id={e.named ? e.id : undefined}
                data-oui-c={e.named ? "Edge" : undefined}
              >
                <g
                  className="austere-arch-edge-label"
                  data-austere-part={`${byId.get(e.from)?.label} → ${byId.get(e.to)?.label}`}
                >
                  <rect
                    x={e.labelBox.cx - e.labelBox.width / 2}
                    y={e.labelBox.cy - e.labelBox.height / 2}
                    width={e.labelBox.width}
                    height={e.labelBox.height}
                    rx="5"
                  />
                  <T x={e.labelBox.cx} y={e.labelBox.cy + 4} textAnchor="middle">
                    {e.label}
                  </T>
                </g>
              </g>
            ) : null,
          )}

          {layout.nodes.map((n) => (
            <NodeBox key={n.id} n={n} />
          ))}
        </svg>
      </div>
      {kinds.length > 1 || styles.some((s) => s !== "solid") ? (
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
  }),
  description:
    "A box in an Architecture. kind sets its icon and color (default backend); detail is a monospace second line such as tech or a port; tag is a small chip such as \"new\".",
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
  }),
  description:
    "An arrow between two Node statements (pass their names, not strings). style: dashed for async, emphasis for the main path, security for auth or trust flows.",
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
    "A boundary around Node statements (a VPC, a cluster, a trust zone). A group whose members are a subset of another's is drawn inside it; kind security draws it red.",
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
    "System diagram laid out automatically: write no coordinates. Every Node, Edge and Group is its own statement and click target. direction auto (default) picks right or down to fit the page.",
  notes: [
    "- Architecture for systems: services, stores, queues, trust boundaries. Name every Node, Edge and Group.",
  ],
  renderer: ArchitectureView,
  example: `requestPath = Architecture([browser, edge, api, sessions, cache], [toEdge, toApi, readSessions, readCache], [vpc])
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
  stress: `stressArch = Architecture([a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p], [ab, bc, cd, de, ef, fg, gh, hi, ij, jk, kl, lm, mn, no, op, aa, ac, ac2, Edge(p, a, "loop back to the very beginning of the pipeline", "dashed")], [outer, inner, Group("", [o, p])])
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
});

export default [Architecture, Node, Edge, Group];
