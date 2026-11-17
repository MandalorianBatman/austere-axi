// `patch --from <src>#<a>[,<b>…]` (RLM-354): take statements that already exist on another page,
// with everything they reference. A copy, not an include: the page keeps rendering from its own
// file (L15). The copy is merged by the patch path, so a part nothing references is dropped
// and reported like any other.
import fs from "node:fs";
import type * as sqlite from "node:sqlite";
import { canonicalFile } from "./paths.ts";
import { readArtifact } from "./artifact.ts";
import { headRevision, programSha, revisionAt } from "./history.ts";
import { sessionId } from "./sessions.ts";
import { closureOf, renameStatements, statementMap } from "../shared/statements.ts";

/** One `--from`: a page and the statements wanted from it. */
export interface CopySource {
  /** The page as the user wrote it (`src` of `src#a,b`). */
  file: string;
  names: string[];
}

/** What was copied from one page. */
export interface CopyOrigin {
  /** The statement's name on this page. */
  name: string;
  srcArtifact: string;
  srcFile: string;
  srcName: string;
  srcRev: number;
}

/** The statements to merge, and what happened to their names. */
export interface CopyPlan {
  /** Source of every copied statement, under its final name. */
  text: string;
  /** Statements taken, final names: the ones asked for, then what they reference. */
  taken: string[];
  /** Old name to new, for the ones that clashed with a statement of the page. */
  renamed: Record<string, string>;
  origins: CopyOrigin[];
}

/** `plan.html#flow,intro` as a source; throws when it names no statement. */
export function parseSource(arg: string): CopySource {
  const at = arg.lastIndexOf("#");
  const names = at < 0 ? [] : arg.slice(at + 1).split(",").map((n) => n.trim()).filter(Boolean);
  if (at < 0 || !names.length) throw new Error(`--from takes <file>#<statement>[,<statement>…], not ${JSON.stringify(arg)}`);
  return { file: arg.slice(0, at), names };
}

/** The program of a source page: its file now, or with `rev` that revision in hub.db; the file gone: the newest revision. */
function sourceProgram(db: sqlite.DatabaseSync | null, file: string, rev: number | undefined): { program: string; rev: number; artifact: string; abs: string } {
  const abs = canonicalFile(file);
  const artifact = sessionId(abs);
  if (rev !== undefined) {
    const r = db && revisionAt(db, artifact, rev);
    if (!r) throw new Error(`${file} has no revision ${rev} (\`austere-axi history ${file}\` lists them)`);
    return { program: r.program, rev, artifact, abs };
  }
  const head = db ? headRevision(db, artifact) : null;
  if (fs.existsSync(abs)) {
    const program = readArtifact(fs.readFileSync(abs, "utf8")).program;
    if (program == null) throw new Error(`${file} has no <script type="text/openui"> block to copy from`);
    // The copy is the file's. The origin names the newest revision only when that is what was read (an edit made since is revision 0: not recorded).
    return { program, rev: head && head.program_sha === programSha(program) ? head.rev : 0, artifact, abs };
  }
  if (head) return { program: head.program, rev: head.rev, artifact, abs };
  throw new Error(`no such file: ${abs}`);
}

/**
 * Plan the copy of `sources` into a page whose program is `into`. A name the page already has is
 * taken by the incoming statement under a new name (`flow` becomes `flow2`), and every reference
 * to it in the incoming statements follows.
 */
export function planCopy(db: sqlite.DatabaseSync | null, into: string, sources: CopySource[], rev?: number): CopyPlan {
  const have = new Set(statementMap(into).keys());
  const used = new Set(have);
  const renamed: Record<string, string> = {};
  // The statements asked for, then the ones they bring along: what the report names first are the parts, not their parts' parts.
  const first: string[] = [];
  const rest: string[] = [];
  const origins: CopyOrigin[] = [];
  const blocks: string[] = [];
  for (const src of sources) {
    const from = sourceProgram(db, src.file, rev);
    const map = statementMap(from.program);
    const missing = src.names.filter((n) => !map.has(n));
    if (missing.length) throw new Error(`${src.file} has no statement ${missing.join(", ")}; it has: ${[...map.keys()].join(", ")}`);
    const names = closureOf(map, src.names);
    const renames = new Map<string, string>();
    for (const n of names) {
      let to = n;
      for (let k = 2; used.has(to); k++) to = `${n}${k}`;
      used.add(to);
      if (to !== n) {
        renames.set(n, to);
        renamed[n] = to;
      }
    }
    for (const n of names) {
      const text = renameStatements((map.get(n) as { text: string }).text, renames);
      blocks.push(text);
      const final = renames.get(n) ?? n;
      (src.names.includes(n) ? first : rest).push(final);
      origins.push({ name: final, srcArtifact: from.artifact, srcFile: from.abs, srcName: n, srcRev: from.rev });
    }
  }
  return { text: blocks.join("\n"), taken: [...first, ...rest], renamed, origins };
}

/** Record where statements came from, replacing an earlier origin of the same name. */
export function recordOrigins(db: sqlite.DatabaseSync, artifactId: string, origins: CopyOrigin[]): void {
  const put = db.prepare("INSERT OR REPLACE INTO statement_origins (artifact_id, name, src_artifact_id, src_name, src_rev) VALUES (?, ?, ?, ?, ?)");
  for (const o of origins) put.run(artifactId, o.name, o.srcArtifact, o.srcName, o.srcRev);
}

/** Where a copy's statements came from: name, the page (its file, while the hub knows it) and statement, and the revision. */
export function originsOf(db: sqlite.DatabaseSync, artifactId: string): { name: string; file: string | null; statement: string; rev: number }[] {
  const rows = db
    .prepare(
      `SELECT o.name, o.src_name, o.src_rev, a.file FROM statement_origins o LEFT JOIN artifacts a ON a.id = o.src_artifact_id
       WHERE o.artifact_id = ? ORDER BY o.name`,
    )
    .all(artifactId) as unknown as { name: string; src_name: string; src_rev: number; file: string | null }[];
  return rows.map((r) => ({ name: r.name, file: r.file, statement: r.src_name, rev: r.src_rev }));
}
