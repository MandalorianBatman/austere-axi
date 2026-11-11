// How a queued review item reads to the agent: the shape `poll` prints. Shared by the
// CLI and the website playground, which shows visitors what their click would send.

/** Where a statement sits in the file: its line and first line of source. */
export interface StatementLocation {
  line?: number;
  source?: string;
}

export type Locate = (id: string | undefined) => StatementLocation;

/** A queued item (annotation, action or render-error), as stored: any field may be missing or malformed. */
export interface FeedbackItem {
  kind?: string;
  target?: string;
  component?: string;
  path?: unknown;
  selection?: string;
  excerpt?: string;
  detail?: unknown;
  note?: string;
  message?: string;
  form?: unknown;
  context?: unknown;
  statement?: string;
  text?: string;
}

/** Where a statement sits, as `describeItem` wants it: its line and first line of source. */
export function locator(lines: ReadonlyMap<string, { line: number; text: string }>): Locate {
  return (id) => {
    const l = id === undefined ? undefined : lines.get(id);
    if (!l) return {};
    const first = l.text.split("\n")[0];
    return { line: l.line, source: first.length > 110 ? first.slice(0, 109) + "…" : first };
  };
}

/** `at` says where a statement sits in the file. */
export function describeItem(it: FeedbackItem, at: Locate): Record<string, unknown> {
  if (it.kind === "annotation") {
    const o: Record<string, unknown> = { annotation: `${it.target} (${it.component})`, ...at(it.target) };
    const within = (Array.isArray(it.path) ? it.path : []).slice(0, -1).filter((p) => typeof p === "string" && p !== "root");
    if (within.length) o.within = within.join(" > ");
    if (it.selection) o.selection = it.selection;
    else if (it.excerpt) o.excerpt = it.excerpt;
    if (it.detail) o.detail = it.detail;
    o.note = it.note || "(no note: the selection itself is the point)";
    return o;
  }
  if (it.kind === "action") {
    const o: Record<string, unknown> = { action: it.message };
    if (it.form) o.form = it.form;
    if (it.context !== undefined) o.context = it.context;
    return o;
  }
  if (it.kind === "render-error") {
    return { render_error: it.statement || "(page)", ...at(it.statement), error: it.message, note: it.note };
  }
  return { message: it.text ?? it.note ?? "" };
}
