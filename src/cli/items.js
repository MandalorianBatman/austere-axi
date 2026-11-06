// @ts-check
// A reviewer's note is untrusted input. Rebuild it from the fields the real annotator and composer
// produce, so nothing else (and nothing of another type) reaches the owner's panel, the hub or the agent.

const str = (v) => (typeof v === "string" ? v : undefined);

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
    target: str(x.target),
    component: str(x.component),
    path: Array.isArray(x.path) ? x.path.filter((p) => typeof p === "string") : undefined,
    selection: str(x.selection),
    excerpt: str(x.excerpt),
    note: str(x.note),
    detail: detailOf(x.detail),
  });
}
