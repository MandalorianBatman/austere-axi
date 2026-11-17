// The page a link to a copy whose file is gone opens. The hub itself is a client app (src/chrome/shell.ts) over /hub/api.
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
  return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function when(ms: number): string {
  return `${day(ms)} ${new Date(ms).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

const STYLE = `body{margin:0;background:#0b0b0d;color:#e8e8ec;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between}
h1{font-size:18px;font-weight:600;margin:0}h1 small{color:#77777f;font-weight:400;font-size:13px;margin-left:6px}
button:focus-visible,a:focus-visible{outline:2px solid #a9c1ff;outline-offset:2px}
section{margin-top:28px}h2{font-size:15px;font-weight:600;margin:0 0 4px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
h2 small{color:#8a8a94;font-weight:400;font-size:12px;overflow-wrap:anywhere}
ul{list-style:none;padding:0;margin:0}li{border-bottom:1px solid #1c1c20}
.meta{color:#8a8a94;font-size:12px;overflow-wrap:anywhere}em{font-style:normal}em.gone{color:#e38b8b}
.empty{color:#8a8a94;margin-top:28px}
.nav{display:flex;gap:14px;font-size:13px}.nav a{color:#a9c1ff;text-decoration:none}
button{background:#1c1c20;border:1px solid #2a2a30;border-radius:8px;color:#e8e8ec;padding:9px 12px;font:inherit}
.note{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.note-t{color:#8a8a94;font-size:12px}.st{font-size:12px}.st.waiting{color:#f2c46d}.st.done{color:#8fd19e}
li.n{padding:12px 0}b.by{color:#e8e8ec}
`;

const STATUS_LABEL: Record<string, string | undefined> = { open: "unanswered", received: "unanswered", addressed: "answered", held: "held for the owner" };

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
  <span class="note-t">${n.author ? `<b class="by">${escapeHtml(n.author)}</b> · ` : ""}${n.target ? `on ${escapeHtml(n.target)} · ` : ""}${escapeHtml(when(n.at))} · <span class="st ${waiting ? "waiting" : "done"}">${STATUS_LABEL[n.status] || escapeHtml(n.status)}</span></span></li>`;
    })
    .join("");
  const where = label && label !== project ? `${project} · ${label}` : project;
  const action = copy.archived_at
    ? `<p class="meta">Archived ${escapeHtml(when(copy.archived_at))}. The hub's lists leave it out; its notes are kept.</p>`
    : `<form method="post" action="/hub/archive/${escapeHtml(copy.id)}"><button type="submit">Archive this copy</button></form><p class="meta">Archiving leaves it out of the hub's lists. Its notes are kept.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>File missing · austere-axi hub</title><meta name="color-scheme" content="dark">
<style>
${STYLE}</style></head>
<body><main>
<header><h1>austere-axi hub<small>${escapeHtml(version)}</small></h1><nav class="nav"><a href="/?view=pages">Pages</a><a href="/?view=notes">Notes</a></nav></header>
<section>
<h2>${escapeHtml(copy.title || path.basename(copy.file))} <small><em class="gone">file missing</em></small></h2>
<p class="meta">${escapeHtml(where)} · last activity ${escapeHtml(when(copy.updated_at))}</p>
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
