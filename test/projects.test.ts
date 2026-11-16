// Projects without git: roots from `.git` hints, worktrees grouped with their repository,
// assigned roots, merge, and pages keyed by project and path.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type * as sqlite from "node:sqlite";
import { Hub, openDatabase } from "../src/cli/hub.ts";
import { addRoot, copyLabel, findProject, forgetRoot, listProjects, mergeProjects, pageIdOf, pathKey, renameProject, resolveProject, within } from "../src/cli/projects.ts";

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-projects-")));
}

function write(file: string, text = "<title>x</title>"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A repository with a `.git` directory on `branch`. */
function repo(dir: string, branch = "main"): string {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return dir;
}

/** A linked worktree of `main` at `dir`, as git lays it out: a `.git` file pointing at `.git/worktrees/<name>`, which holds `commondir`. */
function worktree(main: string, dir: string, head: string): string {
  const gitdir = path.join(main, ".git", "worktrees", path.basename(dir));
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), head + "\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitdir}\n`);
  return dir;
}

async function withDb(fn: (db: sqlite.DatabaseSync, dir: string) => void | Promise<void>): Promise<void> {
  const dir = tmp();
  const db = await openDatabase(":memory:");
  try {
    await fn(db, dir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rootCount = (db: sqlite.DatabaseSync): number => Number((db.prepare("SELECT COUNT(*) AS n FROM project_roots").get() as { n: number }).n);

test("a plain folder is its own project, stored on first sight", () =>
  withDb((db, dir) => {
    const file = write(path.join(dir, "notes", "a.html"));
    const loc = resolveProject(db, file);
    assert.equal(loc.root, path.join(dir, "notes"));
    assert.equal(loc.kind, "folder");
    assert.equal(loc.relPath, "a.html");
    assert.equal(loc.pageId, pageIdOf(loc.projectId, "a.html"));
    assert.equal(findProject(db, loc.projectId)?.name, "notes");
    assert.equal(rootCount(db), 1);
    assert.deepEqual(resolveProject(db, file), loc, "the second lookup finds the stored root");
    assert.equal(rootCount(db), 1);
    // A page in a subfolder of a guessed folder root is not pulled into it.
    const deeper = resolveProject(db, write(path.join(dir, "notes", "sub", "b.html")));
    assert.notEqual(deeper.projectId, loc.projectId);
    assert.equal(deeper.root, path.join(dir, "notes", "sub"));
  }));

test("a repository with a .git directory is a git root; its branch labels the copy", () =>
  withDb((db, dir) => {
    const r = repo(path.join(dir, "shop"), "feature/x");
    const loc = resolveProject(db, write(path.join(r, "docs", "plan.html")));
    assert.equal(loc.root, r);
    assert.equal(loc.kind, "git");
    assert.equal(loc.relPath, "docs/plan.html");
    assert.equal(copyLabel(r), "feature/x");
    fs.writeFileSync(path.join(r, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    assert.equal(copyLabel(r), "0123456", "detached: the first 7 characters");
    assert.equal(copyLabel(path.join(dir)), path.basename(dir), "no .git: the folder's name");
  }));

test("a worktree groups with its main repository: one page, two copies", () =>
  withDb((db, dir) => {
    const main = repo(path.join(dir, "shop"));
    const wt = worktree(main, path.join(dir, "shop-feat"), "ref: refs/heads/feat");
    // The worktree is seen first: its main repository becomes a root of the same project.
    const b = resolveProject(db, write(path.join(wt, "docs", "plan.html")));
    const a = resolveProject(db, write(path.join(main, "docs", "plan.html")));
    assert.equal(b.kind, "worktree");
    assert.equal(b.root, wt);
    assert.equal(a.root, main);
    assert.equal(a.projectId, b.projectId);
    assert.equal(a.pageId, b.pageId);
    assert.equal(copyLabel(main), "main");
    assert.equal(copyLabel(wt), "feat");
    assert.deepEqual(listProjects(db).map((p) => [p.name, p.roots.map((r) => r.kind).sort()]), [["shop", ["git", "worktree"]]]);
  }));

test("a submodule (a .git file with no commondir) is its own project", () =>
  withDb((db, dir) => {
    const main = repo(path.join(dir, "app"));
    const modules = path.join(main, ".git", "modules", "lib");
    fs.mkdirSync(modules, { recursive: true });
    fs.writeFileSync(path.join(modules, "HEAD"), "ref: refs/heads/trunk\n");
    const sub = path.join(main, "lib");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/lib\n");
    const outer = resolveProject(db, write(path.join(main, "plan.html")));
    const inner = resolveProject(db, write(path.join(sub, "plan.html")));
    assert.notEqual(inner.projectId, outer.projectId);
    assert.equal(inner.root, sub);
    assert.equal(inner.kind, "git");
    assert.equal(copyLabel(sub), "trunk", "a relative gitdir resolves from the folder holding .git");
  }));

test("an assigned parent root wins over a nested .git", () =>
  withDb((db, dir) => {
    const work = path.join(dir, "work");
    repo(path.join(work, "inner"));
    const { project } = addRoot(db, work, "everything");
    const loc = resolveProject(db, write(path.join(work, "inner", "docs", "x.html")));
    assert.equal(loc.projectId, project.id);
    assert.equal(loc.root, work);
    assert.equal(loc.kind, "assigned");
    assert.equal(loc.relPath, "inner/docs/x.html");
  }));

test("project add <folder>: pages in two subfolders become one project", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const folder = path.join(dir, "plans");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(folder, "q1", "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(folder, "q2", "plan.html")) });
    assert.equal(new Set(hub.list({ all: true }).map((p) => p.project_id)).size, 2);
    const { project } = addRoot(db, folder);
    assert.equal(project.name, "plans");
    const pages = hub.list({ all: true });
    assert.deepEqual(pages.map((p) => [p.project, p.rel_path]).sort(), [["plans", "q1/plan.html"], ["plans", "q2/plan.html"]]);
    assert.deepEqual(listProjects(db).map((p) => p.name), ["plans"], "the guessed folder projects are gone");
  }));

test("project add refuses a root inside, or around, another project's root", () =>
  withDb((db, dir) => {
    const a = repo(path.join(dir, "a"));
    resolveProject(db, write(path.join(a, "x.html")));
    fs.mkdirSync(path.join(a, "docs"), { recursive: true });
    assert.throws(() => addRoot(db, path.join(a, "docs"), "other"), /inside .*a, a root of project a/);
    assert.throws(() => addRoot(db, dir, "all"), /a root of project a, is inside/);
    assert.throws(() => addRoot(db, path.join(dir, "nope")), /not a folder/);
  }));

test("project merge moves roots and re-keys pages; rename; forget-root", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    // Two clones git does not tie together: two projects until merged.
    const one = repo(path.join(dir, "one"));
    const two = repo(path.join(dir, "two"), "dev");
    hub.register({ id: "111111111111", file: write(path.join(one, "docs", "plan.html")) });
    hub.register({ id: "222222222222", file: write(path.join(two, "docs", "plan.html")) });
    assert.equal(hub.list({ all: true }).length, 2);
    const merged = mergeProjects(db, "one", two);
    assert.equal(merged.name, "one");
    let pages = hub.list({ all: true });
    assert.equal(pages.length, 1, "one page");
    assert.deepEqual(pages[0].copies.map((c) => c.label).sort(), ["dev", "main"]);
    assert.equal(pages[0].id, pageIdOf(merged.id, "docs/plan.html"));
    assert.equal(resolveProject(db, path.join(two, "docs", "new.html")).projectId, merged.id, "a later lookup lands in the merged project");
    assert.throws(() => mergeProjects(db, "one", "one"), /same project/);
    assert.throws(() => mergeProjects(db, "one", "nothing-here"), /no project nothing-here/);

    assert.equal(renameProject(db, merged.id, "shop").name, "shop");
    assert.equal(findProject(db, "shop")?.id, merged.id);
    assert.equal(findProject(db, path.join(two, "docs"))?.id, merged.id, "a folder inside a root names its project");

    // Forgetting a root resolves its pages again: the .git is still there, so it comes back on its own.
    forgetRoot(db, two);
    pages = hub.list({ all: true });
    assert.equal(pages.length, 2, "split again");
    assert.throws(() => forgetRoot(db, path.join(dir, "elsewhere")), /not a project root/);
  }));

test("a path through a symlink resolves to the same project and page", () =>
  withDb((db, dir) => {
    const r = repo(path.join(dir, "real"));
    const file = write(path.join(r, "docs", "plan.html"));
    const link = path.join(dir, "link");
    fs.symlinkSync(r, link, "dir");
    const viaLink = resolveProject(db, path.join(link, "docs", "plan.html"));
    const direct = resolveProject(db, file);
    assert.equal(viaLink.root, r);
    assert.equal(viaLink.file, file);
    assert.equal(viaLink.pageId, direct.pageId);
    assert.equal(rootCount(db), 1);
  }));

test("paths inside a root keep spaces and non-ASCII; Windows paths compare case-insensitively", () =>
  withDb((db, dir) => {
    const r = repo(path.join(dir, "shop"));
    const loc = resolveProject(db, write(path.join(r, "Pläne Q1", "über plan.html")));
    assert.equal(loc.relPath, "Pläne Q1/über plan.html");
    assert.equal(loc.pageId, pageIdOf(loc.projectId, "Pläne Q1/über plan.html"));
    assert.equal(pathKey("C:\\Work\\Shop", "win32"), "c:\\work\\shop");
    assert.ok(within("C:\\Work", "c:\\work\\shop\\a.html", "win32"));
    assert.ok(!within("C:\\Work", "C:\\Workshop\\a.html", "win32"));
    assert.ok(!within("/work", "/Work/a.html", "linux"));
    assert.ok(within("/", "/a.html", "linux"));
  }));

test("projects never run git", () => {
  for (const f of ["src/cli/projects.ts", "src/cli/hub.ts"]) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /child_process/, f);
});
