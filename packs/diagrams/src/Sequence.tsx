import React, { useEffect, useId, useMemo } from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame, reportRuntimeError } from "austere-axi/pack";
import type { DiagramContent, RendererArgs } from "austere-axi/pack";
import {
  ACTOR_KINDS,
  BRANCH_OPS,
  GEOM,
  MESSAGE_KINDS,
  buildModel,
  layoutModel,
} from "./_sequence-model.ts";
import type { Layout, MessageKind, PlacedMessage, SequenceInput } from "./_sequence-model.ts";
import guide from "./Sequence.md";

const nothing = () => null;

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and the next one together.
const T = ({
  children,
  ...rest
}: React.SVGProps<SVGTextElement> & { children?: React.ReactNode }) => (
  <text {...rest}>{children} </text>
);

function ActorBox({ a, y }: { a: Layout["actors"][number]; y: number }) {
  const { actorW, actorH } = GEOM;
  const x = a.x - actorW / 2;
  const mid = y + actorH / 2;
  const first = mid - ((a.lines.length - 1) * 16) / 2 + 4.5;
  return (
    <g
      className={`dg-seq-actor k-${a.actor.kind}`}
      data-oui-id={a.actor.named ? a.actor.id : undefined}
      data-oui-c={a.actor.named ? "Actor" : undefined}
    >
      <title>{a.actor.label}</title>
      <g data-austere-part={a.actor.label}>
        <rect
          className="dg-seq-actor-box"
          x={x}
          y={y}
          width={actorW}
          height={actorH}
          rx={a.actor.kind === "user" ? actorH / 2 : 9}
        />
        {a.actor.kind === "database" ? (
          // A cylinder cue: the cap line is the shape signal, not the colour.
          <line className="dg-seq-actor-cap" x1={x} x2={x + actorW} y1={y + 9} y2={y + 9} />
        ) : null}
        {a.lines.map((line, i) => (
          <T key={i} className="dg-seq-actor-label" x={a.x} y={first + i * 16} textAnchor="middle">
            {line}
          </T>
        ))}
      </g>
    </g>
  );
}

function markerFor(m: PlacedMessage, uid: string): string {
  if (m.message.emphasis) return `url(#${uid}-emphasis)`;
  return `url(#${uid}-${m.message.kind === "async" ? "open" : "filled"})`;
}

function MessageRow({ m, names, uid }: { m: PlacedMessage; names: string[]; uid: string }) {
  const { message } = m;
  const part = `${names[message.from]} → ${names[message.to]}${message.label ? `: ${message.label}` : ""}`;
  const d = m.loop
    ? `M${m.x1},${m.y} h${GEOM.loopW} v${GEOM.loopH} h${-GEOM.loopW}`
    : `M${m.x1},${m.y} L${m.x2 + (m.x2 > m.x1 ? -1 : 1)},${m.y}`;
  return (
    <g
      className={`dg-seq-message k-${message.kind}${message.emphasis ? " is-emphasis" : ""}`}
      data-oui-id={message.named ? message.id : undefined}
      data-oui-c={message.named ? "Message" : undefined}
    >
      <g data-austere-part={part}>
        {/* One invisible box over the arrow and its label carries the click (and the middle of the part). */}
        <rect
          className="dg-seq-hit"
          x={m.box.x}
          y={m.box.y}
          width={m.box.width}
          height={m.box.height}
        />
        <path className="dg-seq-message-line" d={d} markerEnd={markerFor(m, uid)} />
        {m.lines.map((line, i) => (
          <T
            key={i}
            className="dg-seq-message-label"
            x={m.labelX}
            y={m.labelY + i * GEOM.line}
            textAnchor={m.anchor}
          >
            {line}
          </T>
        ))}
      </g>
    </g>
  );
}

function drawing(layout: Layout, uid: string): DiagramContent {
  const { width, height } = layout;
  const names = layout.actors.map((a) => a.actor.label);
  const kinds = new Set<MessageKind>(layout.messages.map((m) => m.message.kind));
  const emphasised = layout.messages.some((m) => m.message.emphasis);
  const content = (
    <svg
      className="dg-seq-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Sequence diagram: ${names.join(", ")}`}
    >
      <defs>
        {(["filled", "emphasis", "open"] as const).map((k) => (
          <marker
            key={k}
            id={`${uid}-${k}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerUnits="userSpaceOnUse"
            markerWidth="9"
            markerHeight="9"
            orient="auto-start-reverse"
          >
            {k === "open" ? (
              <polyline className="dg-seq-arrow is-open" points="1,1 9,5 1,9" />
            ) : (
              <path
                className={`dg-seq-arrow${k === "emphasis" ? " is-emphasis" : ""}`}
                d="M0,0L10,5L0,10z"
              />
            )}
          </marker>
        ))}
      </defs>

      {layout.xs.map((x, i) => (
        <line
          key={`l${i}`}
          className="dg-seq-lifeline"
          x1={x}
          x2={x}
          y1={layout.lifelineTop}
          y2={layout.lifelineBottom}
        />
      ))}

      {layout.branches.map((b) => (
        <g
          key={b.branch.id}
          className={`dg-seq-branch op-${b.branch.op}`}
          data-oui-id={b.branch.named ? b.branch.id : undefined}
          data-oui-c={b.branch.named ? "Branch" : undefined}
        >
          <rect
            className="dg-seq-branch-frame"
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            rx="4"
          />
          {/* Titles stay outside the part: its text becomes the annotation quote. */}
          {b.branch.guard && b.guard !== `[${b.branch.guard}]` ? (
            <title>{b.branch.guard}</title>
          ) : null}
          <g data-austere-part={`${b.branch.op}${b.branch.guard ? ` [${b.branch.guard}]` : ""}`}>
            <rect className="dg-seq-hit" x={b.x} y={b.y} width={b.headWidth} height={GEOM.tabH} />
            <rect
              className="dg-seq-branch-tab"
              x={b.x}
              y={b.y}
              width={b.tabWidth}
              height={GEOM.tabH}
              rx="3"
            />
            <T
              className="dg-seq-branch-op"
              x={b.x + b.tabWidth / 2}
              y={b.y + 12}
              textAnchor="middle"
            >
              {b.branch.op.toUpperCase()}
            </T>
            {b.guard ? (
              <T className="dg-seq-branch-guard" x={b.x + b.tabWidth + 8} y={b.y + 12}>
                {b.guard}
              </T>
            ) : null}
          </g>
          {b.dividerY !== null ? (
            <>
              <line
                className="dg-seq-branch-divider"
                x1={b.x + 8}
                x2={b.x + b.width - 8}
                y1={b.dividerY}
                y2={b.dividerY}
              />
              <g data-austere-part={`else${b.branch.elseGuard ? ` [${b.branch.elseGuard}]` : ""}`}>
                <rect
                  className="dg-seq-hit"
                  x={b.x + 8}
                  y={b.elseGuardY - 12}
                  width={b.elseWidth + 4}
                  height="16"
                />
                <T className="dg-seq-branch-guard" x={b.x + 12} y={b.elseGuardY}>
                  {b.elseGuard || "[else]"}
                </T>
              </g>
            </>
          ) : null}
        </g>
      ))}

      {layout.messages.map((m) => (
        <MessageRow key={m.message.id} m={m} names={names} uid={uid} />
      ))}

      {layout.actors.map((a) => (
        <ActorBox key={a.actor.id} a={a} y={8} />
      ))}
    </svg>
  );
  const caption =
    kinds.size > 1 || emphasised ? (
      <figcaption className="dg-seq-legend">
        {kinds.has("call") ? (
          <span className="dg-seq-legend-item">
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" />
            </svg>
            call
          </span>
        ) : null}
        {kinds.has("return") ? (
          <span className="dg-seq-legend-item is-dashed">
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" />
            </svg>
            return
          </span>
        ) : null}
        {kinds.has("async") ? (
          <span className="dg-seq-legend-item is-dashed">
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" />
            </svg>
            async (open head)
          </span>
        ) : null}
        {emphasised ? (
          <span className="dg-seq-legend-item is-emphasis">
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" />
            </svg>
            main result
          </span>
        ) : null}
      </figcaption>
    ) : null;
  return { content, width, caption };
}

function SequenceView({ props, statementId }: RendererArgs<SequenceInput>) {
  const rawId = useId();
  const uid = `dg-seq-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const model = useMemo(() => buildModel(props), [props]);
  const layout = useMemo(() => (model.actors.length ? layoutModel(model) : null), [model]);

  const problemKey = model.problems.join("\n");
  useEffect(() => {
    for (const message of model.problems)
      reportRuntimeError({ source: "sequence", statementId, component: "Sequence", message });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);

  return (
    <DiagramFrame
      className="dg-seq"
      name="Sequence diagram"
      wide={layout ? layout.width > 900 : false}
    >
      {() => {
        if (!layout) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Sequence has no Actors.</strong> List the Actor statements first.
              </div>
            ),
          };
        }
        return drawing(layout, uid);
      }}
    </DiagramFrame>
  );
}

export const Actor = austereComponent({
  name: "Actor",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    kind: z.enum(ACTOR_KINDS).optional(),
  }),
  description:
    "A column in a Sequence. kind: service (default), external (dashed box), database (cylinder cue) or user (rounded). Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Message = austereComponent({
  name: "Message",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    from: Actor.definition.ref,
    to: Actor.definition.ref,
    label: z.string().optional(),
    kind: z.enum(MESSAGE_KINDS).optional(),
    emphasis: z.enum(["emphasis"]).optional(),
  }),
  description:
    'An arrow between two Actor statements (pass their names), drawn in list order from top to bottom. kind: call (default), return (dashed) or async (open head). from = to draws a loop. "emphasis" marks the one main result. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Branch = austereComponent({
  name: "Branch",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    op: z.enum(BRANCH_OPS),
    guard: z.string().optional(),
    messages: z.array(Message.definition.ref),
    elseGuard: z.string().optional(),
    elseMessages: z.array(Message.definition.ref).optional(),
  }),
  description:
    "A frame around Messages in a Sequence: op alt, opt or loop, with a guard text. alt may take a second region (elseGuard, elseMessages). One level: no Branch inside a Branch. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Sequence = austereComponent({
  name: "Sequence",
  group: "Diagrams",
  tier: "extended",
  family: "Flow",
  keywords: [
    "sequence",
    "request",
    "response",
    "api call",
    "protocol",
    "handshake",
    "lifeline",
    "interaction",
    "trace",
    "message flow",
    "login flow",
    "oauth",
    "who calls whom",
    "call order",
  ],
  guide,
  limits: [
    {
      prop: "actors",
      max: 5,
      message: "Split into an overview and a detail diagram: more than 5 columns are hard to read.",
    },
    {
      prop: "messages",
      max: 12,
      message:
        "Split the flow at the failure or refresh path: more than 12 messages are hard to follow.",
    },
  ],
  props: z.object({
    actors: z.array(Actor.definition.ref),
    messages: z.array(z.union([Message.definition.ref, Branch.definition.ref])),
  }),
  description:
    "Time-ordered messages between Actors: one lifeline column for each, Messages top to bottom, Branch frames for alt, opt and loop. Each Actor, Message and Branch is a click target.",
  renderer: SequenceView,
  example: [
    `loginFlow = Sequence([webClient, authApi, userDb], [askLogin, findUser, userRow, loginOk])
webClient = Actor("Client", "external")
authApi = Actor("API")
userDb = Actor("Postgres", "database")
askLogin = Message(webClient, authApi, "POST /login")
findUser = Message(authApi, userDb, "SELECT user")
userRow = Message(userDb, authApi, "1 row", "return")
loginOk = Message(authApi, webClient, "200 OK", "return", "emphasis")`,
    `refresh = Sequence([phone, ordersSvc, idp, ordersPg], [getOrders, verify, check, done])
phone = Actor("Mobile phone", "user")
ordersSvc = Actor("Orders API")
idp = Actor("Identity provider", "external")
ordersPg = Actor("Postgres", "database")
getOrders = Message(phone, ordersSvc, "GET /orders (Bearer)")
verify = Message(ordersSvc, ordersSvc, "verify JWT")
check = Branch("alt", "token valid", [query, rows], "token expired", [expired, renew, fresh])
query = Message(ordersSvc, ordersPg, "SELECT orders")
rows = Message(ordersPg, ordersSvc, "12 rows", "return")
expired = Message(ordersSvc, phone, "401 token expired", "return")
renew = Message(phone, idp, "POST /token (refresh)")
fresh = Message(idp, phone, "new access token", "return")
done = Message(ordersSvc, phone, "200 orders", "return", "emphasis")`,
  ],
  stress: [
    `stressSeq = Sequence([qa, qb, qc, qd, last], [m1, m2, m3, selfLast, br, m4, m5, m6, m10, m11])
qa = Actor("SESSIONS_PG_READ_THROUGH_CACHE_TTL_SECONDS_OVERRIDE", "database")
qb = Actor("Billing service with a long human readable name that wraps", "external")
qc = Actor("支払いサービス", "user")
qd = Actor("📦 Queue")
last = Actor("Last column with a self loop")
m1 = Message(qa, qb, "A_VERY_LONG_UNBROKEN_LABEL_TOKEN_THAT_MUST_BE_CUT_AT_THE_COLUMN_WIDTH_AND_NOTHING_ELSE")
m2 = Message(qb, qa, "", "return")
m3 = Message(qc, qd, "東京リージョンへのリクエストを送信する", "async")
selfLast = Message(last, last, "a self message at the last column with a long label that needs the room to the right")
br = Branch("alt", "a guard that is much too long to fit inside the frame it is written in at all", [m4a], "else guard that is also very long and keeps going on", [m4b, m4c])
m4a = Message(qa, qb, "first")
m4b = Message(qd, qd, "second, a self loop in the middle")
m4c = Message(last, qd, "back across the last two columns", "return")
m4 = Message(last, qd, "after the branch", "return")
m5 = Message(qd, qc, "five")
m6 = Message(qc, qb, "six", "async")
m10 = Message(qa, last, "ten, across every column in between")
m11 = Message(last, qa, "eleven", "return", "emphasis")`,
  ],
});
