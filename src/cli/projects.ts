// Projects in hub.db: a project is a name plus the root folders its pages live under; a page is a
// path inside a root, the same in every root of the project (so one file in two worktrees is one
// page with two copies). Resolved from the file system alone: `.git` is read as a hint, the git
// binary is never run.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type * as sqlite from "node:sqlite";
import { canonicalFile } from "./paths.ts";

/** How a root was found: assigned by the owner (`project add`), a folder with a `.git` directory or submodule `.git` file, a git worktree, or a page's own folder. */
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
  created_at: number;
}

/** Where a folder belongs: its project and the root it is under. */
export interface Place {
  projectId: string;
  root: string;
  kind: RootKind;
}

/** Where a file belongs: its place, its path inside the root (`/`-separated) and its page. */
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

function storeRoot(db: sqlite.DatabaseSync, root: string, projectId: string, kind: RootKind): void {
  db.prepare("INSERT INTO project_roots (root, project_id, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(root) DO NOTHING").run(root, projectId, kind, Date.now());
}

/**
 * The project and root of a folder (canonical), storing a root found by `.git` or by the folder
 * itself, so the next lookup finds it stored. First match, walking up from `dir`:
 *  1. a stored root (the nearest is the longest). A `folder` root, a guess from a page's own
 *     folder, matches only that folder: a page in `~/a/b` does not join a project made for `~/a`;
 *  2. a `.git` entry, unless an assigned root contains it: a directory makes a `git` root; a file
 *     points at a git dir, and a `commondir` there leads to the main repository, whose project
 *     this `worktree` root joins (no `commondir`: a submodule, its own project);
 *  3. `dir` itself, a `folder` root.
 */
export function resolveDir(db: sqlite.DatabaseSync, dir: string): Place {
  const roots = allRoots(db);
  const byKey = new Map(roots.map((r) => [pathKey(r.root), r]));
  const assigned = roots.some((r) => r.kind === "assigned" && within(r.root, dir));
  for (let d = dir; ; ) {
    const row = byKey.get(pathKey(d));
    if (row && (row.kind !== "folder" || d === dir)) return { projectId: row.project_id, root: row.root, kind: row.kind };
    if (!assigned) {
      const git = dotGit(d);
      if (git) return gitPlace(db, d, git, byKey);
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const projectId = createProject(db, path.basename(dir) || dir);
  storeRoot(db, dir, projectId, "folder");
  return { projectId, root: dir, kind: "folder" };
}

function gitPlace(db: sqlite.DatabaseSync, dir: string, git: "dir" | "file", byKey: Map<string, RootRow>): Place {
  if (git === "file") {
    const gitDir = gitdirOf(dir);
    const common = gitDir ? readText(path.join(gitDir, "commondir")) : null;
    if (gitDir && common != null && common.trim()) {
      const commonDir = canonicalFile(path.resolve(gitDir, common.trim()));
      const main = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
      if (pathKey(main) !== pathKey(dir)) {
        const known = byKey.get(pathKey(main));
        const projectId = known ? known.project_id : createProject(db, path.basename(main) || main);
        if (!known) storeRoot(db, main, projectId, "git");
        storeRoot(db, dir, projectId, "worktree");
        return { projectId, root: dir, kind: "worktree" };
      }
    }
  }
  const projectId = createProject(db, path.basename(dir) || dir);
  storeRoot(db, dir, projectId, "git");
  return { projectId, root: dir, kind: "git" };
}

/** Insert the page row for a path in a project; its id. */
function ensurePage(db: sqlite.DatabaseSync, projectId: string, relPath: string): string {
  const id = pageIdOf(projectId, relPath);
  db.prepare("INSERT INTO pages (id, project_id, rel_path) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(id, projectId, relPath);
  return id;
}

/** The project, root and page of a file (resolved through canonicalFile), storing what it finds. */
export function resolveProject(db: sqlite.DatabaseSync, file: string): Located {
  const abs = canonicalFile(file);
  const place = resolveDir(db, path.dirname(abs));
  return locatedIn(db, place, abs);
}

function locatedIn(db: sqlite.DatabaseSync, place: Place, file: string): Located {
  const relPath = relPathOf(place.root, file);
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

/** A project by id, name, or any folder inside one of its roots. Throws when a name is ambiguous. */
export function findProject(db: sqlite.DatabaseSync, ref: string): ProjectRow | null {
  const byId = db.prepare("SELECT * FROM projects WHERE id = ?").get(ref) as unknown as ProjectRow | undefined;
  if (byId) return byId;
  const named = db.prepare("SELECT * FROM projects WHERE name = ? ORDER BY created_at").all(ref) as unknown as ProjectRow[];
  if (named.length > 1) throw new Error(`several projects are named ${ref}: ${named.map((p) => p.id).join(", ")}; use an id`);
  if (named.length) return named[0];
  const dir = canonicalFile(path.resolve(ref));
  let best: RootRow | null = null;
  for (const r of allRoots(db)) if (within(r.root, dir) && (!best || r.root.length > best.root.length)) best = r;
  return best ? (db.prepare("SELECT * FROM projects WHERE id = ?").get(best.project_id) as unknown as ProjectRow) : null;
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

/** Re-resolve every artifact whose file is inside `root`. */
function rekeyUnder(db: sqlite.DatabaseSync, root: string): void {
  for (const a of db.prepare("SELECT id, file FROM artifacts").all() as unknown as { id: string; file: string }[]) {
    if (within(root, a.file)) placeArtifact(db, a.id, a.file);
  }
}

/**
 * `project add <dir> [--name n]`: make `dir` an assigned root, of the project named `name` (made if
 * there is none) or else of its own project. Roots guessed from a page's folder inside `dir` are
 * absorbed; any other root of another project above or below `dir` is an error naming it.
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
      if (r.project_id === projectId || pathKey(r.root) === pathKey(root)) continue;
      const projectName = (db.prepare("SELECT name FROM projects WHERE id = ?").get(r.project_id) as { name: string } | undefined)?.name || r.project_id;
      if (within(r.root, root)) throw new Error(`${root} is inside ${r.root}, a root of project ${projectName}`);
      if (within(root, r.root)) {
        if (r.kind !== "folder") throw new Error(`${r.root}, a root of project ${projectName}, is inside ${root}; \`project merge\` joins the two projects`);
        absorbed.push(r.root);
      }
    }
    for (const r of absorbed) db.prepare("DELETE FROM project_roots WHERE root = ?").run(r);
    db.prepare(
      "INSERT INTO project_roots (root, project_id, kind, created_at) VALUES (?, ?, 'assigned', ?) ON CONFLICT(root) DO UPDATE SET project_id = excluded.project_id, kind = 'assigned'",
    ).run(existing ? existing.root : root, projectId, Date.now());
    rekeyUnder(db, root);
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
    for (const r of db.prepare("SELECT id, file FROM artifacts WHERE project_id = ?").all(from.id) as unknown as { id: string; file: string }[]) placeArtifact(db, r.id, r.file);
    db.prepare("DELETE FROM projects WHERE id = ?").run(from.id);
    prune(db);
    return into;
  });
}

/** `project rename <p> <name>`. */
export function renameProject(db: sqlite.DatabaseSync, ref: string, name: string): ProjectRow {
  return inTransaction(db, () => {
    const p = needProject(db, ref);
    db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, p.id);
    return { ...p, name };
  });
}

/** `project forget-root <dir>`: drop a root; its pages are resolved again (a `.git` or their folder). */
export function forgetRoot(db: sqlite.DatabaseSync, dir: string): { root: string; project: string } {
  const want = canonicalFile(dir);
  return inTransaction(db, () => {
    const row = allRoots(db).find((r) => pathKey(r.root) === pathKey(want));
    if (!row) throw new Error(`not a project root: ${want} (\`project list\` shows them)`);
    const name = (db.prepare("SELECT name FROM projects WHERE id = ?").get(row.project_id) as { name: string } | undefined)?.name || row.project_id;
    db.prepare("DELETE FROM project_roots WHERE root = ?").run(row.root);
    for (const a of db.prepare("SELECT id, file FROM artifacts WHERE root = ?").all(row.root) as unknown as { id: string; file: string }[]) placeArtifact(db, a.id, a.file);
    prune(db);
    return { root: row.root, project: name };
  });
}
