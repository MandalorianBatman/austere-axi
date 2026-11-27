// What `history`, `show`, `outline`, `changes`, `decisions` and `find` print.
// Each builds the output of one command from hub.db and the page file; main.ts wraps them with
// the hub and the error handling. They throw an Error whose message the command prints.
import fs from "node:fs";
import type * as sqlite from "node:sqlite";
import { readArtifact } from "./artifact.ts";
import { parseArtifact } from "./check.ts";
import { originsOf } from "./copy.ts";
import {
  agentLabel,
  changesSince,
  decisionsSince,
  findStatements,
  headRevision,
  revisionAt,
  revisionLog,
  textsOfProgram,
  ageOf,
} from "./history.ts";
import type { CauseNote } from "./history.ts";
import { quote } from "./paths.ts";
import { closureOf, splitStatements, statementMap } from "../shared/statements.ts";
import { outlineOf, programText } from "../shared/text.ts";

type Printed = Record<string, unknown>;

const BIN = "austere-axi";

function shortDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The first note of a cause cut to 80 characters, with how many others there were. */
function causeLine(cause: CauseNote[]): string | undefined {
  if (!cause.length) return undefined;
  const first = cause[0];
  const text = `${first.author}${first.target ? ` on ${first.target}` : ""}: ${first.text}`
    .replace(/\s+/g, " ")
    .trim();
  const cut = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  return cause.length > 1 ? `${cut} (+${cause.length - 1} more)` : cut;
}

/** `history <file> [--statement name] [--since rev]` */
export function historyOutput(
  db: sqlite.DatabaseSync,
  artifactId: string,
  file: string,
  { statement, since, limit }: { statement?: string; since?: number; limit: number },
): Printed {
  const head = headRevision(db, artifactId);
  if (!head)
    return {
      file,
      revisions: "none",
      next: `No revision yet: \`${BIN} ${quote(file)}\` (open) or \`${BIN} check ${quote(file)}\` records the first.`,
    };
  const log = revisionLog(db, artifactId, { statement, since, limit: limit + 1 });
  const more = log.length > limit;
  if (more) log.pop();
  const origins = originsOf(db, artifactId);
  return {
    file,
    head: head.rev,
    revisions: log.length
      ? log.map((r) => ({
          rev: r.rev,
          at: shortDate(r.at),
          source: r.source,
          created: r.created ? `${r.created} statements` : undefined,
          changed: r.changed.length && !r.created ? r.changed : undefined,
          removed: r.removed.length ? r.removed : undefined,
          cause: causeLine(r.cause),
          by: agentLabel(db, r.agent_session_id),
          run: r.run_id ?? undefined,
        }))
      : "none",
    copied: origins.length
      ? origins.map(
          (o) =>
            `${o.name} from ${o.file ?? "a page the hub no longer has"}#${o.statement} (revision ${o.rev})`,
        )
      : undefined,
    more: more
      ? `older revisions: \`${BIN} history ${quote(file)} --limit ${limit * 5}\``
      : undefined,
    next: `\`${BIN} show ${quote(file)} --rev <n> [statement…]\` reads one; \`${BIN} restore ${quote(file)} --rev <n> [statement…]\` puts it back.`,
  };
}

/** The program a `show`, `restore` or `outline` reads: the file, or one revision of it. */
export function programAt(
  db: sqlite.DatabaseSync | null,
  artifactId: string,
  file: string,
  rev: number | undefined,
): { program: string; html: string | null; rev: number | null } {
  let html: string | null = null;
  try {
    html = fs.readFileSync(file, "utf8");
  } catch {
    // gone: a revision can still be read
  }
  if (rev === undefined) {
    const program = html == null ? null : readArtifact(html).program;
    if (program != null) return { program, html, rev: null };
    const head = db && headRevision(db, artifactId);
    if (head) return { program: head.program, html, rev: head.rev };
    throw new Error(
      html == null ? `no such file: ${file}` : 'no <script type="text/openui"> block in the page',
    );
  }
  const r = db && revisionAt(db, artifactId, rev);
  if (!r) {
    const head = db && headRevision(db, artifactId);
    throw new Error(
      `${file} has no revision ${rev}${head ? ` (revisions 1 to ${head.rev})` : "; the hub has none yet"}`,
    );
  }
  return { program: r.program, html, rev };
}

/** `show <file> [statement…] [--text|--source] [--deps] [--rev n]`: no statement names: all of them. */
export function showOutput(
  program: string,
  html: string | null,
  file: string,
  names: string[],
  { text, deps, rev }: { text: boolean; deps: boolean; rev: number | null },
): Printed {
  const map = statementMap(program);
  const missing = names.filter((n) => !map.has(n));
  if (missing.length)
    throw new Error(
      `${file} has no statement ${missing.join(", ")}; it has: ${[...map.keys()].join(", ")}`,
    );
  const wanted = names.length
    ? deps
      ? closureOf(map, names)
      : [...new Set(names)]
    : [...map.keys()];
  const head = { file, rev: rev ?? undefined };
  // A trailing newline makes the output a block, so source and text read as they are written, not as quoted strings.
  if (!text)
    return {
      ...head,
      source: `${wanted.map((n) => (map.get(n) as { text: string }).text).join("\n")}\n`,
    };
  const texts = textsOfProgram(program, html);
  const parsed = html == null ? null : parseArtifact(html);
  const kinds = new Map(
    programText(program, parsed?.root ?? null, parsed?.spec).map((t) => [t.name, t.component]),
  );
  return {
    ...head,
    statements: wanted.map((n) => ({
      name: n,
      component: kinds.get(n) || undefined,
      text: `${texts.get(n) ?? ""}\n`,
    })),
  };
}

/** `outline <file>`: the tree from root, a row per named statement. */
export function outlineOutput(
  program: string,
  html: string | null,
  file: string,
  copied: Map<string, string>,
): Printed {
  const parsed = html == null ? null : parseArtifact(html);
  const { rows, unreached } = outlineOf(program, parsed?.root ?? null, parsed?.spec);
  const lines = rows.map((r) => {
    const from = copied.get(r.name);
    return `${"  ".repeat(r.depth)}${r.name} ${r.component}${r.children ? ` (${r.children})` : ""}${r.words ? `: ${r.words}` : ""}${from ? ` ← ${from}` : ""}`;
  });
  const out: Printed = {
    file,
    statements: splitStatements(program).length,
    outline: lines.join("\n"),
  };
  if (!rows.length)
    out.note = "No tree: the program did not parse, or has no root. `check` says why.";
  if (unreached.length) out.unreached = unreached;
  out.next = `\`${BIN} show ${quote(file)} <statement…> [--text|--deps]\` reads parts.`;
  return out;
}

/** `changes`: revisions after a cursor. */
export function changesOutput(
  db: sqlite.DatabaseSync,
  {
    cursor,
    artifactId,
    projectId,
    limit,
  }: { cursor: number; artifactId?: string; projectId?: string; limit: number },
  scope = "",
): Printed {
  const { changes, next } = changesSince(db, { cursor, artifactId, projectId, limit });
  if (!changes.length) return { changes: "none", cursor: next };
  return {
    changes: changes.map((c) => ({
      page: c.title || c.file,
      file: c.file,
      copy: c.copy,
      rev: c.rev,
      at: shortDate(c.at),
      source: c.source,
      created: c.created ? `${c.created} statements` : undefined,
      statements: c.statements.length
        ? c.statements.map((s) => ({
            name: s.name,
            before: s.before ?? undefined,
            after: s.after ?? "(deleted)",
          }))
        : undefined,
      cause: c.cause.length
        ? c.cause.map((n) => `${n.author}${n.target ? ` on ${n.target}` : ""}: ${n.text}`)
        : undefined,
      reply: c.reply ?? undefined,
    })),
    cursor: next,
    next:
      changes.length >= limit
        ? `More: \`${BIN} changes${scope} --since ${next}${limit === 20 ? "" : ` --limit ${limit}`}\``
        : undefined,
  };
}

/** `decisions`: submitted forms, pressed buttons and Send & finish batches after a cursor. */
export function decisionsOutput(
  db: sqlite.DatabaseSync,
  {
    cursor,
    artifactId,
    projectId,
    limit,
  }: { cursor: number; artifactId?: string; projectId?: string; limit: number },
): Printed {
  const { decisions, next } = decisionsSince(db, { cursor, artifactId, projectId, limit });
  if (!decisions.length) return { decisions: "none", cursor: next };
  return {
    decisions: decisions.map((d) => ({
      kind: d.kind,
      page: d.title || d.file,
      file: d.file,
      copy: d.copy,
      statement: d.statement ?? undefined,
      at: shortDate(d.at),
      author: d.author,
      message: d.message || undefined,
      form: d.form ?? undefined,
    })),
    cursor: next,
  };
}

/** `find <words>`: where the hub already has something about this. */
export function findOutput(
  db: sqlite.DatabaseSync,
  words: string,
  {
    projectId,
    component,
    limit,
    all,
  }: { projectId: string; component: string; limit: number; all: boolean },
): Printed {
  const { hits, fts } = findStatements(db, words, { projectId, component, limit, all });
  const search = fts ? undefined : "LIKE: this SQLite has no FTS5, so results are unranked";
  if (!hits.length)
    return {
      results: "none",
      search,
      next: `No page has these words${all ? "" : " (archived pages and missing files are left out: --all)"}. Write a new page.`,
    };
  return {
    results: hits.map((h) => ({
      title: h.title || undefined,
      file: h.file,
      copy: h.copy,
      statement: h.statement,
      component: h.component || undefined,
      snippet: h.snippet,
      age: ageOf(h.updated_at),
      state:
        [h.archived ? "archived" : "", h.missing ? "missing" : ""].filter(Boolean).join(", ") ||
        undefined,
    })),
    search,
    reuse: `${BIN} patch <file> --from ${quote(`${hits[0].file}#${hits[0].statement}`)}`,
  };
}
