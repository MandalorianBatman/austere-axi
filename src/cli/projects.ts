// Projects in hub.db: a project is a name plus the root folders its pages live under; a page is a
// path inside a root, the same in every root of the project (so one file in two worktrees is one
// page with two copies). Resolved from the file system alone: `.git` is read as a hint, the git
// binary is never run.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as sqlite from "node:sqlite";
import { canonicalFile } from "./paths.ts";

/** How a root was found: assigned by the owner (`project add`), a folder with a `.git` directory or submodule `.git` file, a git worktree, or a guessed folder (where the CLI ran, else a page's own folder). */
export type RootKind = "assigned" | "git" | "worktree" | "folder";

export interface ProjectRow {
  id: string;
  name: string;
  created_at: number;
}

export interface RootRow {
  root: string;
  project_id: string;
  kind: RootKind;
  /** What page paths under this root start with (`/`-separated, no trailing `/`): a repository nested in an assigned root keeps its folder in its pages' paths, and its worktrees share them. Empty for most roots. */
  prefix: string;
  created_at: number;
}

/** Where a folder belongs: its project, the root it is under and that root's page-path prefix. */
export interface Place {
  projectId: string;
  root: string;
  kind: RootKind;
  prefix: string;
}

/** Where a file belongs: its place, its page path (the root's prefix, then the path inside the root, `/`-separated) and its page. */
export interface Located extends Place {
  file: string;
  relPath: string;
  pageId: string;
}

/** A path as compared with others: Windows paths are case-insensitive. */
export function pathKey(p: string, platform: string = process.platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Whether `p` is `root` or inside it. */
export function within(root: string, p: string, platform: string = process.platform): boolean {
  const r = pathKey(root, platform);
  const k = pathKey(p, platform);
  if (k === r) return true;
  const sep = platform === "win32" ? /[\\/]$/ : /\/$/;
  return k.startsWith(sep.test(r) ? r : r + (platform === "win32" ? "\\" : "/"));
}

/** A file's path inside its root, with `/` separators. */
export function relPathOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** A page path: `prefix`, then `rel`. */
function joinPrefix(prefix: string, rel: string): string {
  return prefix && rel ? `${prefix}/${rel}` : prefix || rel;
}

/** A page's id: 12 hex of sha1(project id, NUL, path inside the root). */
export function pageIdOf(projectId: string, relPath: string): string {
  return crypto.createHash("sha1").update(`${projectId}\0${relPath}`).digest("hex").slice(0, 12);
}

/** Run `fn` in one transaction (a savepoint inside another). */
export function inTransaction<T>(db: sqlite.DatabaseSync, fn: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT projects" : "BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec(nested ? "RELEASE projects" : "COMMIT");
    return out;
  } catch (err) {
    db.exec(nested ? "ROLLBACK TO projects; RELEASE projects" : "ROLLBACK");
    throw err;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The `.git` entry of a folder: a directory, a file, or nothing. */
function dotGit(dir: string): "dir" | "file" | null {
  try {
    const st = fs.statSync(path.join(dir, ".git"));
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  } catch {
    return null;
  }
}
/** The git dir a `.git` file points at (`gitdir: <path>`, relative to the folder holding it). */
function gitdirOf(dir: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(path.join(dir, ".git")) || "");
  return m ? canonicalFile(path.resolve(dir, m[1])) : null;
}

/** A folder's git dir: its `.git` directory, or where its `.git` file points. */
function gitDirFor(root: string): string | null {
  const kind = dotGit(root);
  if (kind === "dir") return path.join(root, ".git");
  if (kind === "file") return gitdirOf(root);
  return null;
}

/** The main repository of a linked worktree (a `.git` file whose git dir holds `commondir`); null for anything else, a submodule included. */
function mainRepoOf(dir: string): string | null {
  const gitDir = gitdirOf(dir);
  const common = gitDir ? readText(path.join(gitDir, "commondir")) : null;
  if (!gitDir || common == null || !common.trim()) return null;
  const commonDir = canonicalFile(path.resolve(gitDir, common.trim()));
  const main = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  return pathKey(main) === pathKey(dir) ? null : main;
}

/**
 * The label of a copy: the branch its root has checked out (from the git dir's `HEAD`), the first
 * 7 characters of a detached `HEAD`, else the root folder's name. File reads only.
 */
export function copyLabel(root: string): string {
  const gitDir = gitDirFor(root);
  const head = gitDir ? (readText(path.join(gitDir, "HEAD")) || "").trim() : "";
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1];
  if (/^[0-9a-f]{7,}$/i.test(head)) return head.slice(0, 7);
  return path.basename(root) || root;
}

function allRoots(db: sqlite.DatabaseSync): RootRow[] {
  return db.prepare("SELECT * FROM project_roots").all() as unknown as RootRow[];
}

function createProject(db: sqlite.DatabaseSync, name: string): string {
  const id = crypto.randomBytes(6).toString("hex");
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, name, Date.now());
  return id;
}

/**
 * Store `root` as a root of `projectId` (or of a new project named after the folder), unless it is
 * stored already; re-read so a root another process stored first wins. The stored row.
 */
function storeRoot(db: sqlite.DatabaseSync, root: string, kind: RootKind, projectId?: string, prefix = ""): RootRow {
  const id = projectId ?? createProject(db, path.basename(root) || root);
  db.prepare("INSERT INTO project_roots (root, project_id, kind, prefix, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(root) DO NOTHING").run(root, id, kind, prefix, Date.now());
  const stored = db.prepare("SELECT * FROM project_roots WHERE root = ?").get(root) as unknown as RootRow;
  if (projectId === undefined && stored.project_id !== id) db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return stored;
}

const placeOf = (r: RootRow): Place => ({ projectId: r.project_id, root: r.root, kind: r.kind, prefix: r.prefix });

/** Whether `dir` is a file system root, the home folder or the temp folder: a guessed root there holds only its own folder. */
function broad(dir: string): boolean {
  const key = pathKey(dir);
  return path.dirname(dir) === dir || key === pathKey(canonicalFile(os.homedir())) || key === pathKey(canonicalFile(os.tmpdir()));
}

/**
 * Whether the stored root `r` holds the folder `dir` at or below it. The one rule for opening a page
 * and for finding a project by folder: every root holds everything below it, except a `folder` root
 * at `/`, the home folder or the temp folder (`broad`), which holds only that folder.
 */
const holds = (r: RootRow, dir: string): boolean => r.kind !== "folder" || pathKey(r.root) === pathKey(dir) || !broad(r.root);

/** What holds a folder, walking up from it: the first stored root that holds it, else the first folder with a `.git`, else nothing. */
function lookup(roots: RootRow[], dir: string): { row: RootRow } | { at: string; git: "dir" | "file" } | null {
  const byKey = new Map(roots.map((r) => [pathKey(r.root), r]));
  for (let d = dir; ; ) {
    const row = byKey.get(pathKey(d));
    if (row && holds(row, dir)) return { row };
    const git = dotGit(d);
    if (git) return { at: d, git };
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * The project and root of a folder (canonical), storing a root found by `.git` or guessed, so the
 * next lookup finds it stored. `cwd` is the folder the CLI ran in, if any. First match, walking up from `dir`:
 *  1. a stored root that `holds` it (the nearest);
 *  2. a `.git` entry: a directory makes a `git` root; a file points at a git dir, and a `commondir`
 *     there leads to the main repository, whose project this `worktree` root joins (no
 *     `commondir`: a submodule, its own project). Inside an assigned root, the folder holding
 *     `.git` is a root of the assigned root's project, and its pages' paths start with its folder
 *     inside the assigned root, so two repositories there keep apart; a repository's worktrees,
 *     wherever they are, share its prefix and so its pages;
 *  3. a guessed `folder` root: `cwd` when `dir` is inside it and it is not `broad`,
 *     else `dir`. It takes in the guessed roots below it (`takeIn`).
 */
export function resolveDir(db: sqlite.DatabaseSync, dir: string, cwd?: string): Place {
  const roots = allRoots(db);
  const found = lookup(roots, dir);
  if (found && "row" in found) return placeOf(found.row);
  if (found) return gitPlace(db, found.at, found.git, roots);
  const row = storeRoot(db, cwd && within(cwd, dir) && !broad(cwd) ? cwd : dir, "folder");
  if (!broad(row.root)) takeIn(db, row);
  return placeOf(row);
}

/**
 * A new guessed root takes in the guessed roots below it that nothing nearer holds (a stored root
 * or a `.git` in between) and whose project has no other root: their pages move to its project.
 */
function takeIn(db: sqlite.DatabaseSync, outer: RootRow): void {
  // Shortest first: a guessed root in between is taken in before, or else keeps, the ones below it.
  const below = allRoots(db)
    .filter((r) => r.kind === "folder" && r.root !== outer.root && within(outer.root, r.root))
    .sort((a, b) => a.root.length - b.root.length);
  let taken = false;
  for (const r of below) {
    const roots = allRoots(db);
    if (roots.some((o) => o.project_id === r.project_id && o.root !== r.root)) continue;
    const stored = new Set(roots.map((o) => pathKey(o.root)));
    let held = false;
    for (let d = path.dirname(r.root); d !== outer.root && !held; d = path.dirname(d)) held = stored.has(pathKey(d)) || dotGit(d) !== null;
    if (held) continue;
    db.prepare("DELETE FROM project_roots WHERE root = ?").run(r.root);
    rekey(db, r.root, r.project_id);
    taken = true;
  }
  if (taken) prune(db);
}

/** The nearest assigned root holding `dir` (or only those of `projectId`): the owner said everything under it is one project. */
function assignedHolder(roots: RootRow[], dir: string, projectId?: string): RootRow | null {
  let best: RootRow | null = null;
  for (const r of roots) {
    if (r.kind === "assigned" && (projectId === undefined || r.project_id === projectId) && within(r.root, dir) && (!best || r.root.length > best.root.length)) best = r;
  }
  return best;
}

/** The prefix of `dir` under the assigned root `holder`. */
const prefixUnder = (holder: RootRow, dir: string): string => joinPrefix(holder.prefix, relPathOf(holder.root, dir));

function gitPlace(db: sqlite.DatabaseSync, dir: string, git: "dir" | "file", roots: RootRow[]): Place {
  // Inside an assigned root: that root's project, whatever the repository.
  const assigned = assignedHolder(roots, dir);
  const main = git === "file" ? mainRepoOf(dir) : null;
  if (main) {
    // The main repository's root: stored, else stored now, under the assigned root holding it, else
    // in the project of the assigned root holding this worktree (with this worktree's prefix, so
    // the repository's other worktrees join the same pages), else in a new project.
    let known = roots.find((r) => pathKey(r.root) === pathKey(main));
    if (!known) {
      const holder = assignedHolder(roots, main);
      known = holder
        ? storeRoot(db, main, "git", holder.project_id, prefixUnder(holder, main))
        : storeRoot(db, main, "git", assigned?.project_id, assigned ? prefixUnder(assigned, dir) : "");
    }
    if (!assigned || known.project_id === assigned.project_id) return placeOf(storeRoot(db, dir, "worktree", known.project_id, known.prefix));
    // An assigned root of another project holding the worktree wins. The repository's worktrees in
    // that project (one the owner assigned included) share the prefix of the first one stored there,
    // so they stay copies of one page.
    const sibling = roots.find((r) => (r.kind === "worktree" || r.kind === "assigned") && r.project_id === assigned.project_id && pathKey(mainRepoOf(r.root) ?? "") === pathKey(main));
    return placeOf(storeRoot(db, dir, "worktree", assigned.project_id, sibling ? sibling.prefix : prefixUnder(assigned, dir)));
  }
  return placeOf(storeRoot(db, dir, "git", assigned?.project_id, assigned ? prefixUnder(assigned, dir) : ""));
}

/** Insert the page row for a path in a project; its id. */
function ensurePage(db: sqlite.DatabaseSync, projectId: string, relPath: string): string {
  const id = pageIdOf(projectId, relPath);
  db.prepare("INSERT INTO pages (id, project_id, rel_path) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(id, projectId, relPath);
  return id;
}

/** The project, root and page of a file (resolved through canonicalFile), storing what it finds; `cwd`: the folder the CLI ran in. */
export function resolveProject(db: sqlite.DatabaseSync, file: string, cwd?: string): Located {
  const abs = canonicalFile(file);
  const base = cwd ? canonicalFile(cwd) : undefined;
  // One write transaction: two processes seeing a folder for the first time store one root.
  return inTransaction(db, () => locatedIn(db, resolveDir(db, path.dirname(abs), base), abs));
}

function locatedIn(db: sqlite.DatabaseSync, place: Place, file: string): Located {
  const relPath = joinPrefix(place.prefix, relPathOf(place.root, file));
  return { ...place, file, relPath, pageId: ensurePage(db, place.projectId, relPath) };
}

/** Set an artifact's project, root and page from its file. */
function placeArtifact(db: sqlite.DatabaseSync, id: string, file: string): void {
  const loc = resolveProject(db, file);
  db.prepare("UPDATE artifacts SET project_id = ?, root = ?, page_id = ? WHERE id = ?").run(loc.projectId, loc.root, loc.pageId, id);
}

/** Drop projects with no root and no artifact, and pages no artifact points at. */
function prune(db: sqlite.DatabaseSync): void {
  db.exec(`DELETE FROM projects WHERE id NOT IN (SELECT project_id FROM project_roots)
             AND id NOT IN (SELECT project_id FROM artifacts WHERE project_id IS NOT NULL)`);
  db.exec("DELETE FROM pages WHERE id NOT IN (SELECT page_id FROM artifacts WHERE page_id IS NOT NULL)");
}

/**
 * Migration from 0.10.4: give every artifact without a project one, by its old project path
 * (the nearest folder with a `.git`, else the file's folder), in one transaction.
 */
export function backfillProjects(db: sqlite.DatabaseSync): void {
  const rows = db.prepare("SELECT id, file, project FROM artifacts WHERE project_id IS NULL").all() as unknown as { id: string; file: string; project: string }[];
  if (!rows.length) return;
  inTransaction(db, () => {
    const places = new Map<string, Place>();
    for (const r of rows) {
      const file = canonicalFile(r.file);
      let place = places.get(r.project);
      if (!place) places.set(r.project, (place = resolveDir(db, canonicalFile(r.project))));
      const loc = within(place.root, file) && file !== place.root ? locatedIn(db, place, file) : resolveProject(db, file);
      db.prepare("UPDATE artifacts SET project_id = ?, root = ?, page_id = ? WHERE id = ?").run(loc.projectId, loc.root, loc.pageId, r.id);
    }
  });
}

/**
 * A project by id, name, or any folder a root of it holds (by the rule `resolveDir` stores roots by;
 * a repository not seen yet is in no project unless an assigned root holds it). Throws when a name
 * is ambiguous. `folders: false` matches an id or name only (the server, which has no working
 * directory to resolve against).
 */
export function findProject(db: sqlite.DatabaseSync, ref: string, { folders = true }: { folders?: boolean } = {}): ProjectRow | null {
  const byId = db.prepare("SELECT * FROM projects WHERE id = ?").get(ref) as unknown as ProjectRow | undefined;
  if (byId) return byId;
  const named = db.prepare("SELECT * FROM projects WHERE name = ? ORDER BY created_at").all(ref) as unknown as ProjectRow[];
  if (named.length > 1) throw new Error(`several projects are named ${ref}: ${named.map((p) => p.id).join(", ")}; use an id`);
  if (named.length) return named[0];
  if (!folders) return null;
  const roots = allRoots(db);
  const found = lookup(roots, canonicalFile(path.resolve(ref)));
  const id = !found ? null : "row" in found ? found.row.project_id : gitProjectOf(roots, found.at, found.git);
  return id ? ((db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined) ?? null) : null;
}

/** The project a page under the `.git` at `dir` would join, as `gitPlace` decides, without storing anything; null: a new one. */
function gitProjectOf(roots: RootRow[], dir: string, git: "dir" | "file"): string | null {
  const assigned = assignedHolder(roots, dir);
  if (assigned) return assigned.project_id;
  const main = git === "file" ? mainRepoOf(dir) : null;
  if (!main) return null;
  return roots.find((r) => pathKey(r.root) === pathKey(main))?.project_id ?? assignedHolder(roots, main)?.project_id ?? null;
}

function needProject(db: sqlite.DatabaseSync, ref: string): ProjectRow {
  const p = findProject(db, ref);
  if (!p) throw new Error(`no project ${ref} (a project name, id, or a folder inside one of its roots)`);
  return p;
}

export interface ProjectListing extends ProjectRow {
  roots: { root: string; kind: RootKind }[];
  pages: number;
}

/** Every project with its roots and how many pages it has. */
export function listProjects(db: sqlite.DatabaseSync): ProjectListing[] {
  const roots = allRoots(db);
  const counts = new Map(
    (db.prepare("SELECT project_id, COUNT(DISTINCT page_id) AS n FROM artifacts GROUP BY project_id").all() as unknown as { project_id: string; n: number }[]).map((r) => [r.project_id, r.n]),
  );
  return (db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE, created_at").all() as unknown as ProjectRow[]).map((p) => ({
    ...p,
    roots: roots.filter((r) => r.project_id === p.id).map((r) => ({ root: r.root, kind: r.kind })).sort((a, b) => a.root.localeCompare(b.root)),
    pages: counts.get(p.id) || 0,
  }));
}

/** Re-resolve every artifact whose file is inside `root` or that belongs to `projectId`. */
function rekey(db: sqlite.DatabaseSync, root: string | null, projectId: string): void {
  for (const a of db.prepare("SELECT id, file, project_id FROM artifacts").all() as unknown as { id: string; file: string; project_id: string | null }[]) {
    if (a.project_id === projectId || (root && within(root, a.file))) placeArtifact(db, a.id, a.file);
  }
}

/**
 * Recompute the page-path prefixes of a project's roots after its roots changed, so a root nested
 * in an assigned root keeps its folder in its pages' paths: assigned and git roots take their path
 * under the nearest assigned root of the project holding them; a git root held by none keeps its
 * prefix only while a worktree of it sits under an assigned root of the project (that worktree gave
 * it the prefix), else has none; a worktree takes its main repository's prefix when that repository
 * is in the project, else the shared prefix of the repository's worktrees here, else its path under
 * the assigned root holding it; one held by none keeps the prefix it has, so worktrees of two
 * repositories stay apart (which prefix such roots should take is RLM-368).
 */
function settlePrefixes(db: sqlite.DatabaseSync, projectId: string): void {
  const roots = allRoots(db).filter((r) => r.project_id === projectId).sort((a, b) => a.root.length - b.root.length);
  const set = db.prepare("UPDATE project_roots SET prefix = ? WHERE root = ?");
  const update = (r: RootRow, prefix: string): void => {
    r.prefix = prefix;
    set.run(prefix, r.root);
  };
  // Shortest first: a holder's prefix is settled before the roots inside it.
  for (const r of roots) {
    if (r.kind !== "assigned" && r.kind !== "git") continue;
    const holder = assignedHolder(roots.filter((h) => h !== r), r.root);
    if (holder) update(r, prefixUnder(holder, r.root));
    // A git root held by none: its prefix came from a worktree of it under an assigned root, or it has none.
    else if (r.kind === "assigned" || !roots.some((w) => w !== r && pathKey(mainRepoOf(w.root) ?? "") === pathKey(r.root) && (w.kind === "assigned" || assignedHolder(roots, w.root)))) update(r, "");
  }
  // Worktrees whose repository is not in the project: one prefix per repository, an assigned
  // worktree's (the owner placed it), else the first one's.
  const byMain = new Map<string, string>();
  for (const r of roots) {
    const main = r.kind === "assigned" ? mainRepoOf(r.root) : null;
    if (main && !byMain.has(pathKey(main))) byMain.set(pathKey(main), r.prefix);
  }
  for (const r of roots) {
    if (r.kind !== "worktree") continue;
    const main = mainRepoOf(r.root);
    const mainRow = main ? roots.find((m) => pathKey(m.root) === pathKey(main)) : undefined;
    const shared = main ? byMain.get(pathKey(main)) : undefined;
    const holder = assignedHolder(roots, r.root);
    if (mainRow) update(r, mainRow.prefix);
    else if (shared !== undefined) update(r, shared);
    else if (holder) update(r, prefixUnder(holder, r.root));
    if (main && !mainRow && shared === undefined) byMain.set(pathKey(main), r.prefix);
  }
}

/**
 * `project add <dir> [--name n]`: make `dir` an assigned root, of the project named `name` (made if
 * there is none) or else of its own project. Roots guessed from a page's folder inside `dir` are
 * absorbed, whatever their project, and their pages re-keyed under `dir`; any other root of another
 * project above or below `dir` is an error naming it (a guessed folder above keeps what is outside `dir`).
 */
export function addRoot(db: sqlite.DatabaseSync, dir: string, name?: string): { project: ProjectRow; root: string } {
  const root = canonicalFile(dir);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a folder: ${root}`);
  return inTransaction(db, () => {
    const roots = allRoots(db);
    const existing = roots.find((r) => pathKey(r.root) === pathKey(root));
    let projectId: string;
    if (name) {
      const named = db.prepare("SELECT * FROM projects WHERE name = ? ORDER BY created_at").all(name) as unknown as ProjectRow[];
      if (named.length > 1) throw new Error(`several projects are named ${name}: ${named.map((p) => p.id).join(", ")}`);
      projectId = named.length ? named[0].id : createProject(db, name);
    } else projectId = existing ? existing.project_id : createProject(db, path.basename(root) || root);
    const absorbed: string[] = [];
    for (const r of roots) {
      if (pathKey(r.root) === pathKey(root)) continue;
      if (r.kind === "folder") {
        if (within(root, r.root)) absorbed.push(r.root);
        continue;
      }
      if (r.project_id === projectId) continue;
      const projectName = (db.prepare("SELECT name FROM projects WHERE id = ?").get(r.project_id) as { name: string } | undefined)?.name || r.project_id;
      if (within(r.root, root)) throw new Error(`${root} is inside ${r.root}, a root of project ${projectName}`);
      if (within(root, r.root)) throw new Error(`${r.root}, a root of project ${projectName}, is inside ${root}; \`project merge\` joins the two projects`);
    }
    for (const r of absorbed) db.prepare("DELETE FROM project_roots WHERE root = ?").run(r);
    db.prepare(
      "INSERT INTO project_roots (root, project_id, kind, created_at) VALUES (?, ?, 'assigned', ?) ON CONFLICT(root) DO UPDATE SET project_id = excluded.project_id, kind = 'assigned'",
    ).run(existing ? existing.root : root, projectId, Date.now());
    settlePrefixes(db, projectId);
    rekey(db, root, projectId);
    prune(db);
    return { project: db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as unknown as ProjectRow, root: existing ? existing.root : root };
  });
}

/** `project merge <a> <b>`: b's roots and pages move to a, and b is gone. */
export function mergeProjects(db: sqlite.DatabaseSync, a: string, b: string): ProjectRow {
  return inTransaction(db, () => {
    const into = needProject(db, a);
    const from = needProject(db, b);
    if (into.id === from.id) throw new Error(`${a} and ${b} are the same project`);
    db.prepare("UPDATE project_roots SET project_id = ? WHERE project_id = ?").run(into.id, from.id);
    settlePrefixes(db, into.id);
    rekey(db, null, into.id);
    for (const r of db.prepare("SELECT id, file FROM artifacts WHERE project_id = ?").all(from.id) as unknown as { id: string; file: string }[]) placeArtifact(db, r.id, r.file);
    db.prepare("DELETE FROM projects WHERE id = ?").run(from.id);
    prune(db);
    return into;
  });
}

/** `project rename <p> <name>`: refused when another project has that name, as names must stay unambiguous to find a project by. */
export function renameProject(db: sqlite.DatabaseSync, ref: string, name: string): ProjectRow {
  return inTransaction(db, () => {
    const p = needProject(db, ref);
    const taken = db.prepare("SELECT id FROM projects WHERE name = ? AND id != ?").get(name, p.id) as { id: string } | undefined;
    if (taken) throw new Error(`a project is already named ${name} (${taken.id}); \`project merge\` joins two projects`);
    db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, p.id);
    return { ...p, name };
  });
}

/** `project forget-root <dir>`: drop a root; the project's other roots get their prefixes again, and its pages, and those under the root, are resolved again (a `.git` or their folder). */
export function forgetRoot(db: sqlite.DatabaseSync, dir: string): { root: string; project: string } {
  const want = canonicalFile(dir);
  return inTransaction(db, () => {
    const row = allRoots(db).find((r) => pathKey(r.root) === pathKey(want));
    if (!row) throw new Error(`not a project root: ${want} (\`project list\` shows them)`);
    const name = (db.prepare("SELECT name FROM projects WHERE id = ?").get(row.project_id) as { name: string } | undefined)?.name || row.project_id;
    db.prepare("DELETE FROM project_roots WHERE root = ?").run(row.root);
    settlePrefixes(db, row.project_id);
    rekey(db, row.root, row.project_id);
    prune(db);
    return { root: row.root, project: name };
  });
}
