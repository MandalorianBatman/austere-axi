// A reviewer's note is untrusted input. Rebuild it from the fields the real annotator and composer
// produce, so nothing else (and nothing of another type) reaches the owner's panel, the hub or the agent.

// Tag characters, bidi controls and zero-width space/LRM/RLM can hide text from the owner that the agent
// still reads. ZWNJ/ZWJ (U+200C/U+200D) stay: emoji and some scripts need them.
const INVISIBLE = /[\u{E0000}-\u{E007F}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v.replace(INVISIBLE, "") : undefined);
// The owner's view shortens target and component, so keep them only when they are what the annotator
// produces: a statement id and a component name. Anything longer or odder could hide text from the owner.
const ID = /^[A-Za-z_$][\w$]{0,99}$/;
const COMPONENT = /^[A-Za-z_][\w.-]{0,99}$/;
const match = (re: RegExp, v: unknown): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);

/** Drop keys whose value is undefined, so a stored item has only the fields that were valid. */
function defined<T extends object>(o: T): T {
  // Same keys minus the undefined ones: every remaining field keeps its type.
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

export type ItemDetail = {
  part?: string;
  row?: string;
  column?: string;
  rowIndex?: number;
};

export type ReviewerMessage = {
  kind: "message";
  text: string;
};

export type ReviewerAnnotation = {
  kind: "annotation";
  target?: string;
  component?: string;
  path?: string[];
  selection?: string;
  excerpt?: string;
  note?: string;
  detail?: ItemDetail;
};

export type ReviewerItem = ReviewerMessage | ReviewerAnnotation;

/** Mirrors `detailOf` in runtime/annotate.ts: string part/row/column and an integer rowIndex. */
function detailOf(d: unknown): ItemDetail | undefined {
  if (!isRecord(d)) return undefined;
  const out: ItemDetail = defined({ part: str(d.part), row: str(d.row), column: str(d.column), rowIndex: typeof d.rowIndex === "number" && Number.isInteger(d.rowIndex) ? d.rowIndex : undefined });
  return Object.keys(out).length ? out : undefined;
}

/** @param x an object whose `kind` is "annotation" or "message" */
export function reviewerItem(x: Record<string, unknown>): ReviewerItem {
  if (x.kind === "message") return { kind: "message", text: str(x.text) ?? "" };
  return defined<ReviewerAnnotation>({
    kind: "annotation",
    target: match(ID, x.target),
    component: match(COMPONENT, x.component),
    path: Array.isArray(x.path) ? x.path.filter((p): p is string => match(ID, p) !== undefined) : undefined,
    selection: str(x.selection),
    excerpt: str(x.excerpt),
    note: str(x.note),
    detail: detailOf(x.detail),
  });
}
