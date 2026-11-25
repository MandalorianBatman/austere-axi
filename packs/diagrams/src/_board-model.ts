// Kanban, StoryMap, UserJourney, ServiceBlueprint and EventModel: parsed props → one board
// (columns across, optional labelled rows down, cards in the cells). Pure TypeScript (no JSX),
// so Node tests can import it. The five types differ only in what the columns and rows mean and
// in a few extras (a WIP chip, a release cut, a sentiment curve, the line of visibility).
import { isElement } from "./element.ts";

export const CARD_STATES = ["blocked", "waiting", "done", "risk", "focus"] as const;
export type CardState = (typeof CARD_STATES)[number];

export type BoardKind = "kanban" | "storymap" | "journey" | "blueprint" | "event";

export interface BoardCard {
  /** The statement name; "#card0" and so on for an inline (unnamed) card. */
  id: string;
  named: boolean;
  title: string;
  /** The line under the title: a ticket, a system, a touchpoint. */
  detail: string;
  state: CardState | "";
  /** The row's key, for the colour of a layer or lane. "" when the board has one row. */
  kind: string;
  col: number;
  row: number;
  /** UserJourney: friction at this stage. */
  pain: string;
  /** UserJourney: where the sentiment curve passes this card (0 = top), and where it meets its neighbours. */
  curve: { score: number; y: number; left: number | null; right: number | null } | null;
  /** UserJourney: the lowest-scoring stage. */
  trough: boolean;
}

export interface BoardColumn {
  label: string;
  /** Kanban: "2/3", or "2" with no limit. */
  chip: string;
  over: boolean;
}

export interface BoardRow {
  label: string;
  key: string;
}

/** A rule between two rows (the release cut, the line of visibility). */
export interface BoardLine {
  /** Drawn under row `after`. */
  after: number;
  kind: "cut" | "visibility" | "interaction";
  label: string;
}

export interface Board {
  kind: BoardKind;
  columns: BoardColumn[];
  rows: BoardRow[];
  /** True when the rows carry labels (a left margin). */
  labelled: boolean;
  lines: BoardLine[];
  cards: BoardCard[];
  problems: string[];
  /** Natural width in px, so the frame shrinks to a legible scale and then scrolls. */
  width: number;
  gap: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const key = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The non-empty strings of a list, trimmed, a repeat dropped. */
export function names(v: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of Array.isArray(v) ? v : []) {
    const text = str(item).trim().replace(/\s+/g, " ");
    if (!text || seen.has(key(text))) continue;
    seen.add(key(text));
    out.push(text);
  }
  return out;
}

interface Axis {
  key: string;
  label: string;
}

interface Draft {
  id: string;
  named: boolean;
  title: string;
  detail: string;
  state: CardState | "";
  col: string;
  row: string;
  pain: string;
  score: number | null;
}

type Fields = Omit<Draft, "id" | "named">;

/** Cards in list order. A card listed twice is drawn once. */
function collect(
  list: unknown,
  part: string,
  component: string,
  problems: string[],
  read: (props: Record<string, unknown>) => Fields,
): Draft[] {
  const out: Draft[] = [];
  const seen = new Set<unknown>();
  const ids = new Set<string>();
  let anon = 0;
  for (const el of Array.isArray(list) ? list : []) {
    if (!isElement<Record<string, unknown>>(el)) continue;
    const statementId =
      "statementId" in el && typeof el.statementId === "string" ? el.statementId : "";
    // Statement names are identifiers: "#" cannot collide with one.
    const id = statementId || `#card${anon++}`;
    if (seen.has(el) || ids.has(id)) {
      problems.push(`${part} ${id} is listed twice in ${component}. It is drawn once.`);
      continue;
    }
    seen.add(el);
    ids.add(id);
    out.push({ id, named: !!statementId, ...read(el.props) });
  }
  return out;
}

const stateOf = (v: unknown): CardState | "" => CARD_STATES.find((s) => s === v) ?? "";

function scoreOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null;
}

interface Place {
  component: string;
  part: string;
  /** What a column is called, for messages: column, stage, activity. */
  colWord: string;
  rowWord: string;
  columns: Axis[];
  rows: Axis[];
  /** Rows come from a fixed list: a card cannot name another. */
  fixedRows: boolean;
  drafts: Draft[];
  problems: string[];
}

/** Put each card in its cell. A card that names a column or row that does not exist adds one, and says so. */
function place(o: Place): { columns: Axis[]; rows: Axis[]; cards: BoardCard[] } {
  const columns = [...o.columns];
  const rows = o.rows.length ? [...o.rows] : [{ key: "", label: "" }];
  const cards: BoardCard[] = [];
  const find = (axis: Axis[], k: string, label: string, word: string, of: string): number => {
    const at = axis.findIndex((a) => a.key === k);
    if (at >= 0) return at;
    axis.push({ key: k, label });
    o.problems.push(
      `${o.part} "${of}" has ${word} "${label}", which ${o.component} does not list. It is added as the last ${word}.`,
    );
    return axis.length - 1;
  };
  for (const d of o.drafts) {
    const col = find(columns, key(d.col), d.col.trim(), o.colWord, d.title.trim() || d.id);
    // A card with no row goes in the first row; a row it names must exist.
    const rowKey = key(d.row);
    const row = rowKey
      ? o.fixedRows
        ? Math.max(
            0,
            rows.findIndex((r) => r.key === rowKey),
          )
        : find(rows, rowKey, d.row.trim(), o.rowWord, d.title.trim() || d.id)
      : 0;
    cards.push({
      id: d.id,
      named: d.named,
      title: d.title.trim() || d.id,
      detail: d.detail.trim(),
      state: d.state,
      kind: rows[row].key,
      col,
      row,
      pain: d.pain.trim(),
      curve: null,
      trough: false,
    });
  }
  return { columns, rows, cards };
}

const GAP = 12;
const LABEL_WIDTH = 120;
const MIN_COLUMN: Record<BoardKind, number> = {
  kanban: 220,
  storymap: 200,
  journey: 190,
  blueprint: 190,
  event: 190,
};

function finish(
  kind: BoardKind,
  columns: Axis[],
  rows: Axis[],
  cards: BoardCard[],
  problems: string[],
  lines: BoardLine[] = [],
  chips: Pick<BoardColumn, "chip" | "over">[] = [],
): Board {
  const labelled = rows.some((r) => r.label);
  const gap = kind === "journey" ? 0 : GAP;
  return {
    kind,
    columns: columns.map((c, i) => ({
      label: c.label,
      chip: chips[i]?.chip ?? "",
      over: chips[i]?.over ?? false,
    })),
    rows: rows.map((r) => ({ label: r.label, key: r.key })),
    labelled,
    lines,
    cards,
    problems,
    width:
      (labelled ? LABEL_WIDTH + GAP : 0) +
      columns.length * MIN_COLUMN[kind] +
      Math.max(0, columns.length - 1) * gap,
    gap,
  };
}

const axisOf = (list: string[]): Axis[] => list.map((label) => ({ key: key(label), label }));

/** Kanban(columns, cards, limits?): columns by state, a WIP count on each. */
export function buildKanban(props: Record<string, unknown> | undefined): Board {
  const problems: string[] = [];
  const drafts = collect(props?.cards, "KanbanCard", "Kanban", problems, (p) => ({
    title: str(p.title),
    detail: str(p.detail),
    state: stateOf(p.state) === "risk" || stateOf(p.state) === "focus" ? "" : stateOf(p.state),
    col: str(p.column),
    row: "",
    pain: "",
    score: null,
  }));
  const named = names(props?.columns);
  const placed = place({
    component: "Kanban",
    part: "KanbanCard",
    colWord: "column",
    rowWord: "row",
    columns: axisOf(named),
    rows: [],
    fixedRows: false,
    drafts,
    problems,
  });
  const limits = Array.isArray(props?.limits) ? props.limits : [];
  const chips = placed.columns.map((_, i) => {
    const n = placed.cards.filter((c) => c.col === i).length;
    const limit = typeof limits[i] === "number" && limits[i] > 0 ? Math.floor(limits[i]) : 0;
    return { chip: limit ? `${n}/${limit}` : `${n}`, over: limit > 0 && n > limit };
  });
  return finish("kanban", placed.columns, placed.rows, placed.cards, problems, [], chips);
}

/** StoryMap(activities, stories, slices?, cut?): narrative order across, release slices down. */
export function buildStoryMap(props: Record<string, unknown> | undefined): Board {
  const problems: string[] = [];
  const slices = names(props?.slices);
  const drafts = collect(props?.stories, "Story", "StoryMap", problems, (p) => ({
    title: str(p.title),
    detail: str(p.detail),
    state: p.risk === true ? "risk" : "",
    col: str(p.activity),
    row: str(p.slice),
    pain: "",
    score: null,
  }));
  if (!slices.length) {
    problems.push(
      "StoryMap has no slices, so it has no release cut. Pass the slices, first release first.",
    );
  }
  const placed = place({
    component: "StoryMap",
    part: "Story",
    colWord: "activity",
    rowWord: "slice",
    columns: axisOf(names(props?.activities)),
    rows: axisOf(slices),
    fixedRows: false,
    drafts,
    problems,
  });
  // The cut runs under the first `cut` slices (one by default), when something lies below it.
  const asked = typeof props?.cut === "number" && Number.isFinite(props.cut) ? props.cut : 1;
  const cut = Math.max(0, Math.floor(asked));
  const lines: BoardLine[] =
    slices.length && cut > 0 && cut < placed.rows.length
      ? [{ after: cut - 1, kind: "cut", label: "Release cut" }]
      : [];
  return finish("storymap", placed.columns, placed.rows, placed.cards, problems, lines);
}

/** UserJourney(stages, steps, persona?): what the person does at each stage, and the curve of how it feels. */
export function buildJourney(props: Record<string, unknown> | undefined): Board {
  const problems: string[] = [];
  const drafts = collect(props?.steps, "JourneyStep", "UserJourney", problems, (p) => ({
    title: str(p.action),
    detail: str(p.touchpoint),
    state: "",
    col: str(p.stage),
    row: "",
    pain: str(p.pain),
    score: scoreOf(p.score),
  }));
  const placed = place({
    component: "UserJourney",
    part: "JourneyStep",
    colWord: "stage",
    rowWord: "row",
    columns: axisOf(names(props?.stages)),
    rows: [],
    fixedRows: false,
    drafts,
    problems,
  });
  // The first scored card of a stage carries its point on the curve.
  const lead = new Map<number, { card: BoardCard; score: number }>();
  placed.cards.forEach((card, i) => {
    const score = drafts[i].score;
    if (score !== null && !lead.has(card.col)) lead.set(card.col, { card, score });
  });
  const yOf = (score: number) => (5 - score) / 4;
  const mid = (a: number, b: number) => (yOf(a) + yOf(b)) / 2;
  for (const [col, { card, score }] of lead) {
    const before = lead.get(col - 1);
    const after = lead.get(col + 1);
    card.curve = {
      score,
      y: yOf(score),
      left: before ? mid(before.score, score) : null,
      right: after ? mid(score, after.score) : null,
    };
  }
  const all = [...lead.values()];
  const low = Math.min(...all.map((p) => p.score));
  if (all.length > 1 && low < Math.max(...all.map((p) => p.score))) {
    const trough = all.find((p) => p.score === low);
    if (trough) trough.card.trough = true;
  }
  placed.columns.forEach((c, i) => {
    if (!lead.has(i)) problems.push(`Stage "${c.label}" has no score, so the curve breaks there.`);
  });
  return finish("journey", placed.columns, placed.rows, placed.cards, problems);
}

export const LAYERS = ["evidence", "customer", "frontstage", "backstage", "support"] as const;
export type Layer = (typeof LAYERS)[number];

const LAYER_LABELS: Record<Layer, string> = {
  evidence: "Physical evidence",
  customer: "Customer actions",
  frontstage: "Frontstage",
  backstage: "Backstage",
  support: "Support processes",
};

/** ServiceBlueprint(stages, steps): stages across, the four layers down, the line of visibility between front and back. */
export function buildBlueprint(props: Record<string, unknown> | undefined): Board {
  const problems: string[] = [];
  const drafts = collect(props?.steps, "BlueprintStep", "ServiceBlueprint", problems, (p) => ({
    title: str(p.action),
    detail: str(p.detail),
    state: p.focus === true ? "focus" : "",
    col: str(p.stage),
    row: str(p.layer),
    pain: "",
    score: null,
  }));
  const used = new Set(drafts.map((d) => key(d.row)));
  const present = LAYERS.filter(
    (l) => ["customer", "frontstage", "backstage"].includes(l) || used.has(l),
  );
  for (const d of drafts) {
    if (d.row && !LAYERS.some((l) => l === key(d.row))) {
      problems.push(
        `BlueprintStep "${d.title.trim() || d.id}" has layer "${d.row.trim()}". Use ${LAYERS.join(", ")}. It is drawn in the first row.`,
      );
    }
  }
  const placed = place({
    component: "ServiceBlueprint",
    part: "BlueprintStep",
    colWord: "stage",
    rowWord: "layer",
    columns: axisOf(names(props?.stages)),
    rows: present.map((l) => ({ key: l, label: LAYER_LABELS[l] })),
    fixedRows: true,
    drafts,
    problems,
  });
  const at = (l: Layer) => present.indexOf(l);
  const lines: BoardLine[] = [
    { after: at("customer"), kind: "interaction", label: "Line of interaction" },
    { after: at("frontstage"), kind: "visibility", label: "Line of visibility" },
  ];
  if (at("support") >= 0) {
    lines.push({
      after: at("backstage"),
      kind: "interaction",
      label: "Line of internal interaction",
    });
  }
  return finish("blueprint", placed.columns, placed.rows, placed.cards, problems, lines);
}

export const EVENT_KINDS = ["command", "event", "read-model"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const EVENT_LABELS: Record<EventKind, string> = {
  command: "Command",
  event: "Event",
  "read-model": "Read model",
};

/** EventModel(stages, items): ordered stages across; commands, events and read models in their rows. */
export function buildEventModel(props: Record<string, unknown> | undefined): Board {
  const problems: string[] = [];
  const drafts = collect(props?.items, "EventItem", "EventModel", problems, (p) => ({
    title: str(p.name),
    detail: str(p.detail),
    state: "",
    col: str(p.stage),
    row: str(p.kind).replace(/[\s_]+/g, "-"),
    pain: "",
    score: null,
  }));
  for (const d of drafts) {
    if (!EVENT_KINDS.some((k) => k === key(d.row))) {
      problems.push(
        `EventItem "${d.title.trim() || d.id}" has kind "${d.row.trim()}". Use ${EVENT_KINDS.join(", ")}. It is drawn in the first row.`,
      );
    }
  }
  const placed = place({
    component: "EventModel",
    part: "EventItem",
    colWord: "stage",
    rowWord: "kind",
    columns: axisOf(names(props?.stages)),
    rows: EVENT_KINDS.map((k) => ({ key: k, label: EVENT_LABELS[k] })),
    fixedRows: true,
    drafts,
    problems,
  });
  return finish("event", placed.columns, placed.rows, placed.cards, problems);
}
