// Sequence: parsed props → model → positions. Pure TypeScript (no JSX), so Node tests can import it.
import { isElement } from "./element.ts";

export const ACTOR_KINDS = ["service", "external", "database", "user"] as const;
export const MESSAGE_KINDS = ["call", "return", "async"] as const;
export const BRANCH_OPS = ["alt", "opt", "loop"] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type BranchOp = (typeof BRANCH_OPS)[number];

export interface SequenceInput {
  actors?: unknown;
  messages?: unknown;
}

export interface ModelActor {
  id: string;
  named: boolean;
  label: string;
  kind: ActorKind;
}
export interface ModelMessage {
  id: string;
  named: boolean;
  from: number;
  to: number;
  label: string;
  kind: MessageKind;
  emphasis: boolean;
}
export interface ModelBranch {
  id: string;
  named: boolean;
  op: BranchOp;
  guard: string;
  elseGuard: string;
  main: ModelMessage[];
  other: ModelMessage[];
}
export type ModelItem =
  | { type: "message"; message: ModelMessage }
  | { type: "branch"; branch: ModelBranch };
export interface Model {
  actors: ModelActor[];
  items: ModelItem[];
  problems: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  (list as readonly unknown[]).includes(v);

interface Parsed {
  statementId?: string;
  props: Record<string, unknown>;
}
const asElement = (v: unknown): Parsed | null =>
  isElement<Record<string, unknown>>(v)
    ? {
        statementId:
          "statementId" in v && typeof v.statementId === "string" ? v.statementId : undefined,
        props: v.props,
      }
    : null;

export function buildModel(props: SequenceInput | null | undefined): Model {
  const problems: string[] = [];
  const actors: ModelActor[] = [];
  const byElement = new Map<object, number>();
  const byId = new Map<string, number>();
  let anon = 0;

  const actorIndex = (value: unknown, orderListed: boolean): number | null => {
    const el = asElement(value);
    if (!el || typeof value !== "object" || value === null) return null;
    const seen = byElement.get(value);
    if (seen !== undefined) return seen;
    const id = el.statementId || `_actor${anon++}`;
    let index = byId.get(id);
    if (index === undefined) {
      index = actors.length;
      actors.push({
        id,
        named: !!el.statementId,
        label: str(el.props.label).trim() || id,
        kind: oneOf(ACTOR_KINDS, el.props.kind) ? el.props.kind : "service",
      });
      byId.set(id, index);
      if (!orderListed)
        problems.push(
          `Message uses ${el.statementId ? el.statementId : `Actor "${str(el.props.label)}"`}, which is not in the actors list of Sequence; it is added as the last column. List every Actor.`,
        );
    }
    byElement.set(value, index);
    return index;
  };

  for (const a of Array.isArray(props?.actors) ? props.actors : []) actorIndex(a, true);

  const message = (value: unknown): ModelMessage | null => {
    const el = asElement(value);
    if (!el) return null;
    const from = actorIndex(el.props.from, false);
    const to = actorIndex(el.props.to, false);
    if (from === null || to === null) return null; // the parser already reports the missing end
    return {
      id: el.statementId || `_message${anon++}`,
      named: !!el.statementId,
      from,
      to,
      label: str(el.props.label).trim(),
      kind: oneOf(MESSAGE_KINDS, el.props.kind) ? el.props.kind : "call",
      emphasis: el.props.emphasis === "emphasis",
    };
  };
  const messages = (list: unknown): ModelMessage[] =>
    (Array.isArray(list) ? list : []).flatMap((m) => message(m) ?? []);

  const items: ModelItem[] = [];
  for (const value of Array.isArray(props?.messages) ? props.messages : []) {
    const el = asElement(value);
    if (!el) continue;
    // A Branch carries an op and a list of messages; a Message carries two actors.
    if ("messages" in el.props || "op" in el.props) {
      const op = oneOf(BRANCH_OPS, el.props.op) ? el.props.op : "opt";
      const main = messages(el.props.messages);
      const other = op === "alt" ? messages(el.props.elseMessages) : [];
      if (!main.length && !other.length) {
        problems.push(
          `Branch ${el.statementId ?? `"${str(el.props.guard)}"`} has no Messages, so it is not drawn.`,
        );
        continue;
      }
      items.push({
        type: "branch",
        branch: {
          id: el.statementId || `_branch${anon++}`,
          named: !!el.statementId,
          op,
          guard: str(el.props.guard).trim(),
          elseGuard: str(el.props.elseGuard).trim(),
          main,
          other,
        },
      });
    } else {
      const m = message(value);
      if (m) items.push({ type: "message", message: m });
    }
  }
  return { actors, items, problems };
}

// ── text ──────────────────────────────────────────────────────────────

/** Approximate advance width at a font size; deterministic and generous, so boxes never clip text. */
export function textWidth(text: string, size: number, mono = false): number {
  let w = 0;
  for (const ch of text) {
    if (mono) w += 0.62;
    else if (ch.charCodeAt(0) > 0x2e7f) w += 1.02;
    else if (/[ilI.,:;'|!()[\]{} ]/.test(ch)) w += 0.32;
    else if (/[mwMW@%&]/.test(ch)) w += 0.88;
    else if (/[A-Z0-9#$?_~]/.test(ch)) w += 0.68;
    else w += 0.57;
  }
  return Math.ceil(w * size);
}

/** Cuts text to fit a width, ending in "…". */
export function clip(text: string, size: number, maxWidth: number, mono = false): string {
  if (textWidth(text, size, mono) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length && textWidth(`${chars.join("")}…`, size, mono) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

/** At most `maxLines` lines no wider than `maxWidth`; breaks at spaces, and inside a token longer than a line. The last line ends in "…" when cut. */
export function wrap(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = () => {
    lines.push(line);
    line = "";
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (textWidth(rest, size) > maxWidth) {
      if (line) push();
      const cut = Array.from(rest);
      while (cut.length > 1 && textWidth(cut.join(""), size) > maxWidth) cut.pop();
      lines.push(cut.join(""));
      rest = rest.slice(cut.join("").length);
    }
    const joined = line ? `${line} ${rest}` : rest;
    if (line && textWidth(joined, size) > maxWidth) {
      push();
      line = rest;
    } else line = joined;
  }
  if (line) push();
  if (!lines.length) return [""];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = clip(`${kept[maxLines - 1]}…`, size, maxWidth);
  return kept;
}

// ── layout ────────────────────────────────────────────────────────────

export const GEOM = {
  col: 160,
  pad: 24,
  actorW: 132,
  actorH: 46,
  gap: 14,
  line: 14,
  font: 12,
  loopW: 34,
  loopH: 20,
  tabH: 16,
  selfRoom: 150,
} as const;

export type Geom = { [K in keyof typeof GEOM]: number };

/** On a phone the columns share the room, so every actor and message shows at scale 1. */
export function phoneGeom(room: number, actors: number): Geom {
  const pad = 8;
  const col = Math.max(60, Math.floor((room - pad * 2) / Math.max(actors, 1)));
  return { ...GEOM, pad, col, actorW: col - 4, selfRoom: col + 20, loopW: 24 };
}

export interface PlacedMessage {
  message: ModelMessage;
  x1: number;
  x2: number;
  /** y of the arrow */
  y: number;
  /** self-message: a loop right of the lifeline */
  loop: boolean;
  lines: string[];
  /** label block: centre x, first baseline y, anchor */
  labelX: number;
  labelY: number;
  anchor: "middle" | "start";
  /** the click area: the arrow and its label */
  box: { x: number; y: number; width: number; height: number };
}
export interface PlacedBranch {
  branch: ModelBranch;
  x: number;
  y: number;
  width: number;
  height: number;
  tabWidth: number;
  guard: string;
  /** width of the tab and the guard text beside it */
  headWidth: number;
  elseWidth: number;
  dividerY: number | null;
  elseGuard: string;
  elseGuardY: number;
}
export interface Layout {
  width: number;
  height: number;
  /** lifeline x for each actor */
  xs: number[];
  actors: { actor: ModelActor; x: number; lines: string[] }[];
  messages: PlacedMessage[];
  branches: PlacedBranch[];
  lifelineTop: number;
  lifelineBottom: number;
  geom: Geom;
}

export function layoutModel(model: Model, geom: Geom = GEOM): Layout {
  const { col, pad, actorW, actorH, gap, line, font, loopW, loopH, tabH } = geom;
  const colX = (i: number) => pad + col / 2 + i * col;
  const n = Math.max(model.actors.length, 1);
  const hasSelfLast = model.items.some((it) =>
    (it.type === "message" ? [it.message] : [...it.branch.main, ...it.branch.other]).some(
      (m) => m.from === m.to && m.from === n - 1,
    ),
  );
  const width = pad * 2 + n * col + (hasSelfLast ? geom.selfRoom - col / 2 + 8 : 0);
  const xs = model.actors.map((_, i) => colX(i));

  const actors = model.actors.map((actor, i) => ({
    actor,
    x: xs[i],
    lines: wrap(actor.label, 13, actorW - 20, 2),
  }));
  const top = 8 + actorH;
  let y = top + gap;
  const messages: PlacedMessage[] = [];
  const branches: PlacedBranch[] = [];

  const place = (m: ModelMessage): void => {
    const x1 = xs[m.from];
    const x2 = xs[m.to];
    if (m.from === m.to) {
      const roomRight = (m.from < n - 1 ? col : geom.selfRoom) - loopW - 14;
      const lines = m.label ? wrap(m.label, font, roomRight, 3) : [];
      const block = Math.max(lines.length * line, loopH);
      const ay = y + 6 + (block - loopH) / 2;
      messages.push({
        message: m,
        x1,
        x2,
        y: ay,
        loop: true,
        lines,
        labelX: x1 + loopW + 8,
        labelY: ay + loopH / 2 - (lines.length * line) / 2 + line - 3,
        anchor: "start",
        box: {
          x: x1 - 6,
          y: ay - 6,
          width: loopW + 14 + Math.max(0, ...lines.map((l) => textWidth(l, font))),
          height: loopH + 12,
        },
      });
      y += block + 22;
      return;
    }
    const span = Math.abs(x2 - x1) - 16;
    const lines = m.label ? wrap(m.label, font, span, 3) : [];
    const ay = y + lines.length * line + 10;
    messages.push({
      message: m,
      x1,
      x2,
      y: ay,
      loop: false,
      lines,
      labelX: (x1 + x2) / 2,
      labelY: y + line - 3,
      anchor: "middle",
      box: {
        x: Math.min(x1, x2),
        y,
        width: Math.abs(x2 - x1),
        height: ay + 8 - y,
      },
    });
    y = ay + 16;
  };

  for (const item of model.items) {
    if (item.type === "message") {
      place(item.message);
      continue;
    }
    const b = item.branch;
    const all = [...b.main, ...b.other];
    let lo = Math.min(...all.flatMap((m) => [m.from, m.to]));
    let hi = Math.max(...all.flatMap((m) => [m.from, m.to]));
    const tabWidth = textWidth(b.op.toUpperCase(), 9) + 18;
    const guards = [b.guard, b.elseGuard].filter(Boolean).map((g) => `[${g}]`);
    const needed = Math.max(
      tabWidth + 14 + Math.max(0, ...guards.map((g) => textWidth(g, 11, true))),
      120,
    );
    const inset = col * 0.42;
    const selfRight = Math.max(
      0,
      ...all.filter((m) => m.from === m.to && m.from === hi).map(() => geom.selfRoom - 8),
    );
    const spanOf = () =>
      Math.max(xs[hi] - xs[lo] + inset * 2, selfRight && lo === hi ? selfRight + inset : 0);
    // Widen over the next actor only when the guard does not fit; never over an unused one otherwise.
    while (spanOf() < needed && (hi < n - 1 || lo > 0)) {
      if (hi < n - 1) hi++;
      else lo--;
    }
    const x = Math.max(xs[lo] - inset, 4);
    const right = Math.min(Math.max(xs[hi] + inset, selfRight ? xs[hi] + selfRight : 0), width - 4);
    const frameW = right - x;
    const top0 = y + 4;
    y = top0 + tabH + 12;
    for (const m of b.main) place(m);
    let dividerY: number | null = null;
    let elseGuardY = 0;
    if (b.other.length) {
      dividerY = y + 2;
      elseGuardY = y + 20;
      y += 30;
      for (const m of b.other) place(m);
    }
    y += 6;
    const guard = b.guard ? clip(`[${b.guard}]`, 11, frameW - tabWidth - 22, true) : "";
    const elseGuard = b.elseGuard ? clip(`[${b.elseGuard}]`, 11, frameW - 24, true) : "";
    branches.push({
      branch: b,
      x,
      y: top0,
      width: frameW,
      height: y - top0,
      tabWidth,
      guard,
      headWidth: tabWidth + (guard ? 8 + textWidth(guard, 11, true) + 6 : 0),
      elseWidth: textWidth(elseGuard || "[else]", 11, true) + 8,
      dividerY,
      elseGuard,
      elseGuardY,
    });
    y += 8;
  }
  const height = y + 10;
  return {
    width,
    height,
    xs,
    actors,
    messages,
    branches,
    lifelineTop: top,
    lifelineBottom: height - 6,
    geom,
  };
}
