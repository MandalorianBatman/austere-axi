// @ts-check
// How a queued review item reads to the agent: the shape `poll` prints. Shared by the
// CLI and the website playground, which shows visitors what their click would send.

/**
 * Where a statement sits, as `describeItem` wants it: its line and first line of source.
 * @param {Map<string, { line: number, text: string }>} lines
 * @returns {(id: string) => { line?: number, source?: string }}
 */
export function locator(lines) {
  return (id) => {
    const l = lines.get(id);
    if (!l) return {};
    const first = l.text.split("\n")[0];
    return { line: l.line, source: first.length > 110 ? first.slice(0, 109) + "…" : first };
  };
}

/**
 * @param {Record<string, any>} it a queued item (annotation, action or render-error)
 * @param {(id: string) => { line?: number, source?: string }} at where a statement sits in the file
 */
export function describeItem(it, at) {
  if (it.kind === "annotation") {
    /** @type {Record<string, any>} */
    const o = { annotation: `${it.target} (${it.component})`, ...at(it.target) };
    const within = (it.path || []).slice(0, -1).filter((p) => p !== "root");
    if (within.length) o.within = within.join(" > ");
    if (it.selection) o.selection = it.selection;
    else if (it.excerpt) o.excerpt = it.excerpt;
    if (it.detail) o.detail = it.detail;
    o.note = it.note || "(no note: the selection itself is the point)";
    return o;
  }
  if (it.kind === "action") {
    /** @type {Record<string, any>} */
    const o = { action: it.message };
    if (it.form) o.form = it.form;
    if (it.context !== undefined) o.context = it.context;
    return o;
  }
  if (it.kind === "render-error") {
    return { render_error: it.statement || "(page)", ...at(it.statement), error: it.message, note: it.note };
  }
  return { message: it.text ?? it.note ?? "" };
}
