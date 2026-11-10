// @ts-check
// A reviewer's note is untrusted input. Rebuild it from the fields the real annotator and composer
// produce, so nothing else (and nothing of another type) reaches the owner's panel, the hub or the agent.

// Tag characters, bidi controls and zero-width space/LRM/RLM can hide text from the owner that the agent
// still reads. ZWNJ/ZWJ (U+200C/U+200D) stay: emoji and some scripts need them.
const INVISIBLE = /[\u{E0000}-\u{E007F}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const str = (v) => (typeof v === "string" ? v.replace(INVISIBLE, "") : undefined);
// The owner's view shortens target and component, so keep them only when they are what the annotator
// produces: a statement id and a component name. Anything longer or odder could hide text from the owner.
const ID = /^[A-Za-z_$][\w$]{0,99}$/;
const COMPONENT = /^[A-Za-z_][\w.-]{0,99}$/;
const match = (re, v) => (typeof v === "string" && re.test(v) ? v : undefined);

/** Drop keys whose value is undefined, so a stored item has only the fields that were valid. */
function defined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Mirrors `detailOf` in runtime/annotate.js: string part/row/column and an integer rowIndex. */
function detailOf(d) {
  if (!d || typeof d !== "object") return undefined;
  const out = defined({ part: str(d.part), row: str(d.row), column: str(d.column), rowIndex: Number.isInteger(d.rowIndex) ? d.rowIndex : undefined });
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {Record<string, any>} x an object whose `kind` is "annotation" or "message"
 * @returns {Record<string, any>}
 */
export function reviewerItem(x) {
  if (x.kind === "message") return { kind: "message", text: str(x.text) ?? "" };
  return defined({
    kind: "annotation",
    target: match(ID, x.target),
    component: match(COMPONENT, x.component),
    path: Array.isArray(x.path) ? x.path.filter((p) => match(ID, p) !== undefined) : undefined,
    selection: str(x.selection),
    excerpt: str(x.excerpt),
    note: str(x.note),
    detail: detailOf(x.detail),
  });
}
