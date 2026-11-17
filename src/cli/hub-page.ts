// The hub's home page: every page by project, one row per page with a chip per copy; and the Notes view.
import os from "node:os";
import path from "node:path";
import { escapeHtml } from "./artifact.ts";
import { unanswered } from "./hub.ts";
import type { HubCopy, HubNoteRow, HubPage, HubProject, HubViewCounts } from "./hub.ts";

function day(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** `1 page`, `2 pages`. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/** Feedback in the reviewer's terms: answered by the agent or not (yet). */
function counts(a: HubPage): string {
  const waiting = unanswered(a);
  const parts: string[] = [];
  if (waiting) parts.push(`<b class="open">${waiting} unanswered</b>`);
  if (a.addressed) parts.push(`${a.addressed} answered`);
  return parts.join(" · ");
}

/** A long path, shortened in the middle; the full one goes in a title. */
function shortPath(p: string, max = 48): string {
  const t = tilde(p);
  return t.length <= max ? t : `${t.slice(0, 16)}…${t.slice(t.length - (max - 17))}`;
}

const LISTENING = `<em class="live">agent listening</em>`;

/** What is worth saying about one copy beyond its notes: gone, archived, only checked, an agent listening. A quiet copy says nothing. */
function state(c: HubCopy, listening: boolean): string {
  return [c.missing ? `<em class="gone">missing</em>` : "", c.archived_at ? `<em>archived</em>` : "", c.reviewed ? "" : `<em>checked</em>`, listening ? LISTENING : ""].filter(Boolean).join(" · ");
}

/** A label shortened in the middle, so `agent/some-agent/c07769ee1506` keeps its start and its end. */
function shortLabel(label: string, max = 28): string {
  if (label.length <= max) return label;
  const tail = Math.floor((max - 1) / 2);
  return `${label.slice(0, max - 1 - tail)}…${label.slice(label.length - tail)}`;
}

function chip(c: HubCopy, listening: Set<string>): string {
  const waiting = unanswered(c);
  const cls = ["chip", waiting ? "waiting" : "", c.missing ? "gone" : ""].filter(Boolean).join(" ");
  const extra = [waiting ? `${waiting} unanswered` : "", listening.has(c.id) ? "agent listening" : "", c.missing ? "missing" : "", c.archived_at ? "archived" : ""].filter(Boolean);
  return `<a class="${cls}" href="/hub/open/${escapeHtml(c.id)}" title="${escapeHtml(`${c.label} · ${c.file}`)}">${escapeHtml(shortLabel(c.label))}${extra.length ? ` <span>${extra.join(" · ")}</span>` : ""}</a>`;
}

/** How many chips a row shows before "+n more". */
const CHIPS = 3;

/** The chips of a page's copies: the most relevant first (unanswered notes, an agent listening, then newest), the rest behind "+n more". */
function chips(copies: HubCopy[], listening: Set<string>): string {
  const rank = (c: HubCopy): number => (unanswered(c) ? 2 : 0) + (listening.has(c.id) ? 1 : 0);
  const sorted = [...copies].sort((a, b) => rank(b) - rank(a) || b.updated_at - a.updated_at);
  const shown = sorted.slice(0, CHIPS).map((c) => chip(c, listening)).join("");
  const rest = sorted.slice(CHIPS);
  const more = rest.length ? `<details class="more"><summary>+${rest.length} more</summary><div class="chips">${rest.map((c) => chip(c, listening)).join("")}</div></details>` : "";
  return `<div class="chips">${shown}${more}</div>`;
}

function row(p: HubPage, listening: Set<string>): string {
  const only = p.copies.length === 1 ? p.copies[0] : null;
  const gone = p.copies.every((c) => c.missing);
  // The title opens a copy that is still there (the newest such); the newest copy when all are gone.
  const main = p.copies.find((c) => !c.missing) ?? p.copies[0];
  const many = p.copies.some((c) => listening.has(c.id)) ? LISTENING : "";
  const meta = [escapeHtml(p.rel_path), escapeHtml(`${day(p.updated_at)} ${time(p.updated_at)}`), only ? state(only, listening.has(only.id)) : gone ? `<em class="gone">missing</em>` : many, counts(p), only ? "" : plural(p.copies.length, "copy", "copies")].filter(Boolean).join(" · ");
  return `<li><a href="/hub/open/${escapeHtml(main.id)}" title="${escapeHtml(main.file)}">
  <strong>${escapeHtml(p.title || path.posix.basename(p.rel_path))}</strong>
  <span class="meta">${meta}</span>
</a>${only ? "" : chips(p.copies, listening)}</li>`;
}

/** A link to the home page with these query parameters (empty ones dropped). */
function homeLink(params: Record<string, string>): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "")).toString();
  return escapeHtml(qs ? `/?${qs}` : "/");
}

const STYLE = `body{margin:0;background:#0b0b0d;color:#e8e8ec;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between}
h1{font-size:18px;font-weight:600;margin:0}h1 small{color:#77777f;font-weight:400;font-size:13px;margin-left:6px}
.stats{color:#8a8a94;font-size:12.5px}
form{margin:18px 0 8px}input{width:100%;box-sizing:border-box;background:#141417;border:1px solid #2a2a30;border-radius:8px;color:#e8e8ec;padding:9px 12px;font:inherit}
input:focus,select:focus{border-color:#5b6b99}input:focus-visible,select:focus-visible,button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #a9c1ff;outline-offset:2px}
section{margin-top:28px}h2{font-size:15px;font-weight:600;margin:0 0 4px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
h2 a{color:#e8e8ec;text-decoration:none}h2 small{color:#8a8a94;font-weight:400;font-size:12px;overflow-wrap:anywhere}
p.same{color:#8a8a94;font-size:12.5px;margin:0 0 4px;overflow-wrap:anywhere}p.same code{color:#e8e8ec}
ul{list-style:none;padding:0;margin:0}li{border-bottom:1px solid #1c1c20}
li>a{display:grid;gap:2px;padding:10px 0;min-height:28px;text-decoration:none;color:inherit}
li strong{color:#a9c1ff;font-weight:600;overflow-wrap:anywhere}li>a:hover strong{text-decoration:underline}
.meta{color:#8a8a94;font-size:12px;overflow-wrap:anywhere}em{font-style:normal}em.live{color:#8fd19e}em.gone{color:#e38b8b}
b{font-weight:600}b.open{color:#f2c46d;font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 10px}
.chip{display:inline-flex;flex-wrap:wrap;align-items:center;column-gap:6px;min-height:26px;max-width:100%;box-sizing:border-box;padding:3px 10px;border:1px solid #2a2a30;border-radius:999px;color:#c9c9d1;font-size:12px;text-decoration:none;overflow-wrap:anywhere}
.chip:hover{border-color:#5b6b99}.chip span{color:#8a8a94;white-space:nowrap}.chip.waiting{border-color:#6b5420}.chip.waiting span{color:#f2c46d}.chip.gone{color:#8a8a94}
details.more>summary{display:inline-flex;align-items:center;min-height:26px;box-sizing:border-box;padding:3px 10px;border:1px dashed #2a2a30;border-radius:999px;color:#a9c1ff;font-size:12px;cursor:pointer;list-style:none}details.more>summary::-webkit-details-marker{display:none}
details.more[open]{flex-basis:100%}details.more[open]>summary{display:none}details.more>.chips{margin:0}
.filter{color:#8a8a94;font-size:12.5px}.filter a{color:#a9c1ff}.empty{color:#8a8a94;margin-top:28px}
.nav{display:flex;gap:14px;font-size:13px}.nav a{color:#a9c1ff;text-decoration:none}
form.f{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}button{background:#1c1c20;border:1px solid #2a2a30;border-radius:8px;color:#e8e8ec;padding:9px 12px;font:inherit}select{background:#141417;border:1px solid #2a2a30;border-radius:8px;color:#e8e8ec;padding:9px 12px;font:inherit;width:100%;box-sizing:border-box}
.note{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.note-t{color:#8a8a94;font-size:12px}.st{font-size:12px}.st.waiting{color:#f2c46d}.st.done{color:#8fd19e}
li.n{padding:12px 0}li.n>a{padding:0}
b.by{color:#e8e8ec}
@media(min-width:600px){form.f{grid-template-columns:minmax(0,1fr) 150px auto}form.f.p{grid-template-columns:minmax(0,1fr) 150px 150px auto}}
`;

/** Which copies the home page lists: the default (opened for review, not archived), archived ones, or all. */
export type HubView = "default" | "archived" | "all";

const VIEWS = [
  ["default", "Open", "open"],
  ["all", "Everything", "everything"],
  ["archived", "Archived", "archived"],
] as const;

/**
 * The home page: one section per project, one row per page inside it, a chip per copy when a page
 * has several. The order is Hub.list()'s: projects by newest activity; pages with unanswered notes
 * first, then by last activity.
 * The header, the views and the empty state count the view shown, not the whole index.
 * @param pages Hub.list() pages
 * @param counts Hub.viewCounts() for the same search and project
 * @param listening ids of the copies an agent is polling for
 */
export function hubPage(
  pages: HubPage[],
  {
    version,
    q,
    project,
    projectName = project,
    view = "default",
    projects = [],
    counts,
    listening = new Set(),
  }: { version: string; q: string; project: string; projectName?: string; view?: HubView; projects?: HubProject[]; counts: HubViewCounts; listening?: Set<string> },
): string {
  const byProject = new Map<string, HubPage[]>();
  for (const p of pages) {
    let list = byProject.get(p.project_id);
    if (!list) byProject.set(p.project_id, (list = []));
    list.push(p);
  }
  const info = new Map(projects.map((p) => [p.id, p]));
  const sections = [...byProject.entries()]
    .map(([id, list]) => {
      const roots = info.get(id)?.roots || [];
      const same = info.get(id)?.sameAs;
      const name = list[0].project;
      const waiting = list.reduce((n, p) => n + unanswered(p), 0);
      const where = roots.length ? `${shortPath(roots[0])}${roots.length > 1 ? ` · +${roots.length - 1} more ${roots.length === 2 ? "folder" : "folders"}` : ""}` : "";
      // A hint only: the owner merges two clones of one repository, or keeps them apart.
      const hint = same ? `<p class="same">Same repository as project ${escapeHtml(same.name)}: <code>austere-axi ${escapeHtml(same.merge)}</code></p>` : "";
      return `<section><h2><a href="${homeLink({ project: id, [view]: view === "default" ? "" : "1" })}">${escapeHtml(name)}</a>${
        where ? ` <small title="${escapeHtml(roots.join("\n"))}">${escapeHtml(where)}</small>` : ""
      }${waiting ? ` <b class="open">${waiting} unanswered</b>` : ""}</h2>${hint}<ul>${list.map((p) => row(p, listening)).join("")}</ul></section>`;
    })
    .join("");
  const viewLink = (v: HubView, text: string): string => `<a href="${homeLink({ project, q, [v]: v === "default" ? "" : "1" })}">${text}</a>`;
  const views = VIEWS.map(([v, label, n]) => (v === view ? `<b>${label} (${counts[n]})</b>` : viewLink(v, `${label} (${counts[n]})`))).join(" · ");
  const filter = `<p class="filter">${views}${project ? ` · Project ${escapeHtml(tilde(projectName))} · <a href="${homeLink({ q, [view]: view === "default" ? "" : "1" })}">all projects</a>` : ""}</p>`;
  const otherViews = VIEWS.filter(([v, , n]) => v !== view && counts[n] > 0).map(([v, label, n]) => viewLink(v, `${label} (${counts[n]})`));
  let empty: string;
  if (counts.everything === 0 && !q && !project) empty = "No pages yet. Open one for review with austere-axi and it shows up here.";
  else if (q || project) empty = `Nothing matches${view === "all" ? "" : ` in ${VIEWS.find(([v]) => v === view)?.[1]}`}.${otherViews.length ? ` Also matches: ${otherViews.join(" · ")}.` : ""}`;
  else if (view === "archived") empty = `No archived pages.${otherViews.length ? ` See: ${otherViews.join(" · ")}.` : ""}`;
  else {
    const parts = ["Nothing is open for review."];
    if (counts.checked) parts.push(`${plural(counts.checked, "page was", "pages were")} checked but never opened: ${viewLink("all", "show them")}.`);
    if (counts.archived) parts.push(`${counts.archived} archived: ${viewLink("archived", "show")}.`);
    empty = parts.join(" ");
  }
  const projectCount = byProject.size;
  const waitingAll = pages.reduce((n, p) => n + unanswered(p), 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>austere-axi hub</title><meta name="color-scheme" content="dark">
<style>
${STYLE}
</style></head>
<body><main>
<header><h1>austere-axi hub<small>${escapeHtml(version)}</small></h1><nav class="nav"><a href="/">Pages</a><a href="/notes">Notes</a></nav><span class="stats">${plural(pages.length, "page")} · ${plural(projectCount, "project")}${
    waitingAll ? ` · ${waitingAll} unanswered` : ""
  }</span></header>
<form method="get" action="/">${project ? `<input type="hidden" name="project" value="${escapeHtml(project)}">` : ""}${
    view === "default" ? "" : `<input type="hidden" name="${view}" value="1">`
  }<input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search titles, paths, projects" aria-label="Search"></form>
${filter}${sections || `<p class="empty">${empty}</p>`}
</main></body></html>`;
}

const STATUS_LABEL: Record<string, string | undefined> = { open: "unanswered", received: "unanswered", addressed: "answered", held: "held for the owner" };

/**
 * The Notes view: every note across pages, newest first, with its project and copy.
 * @param rows Hub.notes() rows
 */
export function notesPage(
  rows: Omit<HubNoteRow, "kind">[],
  {
    version,
    q,
    project,
    projectName = project,
    status,
    author = "",
    authors = [],
    device = null,
  }: { version: string; q: string; project: string; projectName?: string; status: string; author?: string; authors?: string[]; device?: { id: string; name: string } | null },
): string {
  const items = rows
    .map((n) => {
      const waiting = n.status !== "addressed";
      const when = `${day(n.at)} ${time(n.at)}`;
      const where = n.label && n.label !== n.project ? `${n.project} · ${n.label}` : n.project;
      return `<li class="n"><a href="/hub/open/${escapeHtml(n.artifact_id)}" title="${escapeHtml(n.file)}">
  <p class="note">${escapeHtml(n.text || "(no text)")}</p>
  <span class="note-t">${n.author ? `<b class="by">${escapeHtml(n.author)}</b> · ` : ""}${n.remote ? "hosted page · " : ""}${n.target ? `on ${escapeHtml(n.target)} · ` : ""}<strong>${escapeHtml(n.title || path.basename(n.file))}</strong> · ${escapeHtml(where)} · ${escapeHtml(when)} · <span class="st ${waiting ? "waiting" : "done"}">${STATUS_LABEL[n.status] || escapeHtml(n.status)}</span></span>
</a></li>`;
    })
    .join("");
  const opt = (v: string, label: string): string => `<option value="${v}"${status === v ? " selected" : ""}>${label}</option>`;
  const people = authors.length
    ? `<select name="author" aria-label="Author"><option value="">Everyone</option><option value="owner"${author === "owner" ? " selected" : ""}>Owner</option>${authors
        .map((a) => `<option value="${escapeHtml(a)}"${author === a ? " selected" : ""}>${escapeHtml(a)}</option>`)
        .join("")}</select>`
    : "";
  const filter =
    (project ? `<p class="filter">Project ${escapeHtml(tilde(projectName))} · <a href="/notes">all projects</a></p>` : "") +
    (device ? `<p class="filter">Device ${escapeHtml(device.name)} (${escapeHtml(device.id)}) · <a href="/notes">everyone</a></p>` : "");
  const empty = q || project || author || device || status !== "all" ? "No notes match." : "No notes yet.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes · austere-axi hub</title><meta name="color-scheme" content="dark">
<style>
${STYLE}</style></head>
<body><main>
<header><h1>austere-axi hub<small>${escapeHtml(version)}</small></h1><nav class="nav"><a href="/">Pages</a><a href="/notes">Notes</a></nav><span class="stats">${plural(rows.length, "note")}${
    rows.some((n) => n.status !== "addressed") ? ` · ${rows.filter((n) => n.status !== "addressed").length} unanswered` : ""
  }</span></header>
<form class="f${authors.length ? " p" : ""}" method="get" action="/notes">${project ? `<input type="hidden" name="project" value="${escapeHtml(project)}">` : ""}${device ? `<input type="hidden" name="device" value="${escapeHtml(device.id)}">` : ""}<input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search notes, targets, page titles" aria-label="Search notes"><select name="status" aria-label="Status">${opt("all", "All")}${opt("unanswered", "Unanswered")}${opt("answered", "Answered")}</select>${people}<button type="submit">Filter</button></form>
${filter}${items ? `<ul>${items}</ul>` : `<p class="empty">${empty}</p>`}
</main></body></html>`;
}

/**
 * What a link to a copy whose file is gone opens: where it was, the notes it still holds, and a button to put it away.
 * An archived copy has nothing left to do, so it gets no button. The copy's id goes in the form action; the server checks it.
 * @param notes Hub.notes() rows of this copy
 */
export function missingPage(
  copy: { id: string; file: string; title: string | null; archived_at: number | null; updated_at: number },
  { version, project, label, notes }: { version: string; project: string; label: string; notes: Omit<HubNoteRow, "kind">[] },
): string {
  const rows = notes
    .map((n) => {
      const waiting = n.status !== "addressed";
      return `<li class="n"><p class="note">${escapeHtml(n.text || "(no text)")}</p>
  <span class="note-t">${n.author ? `<b class="by">${escapeHtml(n.author)}</b> · ` : ""}${n.target ? `on ${escapeHtml(n.target)} · ` : ""}${escapeHtml(`${day(n.at)} ${time(n.at)}`)} · <span class="st ${waiting ? "waiting" : "done"}">${STATUS_LABEL[n.status] || escapeHtml(n.status)}</span></span></li>`;
    })
    .join("");
  const where = label && label !== project ? `${project} · ${label}` : project;
  const action = copy.archived_at
    ? `<p class="meta">Archived ${escapeHtml(`${day(copy.archived_at)} ${time(copy.archived_at)}`)}. The hub's lists leave it out; its notes are kept.</p>`
    : `<form method="post" action="/hub/archive/${escapeHtml(copy.id)}"><button type="submit">Archive this copy</button></form><p class="meta">Archiving leaves it out of the hub's lists. Its notes are kept.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>File missing · austere-axi hub</title><meta name="color-scheme" content="dark">
<style>
${STYLE}</style></head>
<body><main>
<header><h1>austere-axi hub<small>${escapeHtml(version)}</small></h1><nav class="nav"><a href="/">Pages</a><a href="/notes">Notes</a></nav></header>
<section>
<h2>${escapeHtml(copy.title || path.basename(copy.file))} <small><em class="gone">file missing</em></small></h2>
<p class="meta">${escapeHtml(where)} · last activity ${escapeHtml(`${day(copy.updated_at)} ${time(copy.updated_at)}`)}</p>
<p>This copy's file is no longer on this machine:</p>
<p class="meta" title="${escapeHtml(copy.file)}">${escapeHtml(tilde(copy.file))}</p>
${action}
</section>
<section>
<h2>Notes <small>${notes.length ? `${notes.length} kept` : "none"}</small></h2>
${rows ? `<ul>${rows}</ul>` : `<p class="empty">No notes on this copy.</p>`}
</section>
</main></body></html>`;
}
