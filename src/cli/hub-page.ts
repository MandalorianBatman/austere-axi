// The page a link to a copy whose file is gone opens. The hub itself is a client app (src/chrome/shell.tsx) over /hub/api.
import os from "node:os";
import path from "node:path";
import { escapeHtml } from "./artifact.ts";
import type { HubNoteRow } from "./hub.ts";

function day(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function when(ms: number): string {
  return `${day(ms)} ${new Date(ms).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

// The hub's look without its bundle: tokens.css is not loaded here, so its colors are written out, and no font is fetched.
const STYLE = `*{box-sizing:border-box}
body{margin:0;background:#0b0b0d;color:#ececef;font:13px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:#8fb0ff;text-decoration:none}a:hover{color:#b3c9ff}
:focus-visible{outline:2px solid #8fb0ff;outline-offset:2px}
main{display:flex;flex-direction:column;gap:24px;max-width:880px;margin:0 auto;padding:32px 24px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.brand{margin:0;font-size:14px;font-weight:600}.brand small{margin-left:6px;color:#878791;font-size:12px;font-weight:400}
.nav{display:flex;flex-wrap:wrap;gap:6px}
.nav a{display:inline-flex;align-items:center;height:30px;padding:0 12px;border:1px solid #24242a;border-radius:999px;color:#b4b4be;font-weight:500}
.nav a:hover{border-color:#32323a;background:#1f1f25;color:#ececef}
.card{display:flex;flex-direction:column;border:1px solid #24242a;border-radius:12px;background:#101013}
.head{display:flex;flex-direction:column;gap:4px;padding:16px 20px}
.tl{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-0.01em;overflow-wrap:anywhere}
h2{margin:0;font-size:15px;font-weight:600}
.pill{padding:1px 8px;border-radius:999px;background:rgba(240,138,138,0.12);color:#f08a8a;font-size:11px;font-weight:600}
.block{display:flex;flex-direction:column;gap:6px;padding:14px 20px;border-top:1px solid #24242a}
.foot{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
p{margin:0}
.meta{color:#a6a6b0;font-size:12px;overflow-wrap:anywhere}
.path{padding:8px 12px;border-radius:8px;background:#17171b;color:#c9c9d1;font:11.5px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;overflow-wrap:anywhere}
form{margin:0}
button{display:inline-flex;align-items:center;height:32px;padding:0 12px;border:1px solid #32323a;border-radius:8px;background:#1f1f25;color:#ececef;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
button:hover{background:#24242a}
.count{color:#878791;font-weight:400}
ul{list-style:none;padding:0;margin:0}
li.n{display:flex;flex-direction:column;gap:4px;padding:12px 20px;border-top:1px solid #24242a}
.note{overflow-wrap:anywhere;white-space:pre-wrap}
.note-t{color:#878791;font-size:12px;overflow-wrap:anywhere}b.by{color:#c9c9d1;font-weight:600}
.st{font-weight:600}.st.waiting{color:#f2c46d}.st.done{color:#74d3a0}
.empty{padding:14px 20px;border-top:1px solid #24242a;color:#878791}
@media (max-width:600px){main{padding:20px 12px 48px}.head,.block,li.n,.empty{padding-left:14px;padding-right:14px}button,.nav a{min-height:44px}}
`;

const STATUS_LABEL: Record<string, string | undefined> = {
  open: "unanswered",
  received: "unanswered",
  addressed: "answered",
  held: "held for the owner",
};

/**
 * What a link to a copy whose file is gone opens: where it was, the notes it still holds, and a button to put it away.
 * An archived copy has nothing left to do, so it gets no button. The copy's id goes in the form action; the server checks it.
 * @param notes Hub.notes() rows of this copy
 */
export function missingPage(
  copy: {
    id: string;
    file: string;
    title: string | null;
    archived_at: number | null;
    updated_at: number;
  },
  {
    version,
    project,
    label,
    notes,
  }: { version: string; project: string; label: string; notes: Omit<HubNoteRow, "kind">[] },
): string {
  const rows = notes
    .map((n) => {
      const waiting = n.status !== "addressed";
      return `<li class="n"><p class="note">${escapeHtml(n.text || "(no text)")}</p>
  <span class="note-t">${n.author ? `<b class="by">${escapeHtml(n.author)}</b> · ` : ""}${n.target ? `on ${escapeHtml(n.target)} · ` : ""}${escapeHtml(when(n.at))} · <span class="st ${waiting ? "waiting" : "done"}">${STATUS_LABEL[n.status] || escapeHtml(n.status)}</span></span></li>`;
    })
    .join("");
  const where = label && label !== project ? `${project} · ${label}` : project;
  const action = copy.archived_at
    ? `<div class="block"><p class="meta">Archived ${escapeHtml(when(copy.archived_at))}. The hub's lists leave it out; its notes are kept.</p></div>`
    : `<div class="block foot"><p class="meta">Archiving leaves it out of the hub's lists. Its notes are kept.</p><form method="post" action="/hub/archive/${escapeHtml(copy.id)}"><button type="submit">Archive this copy</button></form></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>File missing · austere-axi hub</title><meta name="color-scheme" content="dark">
<style>
${STYLE}</style></head>
<body><main>
<header><p class="brand">austere-axi hub<small>${escapeHtml(version)}</small></p><nav class="nav" aria-label="Hub"><a href="/?view=pages">Pages</a><a href="/?view=notes">Notes</a></nav></header>
<section class="card" aria-labelledby="copy-h">
<div class="head"><div class="tl"><h1 id="copy-h">${escapeHtml(copy.title || path.basename(copy.file))}</h1><span class="pill">File missing</span></div>
<p class="meta">${escapeHtml(where)} · last activity ${escapeHtml(when(copy.updated_at))}</p></div>
<div class="block"><p>This copy's file is no longer on this machine:</p>
<p class="path" title="${escapeHtml(copy.file)}">${escapeHtml(tilde(copy.file))}</p></div>
${action}
</section>
<section class="card" aria-labelledby="notes-h">
<div class="head"><h2 id="notes-h">Notes <span class="count">· ${notes.length ? `${notes.length} kept` : "none"}</span></h2></div>
${rows ? `<ul>${rows}</ul>` : `<p class="empty">No notes on this copy.</p>`}
</section>
</main></body></html>`;
}
