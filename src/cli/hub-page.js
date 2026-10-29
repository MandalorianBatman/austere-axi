// The hub's home page: every artifact by project, then by day.
import os from "node:os";
import path from "node:path";
import { escapeHtml } from "./artifact.js";

function day(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function time(ms) {
  return new Date(ms).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function tilde(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/** Feedback in the reviewer's terms: answered by the agent or not (yet). */
function counts(a) {
  const waiting = a.open + a.received;
  const parts = [];
  if (waiting) parts.push(`<b class="open">${waiting} unanswered</b>`);
  if (a.addressed) parts.push(`${a.addressed} answered`);
  return parts.join(" · ");
}

/** A long path, shortened in the middle; the full one goes in a title. */
function shortPath(p, max = 48) {
  const t = tilde(p);
  return t.length <= max ? t : `${t.slice(0, 16)}…${t.slice(t.length - (max - 17))}`;
}

function state(a) {
  if (!a.reviewed) return `<em>checked</em>`;
  if (a.status === "ended") return `<em>ended${a.ended_by ? ` by ${escapeHtml(a.ended_by)}` : ""}</em>`;
  return `<em class="live">in review</em>`;
}

/**
 * @param {object[]} rows   Hub.list() rows
 * @param {{ version: string, q: string, project: string, stats: object }} o
 */
export function hubPage(rows, { version, q, project, stats }) {
  const byProject = new Map();
  for (const r of rows) {
    if (!byProject.has(r.project)) byProject.set(r.project, []);
    byProject.get(r.project).push(r);
  }
  const sections = [...byProject.entries()]
    .map(([proj, list]) => {
      const days = new Map();
      for (const r of list) {
        const k = day(r.updated_at);
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(r);
      }
      const body = [...days.entries()]
        .map(
          ([d, items]) =>
            `<h3>${escapeHtml(d)}</h3><ul>${items
              .map(
                (a) => `<li><a href="/hub/open/${a.id}" title="${escapeHtml(a.file)}">
  <strong>${escapeHtml(a.title || path.basename(a.file))}</strong>
  <span class="meta">${escapeHtml(path.relative(proj, a.file) || path.basename(a.file))} · ${time(a.updated_at)} · ${state(a)}${
    counts(a) ? ` · ${counts(a)}` : ""
  }</span>
</a></li>`,
              )
              .join("")}</ul>`,
        )
        .join("");
      const unanswered = list.reduce((n, a) => n + a.open + a.received, 0);
      return `<section><h2><a href="/?project=${encodeURIComponent(proj)}">${escapeHtml(path.basename(proj) || proj)}</a> <small title="${escapeHtml(proj)}">${escapeHtml(
        shortPath(proj),
      )}</small>${unanswered ? ` <b class="open">${unanswered} unanswered</b>` : ""}</h2>${body}</section>`;
    })
    .join("");
  const filter = project ? `<p class="filter">Project ${escapeHtml(tilde(project))} · <a href="/">all projects</a></p>` : "";
  const empty = q || project ? "Nothing matches." : "No artifacts yet. Open or check one with austere-axi and it shows up here.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>austere-axi hub</title><meta name="color-scheme" content="dark">
<style>
body{margin:0;background:#0b0b0d;color:#e8e8ec;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between}
h1{font-size:18px;font-weight:600;margin:0}h1 small{color:#77777f;font-weight:400;font-size:13px;margin-left:6px}
.stats{color:#8a8a94;font-size:12.5px}
form{margin:18px 0 8px}input{width:100%;box-sizing:border-box;background:#141417;border:1px solid #2a2a30;border-radius:8px;color:#e8e8ec;padding:9px 12px;font:inherit}
input:focus{outline:none;border-color:#5b6b99}
section{margin-top:28px}h2{font-size:15px;font-weight:600;margin:0 0 4px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
h2 a{color:#e8e8ec;text-decoration:none}h2 small{color:#8a8a94;font-weight:400;font-size:12px;overflow-wrap:anywhere}
h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#8a8a94;font-weight:600;margin:14px 0 2px}
ul{list-style:none;padding:0;margin:0}li{border-bottom:1px solid #1c1c20}
li>a{display:grid;gap:2px;padding:10px 0;min-height:28px;text-decoration:none;color:inherit}
li strong{color:#a9c1ff;font-weight:600;overflow-wrap:anywhere}li>a:hover strong{text-decoration:underline}
.meta{color:#8a8a94;font-size:12px;overflow-wrap:anywhere}em{font-style:normal}em.live{color:#8fd19e}
b{font-weight:600}b.open{color:#f2c46d;font-size:12px}
.filter{color:#8a8a94;font-size:12.5px}.filter a{color:#a9c1ff}.empty{color:#8a8a94;margin-top:28px}
</style></head>
<body><main>
<header><h1>austere-axi hub<small>${escapeHtml(version)}</small></h1><span class="stats">${stats.artifacts} artifacts · ${stats.projects} projects${
    stats.unanswered ? ` · ${stats.unanswered} unanswered` : ""
  }</span></header>
<form method="get" action="/">${project ? `<input type="hidden" name="project" value="${escapeHtml(project)}">` : ""}<input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search titles, files, projects" aria-label="Search"></form>
${filter}${sections || `<p class="empty">${empty}</p>`}
</main></body></html>`;
}
