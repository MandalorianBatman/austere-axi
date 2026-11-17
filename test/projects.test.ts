// Projects without git: roots from `.git` hints, worktrees grouped with their repository,
// assigned roots, merge, and pages keyed by project and path.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type * as sqlite from "node:sqlite";
import { Hub, openDatabase } from "../src/cli/hub.ts";
import { hubPage } from "../src/cli/hub-page.ts";
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

/** A linked worktree of `main` at `dir`, as git lays it out: a `.git` file pointing at `.git/worktrees/<name>`, which holds `commondir` and `gitdir` (back to the `.git` file). */
function worktree(main: string, dir: string, head: string): string {
  const gitdir = path.join(main, ".git", "worktrees", path.basename(dir));
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), head + "\n");
  fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(dir, ".git") + "\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitdir}\n`);
  return dir;
}

/** A `config` with `url` under `[remote "origin"]`, or none, and other sections around it, as git writes them. */
function gitConfig(origin?: string): string {
  return `[core]\n\trepositoryformatversion = 0\n\tbare = true\n${origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""}[branch "main"]\n\tremote = origin\n\turl = https://example.com/not-origin.git\n`;
}

/** A bare repository at `dir` (`HEAD` and `config` in the folder itself), as multica keeps one: `.repos/<ws>/github.com+owner+name.git`. */
function bare(dir: string, origin?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "config"), gitConfig(origin));
  return dir;
}

/** A linked worktree of the bare repository `repoDir` at `dir`: its git dir is `<repoDir>/worktrees/<name>`. */
function bareWorktree(repoDir: string, dir: string, branch: string): string {
  const gitdir = path.join(repoDir, "worktrees", path.basename(path.dirname(dir)) + path.basename(dir));
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(dir, ".git") + "\n");
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
    // A page in a subfolder of a guessed folder root is in its project: the same rule as a lookup by folder.
    const deeper = resolveProject(db, write(path.join(dir, "notes", "sub", "b.html")));
    assert.equal(deeper.projectId, loc.projectId);
    assert.equal(deeper.relPath, "sub/b.html");
    assert.equal(findProject(db, path.join(dir, "notes", "sub"))?.id, loc.projectId);
  }));

test("no .git: pages in two subfolders, opened from the parent, are one project the parent finds", () =>
  withDb((db, dir) => {
    const notes = path.join(dir, "notes");
    const a = resolveProject(db, write(path.join(notes, "a", "sprint.html")), notes);
    const b = resolveProject(db, write(path.join(notes, "b", "plan.html")), notes);
    assert.equal(a.root, notes);
    assert.equal(b.projectId, a.projectId);
    assert.deepEqual([a.relPath, b.relPath], ["a/sprint.html", "b/plan.html"]);
    assert.deepEqual(listProjects(db).map((p) => p.name), ["notes"], "no projects named a and b");
    assert.equal(findProject(db, notes)?.id, a.projectId, "the folder the pages were opened from finds them");
    // The working folder counts only when the file is inside it.
    const away = resolveProject(db, write(path.join(dir, "elsewhere", "x.html")), notes);
    assert.equal(away.root, path.join(dir, "elsewhere"));
  }));

test("nested guessed roots: the parent's root takes in the child's, so the parent finds the child's pages", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const work = path.join(dir, "work");
    const reviews = path.join(work, "reviews");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(reviews, "plan.html")), cwd: reviews });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(work, "notes.html")), cwd: work });
    const parent = findProject(db, work);
    assert.equal(parent?.name, "work");
    assert.equal(findProject(db, reviews)?.id, parent?.id, "the child folder resolves to the same project");
    assert.deepEqual(hub.list({ all: true }).map((p) => [p.project, p.rel_path]).sort(), [["work", "notes.html"], ["work", "reviews/plan.html"]]);
    assert.deepEqual(listProjects(db).map((p) => [p.name, p.roots.map((r) => r.root)]), [["work", [work]]], "the child's guessed project is gone");
  }));

test("a guessed root is never / or the home folder for anything below it", () =>
  withDb((db, dir) => {
    const home = path.join(dir, "home");
    const wasHome = process.env.HOME;
    const wasProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const top = resolveProject(db, write(path.join(home, "todo.html")));
      assert.equal(top.root, home, "a page directly in the home folder has it as its root");
      const below = resolveProject(db, write(path.join(home, "proj", "x.html")), home);
      assert.equal(below.root, path.join(home, "proj"), "working in the home folder does not make it the root");
      assert.notEqual(below.projectId, top.projectId, "and the home folder's root holds only its own folder");
      assert.equal(findProject(db, path.join(home, "proj"))?.id, below.projectId);
      assert.equal(findProject(db, path.join(home, "other")), null, "a lookup applies the same rule");
      assert.equal(findProject(db, home)?.id, top.projectId);
    } finally {
      if (wasHome === undefined) delete process.env.HOME;
      else process.env.HOME = wasHome;
      if (wasProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = wasProfile;
    }
  }));

test("a lookup by folder follows a .git the way opening a page would", () =>
  withDb((db, dir) => {
    const work = path.join(dir, "work");
    resolveProject(db, write(path.join(work, "a.html")), work);
    const inner = repo(path.join(work, "inner"));
    assert.equal(findProject(db, path.join(inner, "docs")), null, "a repository not seen yet is no project, not the folder around it");
    const loc = resolveProject(db, write(path.join(inner, "docs", "x.html")), work);
    assert.equal(loc.kind, "git");
    assert.equal(findProject(db, path.join(inner, "docs"))?.id, loc.projectId);
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

test("a .git file that only claims a repository is its own project, whatever its git dir says", () =>
  withDb((db, dir) => {
    const main = repo(path.join(dir, "shop"));
    fs.writeFileSync(path.join(main, ".git", "config"), gitConfig("https://github.com/owner/shop.git"));
    const real = worktree(main, path.join(dir, "shop-feat"), "ref: refs/heads/feat");
    const shop = resolveProject(db, write(path.join(main, "docs", "plan.html")));
    // `.git` → `gitdir: meta`, `meta/commondir` → the real repository; `meta/gitdir` missing, naming
    // another worktree's `.git`, then naming this folder's own `.git`: the forger writes `meta/` too.
    const forged = path.join(dir, "copy");
    const meta = path.join(forged, "meta");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, "commondir"), path.join(main, ".git") + "\n");
    fs.writeFileSync(path.join(meta, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(forged, ".git"), "gitdir: meta\n");
    for (const back of [null, path.join(real, ".git"), path.join(forged, ".git")]) {
      if (back) fs.writeFileSync(path.join(meta, "gitdir"), back + "\n");
      assert.equal(findProject(db, forged), null, `nothing claims it before it is stored (back-pointer ${back})`);
    }
    const loc = resolveProject(db, write(path.join(forged, "docs", "plan.html")));
    assert.notEqual(loc.projectId, shop.projectId);
    assert.notEqual(loc.pageId, shop.pageId);
    assert.equal(loc.root, forged);
    assert.equal(loc.kind, "git");
    const copy = listProjects(db).find((p) => p.id === loc.projectId);
    assert.equal(copy?.name, "copy", "not named from the claimed repository's origin");
    assert.equal(copy?.sameAs, undefined, "no hint to merge into the claimed repository's project");
  }));

test("a folder whose .git is a symlink to a real worktree's .git file is its own project", (t) =>
  withDb((db, dir) => {
    const main = repo(path.join(dir, "shop"));
    const real = worktree(main, path.join(dir, "shop-feat"), "ref: refs/heads/feat");
    const shop = resolveProject(db, write(path.join(main, "docs", "plan.html")));
    const linked = path.join(dir, "linked");
    fs.mkdirSync(linked);
    try {
      fs.symlinkSync(path.join(real, ".git"), path.join(linked, ".git"), "file");
    } catch {
      t.skip("no symlinks here");
      return;
    }
    const loc = resolveProject(db, write(path.join(linked, "docs", "plan.html")));
    assert.notEqual(loc.projectId, shop.projectId);
    assert.equal(loc.kind, "git");
  }));

test("a worktree with relative paths both ways (worktree.useRelativePaths) groups with its repository", () =>
  withDb((db, dir) => {
    const main = repo(path.join(dir, "shop"));
    const wt = path.join(dir, "shop-rel");
    const gitdir = path.join(main, ".git", "worktrees", "shop-rel");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/rel\n");
    fs.writeFileSync(path.join(gitdir, "gitdir"), "../../../../shop-rel/.git\n");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../shop/.git/worktrees/shop-rel\n");
    const b = resolveProject(db, write(path.join(wt, "docs", "plan.html")));
    const a = resolveProject(db, write(path.join(main, "docs", "plan.html")));
    assert.equal(b.kind, "worktree");
    assert.equal(a.pageId, b.pageId);
    assert.equal(copyLabel(wt), "rel");
  }));

test("an assigned parent root wins over a nested .git: its project; the repository's folder starts its page paths", () =>
  withDb((db, dir) => {
    const work = path.join(dir, "work");
    const inner = repo(path.join(work, "inner"));
    const { project } = addRoot(db, work, "everything");
    const loc = resolveProject(db, write(path.join(inner, "docs", "x.html")));
    assert.equal(loc.projectId, project.id);
    assert.equal(loc.root, inner);
    assert.equal(loc.kind, "git");
    assert.equal(loc.relPath, "inner/docs/x.html");
    const loose = resolveProject(db, write(path.join(work, "notes", "y.html")));
    assert.equal(loose.projectId, project.id);
    assert.equal(loose.root, work, "a page outside any repository is under the assigned root");
    assert.equal(loose.relPath, "notes/y.html");
  }));

test("inside an assigned root, a page and the same path in nested repositories are different pages", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const work = path.join(dir, "work");
    repo(path.join(work, "a"));
    repo(path.join(work, "b"));
    addRoot(db, work, "work");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(work, "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(work, "a", "plan.html")) });
    hub.register({ id: "cccccccccccc", file: write(path.join(work, "b", "plan.html")) });
    assert.deepEqual(hub.list({ all: true }).map((p) => [p.rel_path, p.copies.length]).sort(), [["a/plan.html", 1], ["b/plan.html", 1], ["plan.html", 1]]);
  }));

for (const order of ["worktree first", "repository first"]) {
  test(`a worktree outside an assigned root holding its repository: one project, one page (${order})`, () =>
    withDb((db, dir) => {
      const work = path.join(dir, "work");
      const main = repo(path.join(work, "shop"));
      const wt = worktree(main, path.join(dir, "elsewhere", "shop-feat"), "ref: refs/heads/feat");
      const { project } = addRoot(db, work, "work");
      const files = [write(path.join(wt, "docs", "plan.html")), write(path.join(main, "docs", "plan.html"))];
      if (order === "repository first") files.reverse();
      const [first, second] = files.map((f) => resolveProject(db, f));
      const [b, a] = order === "worktree first" ? [first, second] : [second, first];
      assert.equal(b.projectId, project.id);
      assert.equal(b.kind, "worktree");
      assert.equal(a.projectId, project.id);
      assert.equal(a.root, main, "the copy root is the repository, inside the assigned root");
      assert.deepEqual([a.relPath, b.relPath], ["shop/docs/plan.html", "shop/docs/plan.html"]);
      assert.equal(a.pageId, b.pageId, "one page, two copies");
      assert.deepEqual(listProjects(db).map((p) => [p.name, p.roots.map((r) => r.kind).sort()]), [["work", ["assigned", "git", "worktree"]]]);
    }));
}

test("a worktree inside an assigned root, its repository outside: the repository and its other worktrees join the same pages", () =>
  withDb((db, dir) => {
    const work = path.join(dir, "work");
    fs.mkdirSync(work, { recursive: true });
    const main = repo(path.join(dir, "repos", "shop"));
    const { project } = addRoot(db, work, "work");
    const inside = resolveProject(db, write(path.join(worktree(main, path.join(work, "shop-feat"), "ref: refs/heads/feat"), "docs", "plan.html")));
    const other = resolveProject(db, write(path.join(worktree(main, path.join(dir, "repos", "shop-other"), "ref: refs/heads/other"), "docs", "plan.html")));
    const mainLoc = resolveProject(db, write(path.join(main, "docs", "plan.html")));
    const loose = resolveProject(db, write(path.join(work, "docs", "plan.html")));
    for (const loc of [inside, other, mainLoc]) {
      assert.equal(loc.projectId, project.id);
      assert.equal(loc.pageId, inside.pageId, `${loc.root}: one page`);
    }
    assert.equal(loose.projectId, project.id);
    assert.notEqual(loose.pageId, inside.pageId, "the assigned root's own page is another page");
  }));

test("project add around a repository of the same project re-keys its pages under the new root", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const work = path.join(dir, "work");
    const shop = repo(path.join(work, "shop"));
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(shop, "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(work, "plan.html")) });
    addRoot(db, work, "shop", { yes: true });
    assert.deepEqual(hub.list({ all: true }).map((p) => [p.project, p.rel_path]).sort(), [["shop", "plan.html"], ["shop", "shop/plan.html"]]);
  }));

test("two worktrees under an assigned root of another project than their repository: one page, two copies", () =>
  withDb((db, dir) => {
    const main = repo(path.join(dir, "repos", "shop"));
    const indexed = resolveProject(db, write(path.join(main, "docs", "plan.html")));
    const work = path.join(dir, "work");
    fs.mkdirSync(work, { recursive: true });
    const { project } = addRoot(db, work, "work");
    const a = resolveProject(db, write(path.join(worktree(main, path.join(work, "feat-a"), "ref: refs/heads/a"), "docs", "plan.html")));
    const b = resolveProject(db, write(path.join(worktree(main, path.join(work, "feat-b"), "ref: refs/heads/b"), "docs", "plan.html")));
    assert.notEqual(indexed.projectId, project.id);
    assert.deepEqual([a.projectId, b.projectId], [project.id, project.id]);
    assert.equal(a.pageId, b.pageId);
    assert.notEqual(a.pageId, resolveProject(db, write(path.join(work, "docs", "plan.html"))).pageId);
    // The owner assigns one of the worktrees as a root of the same project: later worktrees still join.
    addRoot(db, path.join(work, "feat-a"), "work");
    const c = resolveProject(db, write(path.join(worktree(main, path.join(work, "feat-c"), "ref: refs/heads/c"), "docs", "plan.html")));
    assert.deepEqual([resolveProject(db, path.join(work, "feat-a", "docs", "plan.html")).pageId, c.pageId], [a.pageId, a.pageId]);
  }));

test("project add absorbs a guessed folder root below it, even of the project it names", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const plans = path.join(dir, "plans");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(plans, "sub", "plan.html")) });
    assert.equal(findProject(db, "sub")?.name, "sub", "the guessed project is named after its folder");
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(plans, "plan.html")) });
    addRoot(db, plans, "sub", { yes: true });
    const pages = hub.list({ all: true });
    assert.deepEqual(pages.map((p) => [p.rel_path, p.copies.length]).sort(), [["plan.html", 1], ["sub/plan.html", 1]], "two pages, not two copies of one");
    assert.deepEqual(listProjects(db).map((p) => [p.name, p.roots.map((r) => r.kind)]), [["sub", ["assigned"]]]);
  }));

test("project add <folder>: pages in two subfolders become one project, after it lists the projects it takes in and gets yes", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const folder = path.join(dir, "plans");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(folder, "q1", "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(folder, "q2", "plan.html")) });
    renameProject(db, "q1", "roadmap");
    const before = listProjects(db);
    assert.equal(before.length, 2);
    // Without yes: what it would take in, by name (the owner's too), and nothing changes.
    const asked = addRoot(db, folder);
    assert.equal(asked.added, false);
    assert.deepEqual(
      asked.absorbed.map((a) => [a.project, a.pages, a.roots]).sort(),
      [["q2", 1, [path.join(folder, "q2")]], ["roadmap", 1, [path.join(folder, "q1")]]],
    );
    assert.deepEqual(listProjects(db), before, "nothing changed");
    const { project, added, absorbed } = addRoot(db, folder, undefined, { yes: true });
    assert.equal(added, true);
    assert.equal(absorbed.length, 2, "the result still says what it took in");
    assert.equal(project.name, "plans");
    const pages = hub.list({ all: true });
    assert.deepEqual(pages.map((p) => [p.project, p.rel_path]).sort(), [["plans", "q1/plan.html"], ["plans", "q2/plan.html"]]);
    assert.deepEqual(listProjects(db).map((p) => p.name), ["plans"], "the guessed folder projects are gone");
    // A root of its own project only: nothing to confirm.
    fs.mkdirSync(path.join(dir, "empty"));
    assert.equal(addRoot(db, path.join(dir, "empty")).added, true);
  }));

test("project add refuses /, the home folder and a folder holding it", () =>
  withDb((db) => {
    const home = fs.realpathSync(os.homedir());
    for (const dir of [path.parse(home).root, home, path.dirname(home)]) {
      assert.throws(() => addRoot(db, dir, "everything", { yes: true }), /cannot be a root/, dir);
    }
    assert.equal(rootCount(db), 0);
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

test("project rename refuses a name another project has", () =>
  withDb((db, dir) => {
    const shop = resolveProject(db, write(path.join(repo(path.join(dir, "shop")), "a.html")));
    const b = resolveProject(db, write(path.join(repo(path.join(dir, "b")), "a.html")));
    assert.throws(() => renameProject(db, b.projectId, "shop"), /already named shop/);
    assert.equal(findProject(db, "shop")?.id, shop.projectId, "the name still finds one project");
    assert.equal(renameProject(db, "shop", "shop").name, "shop", "a project may keep its own name");
  }));

test("names: never empty, never shaped like an id; two projects of one name are told apart by their main root", () =>
  withDb((db, dir) => {
    const one = resolveProject(db, write(path.join(repo(path.join(dir, "one", "shop")), "a.html")));
    const two = resolveProject(db, write(path.join(repo(path.join(dir, "two", "shop")), "a.html")));
    assert.throws(() => renameProject(db, one.projectId, ""), /cannot be empty/);
    assert.throws(() => renameProject(db, one.projectId, "   "), /cannot be empty/);
    assert.throws(() => renameProject(db, one.projectId, two.projectId), /shaped like a project id/);
    fs.mkdirSync(path.join(dir, "x"));
    assert.throws(() => addRoot(db, path.join(dir, "x"), ""), /cannot be empty/);
    assert.throws(() => addRoot(db, path.join(dir, "x"), two.projectId), /shaped like a project id/);
    assert.equal(rootCount(db), 2, "nothing stored");
    // New projects of one name get a suffix (RLM-390); one made before that, or by hand, can still share it.
    db.prepare("UPDATE projects SET name = 'shop' WHERE id IN (?, ?)").run(one.projectId, two.projectId);
    assert.throws(
      () => findProject(db, "shop"),
      (err: Error) => err.message.includes(`${one.projectId} (${path.join(dir, "one", "shop")})`) && err.message.includes(`${two.projectId} (${path.join(dir, "two", "shop")})`),
    );
    assert.equal(renameProject(db, one.projectId, "  first  ").name, "first", "trimmed");
  }));

test("forget-root on a root with a .git: it is found again at once, and the result says where its pages went", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const shop = repo(path.join(dir, "shop"));
    const feat = worktree(shop, path.join(dir, "shop-feat"), "ref: refs/heads/feat");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(shop, "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(feat, "plan.html")) });
    const old = findProject(db, "shop")!;
    const r = forgetRoot(db, shop);
    assert.equal(r.status, "found again");
    assert.ok(r.again && r.again.id !== old.id, "a new project");
    assert.deepEqual(r.went, [{ project: r.again.project, id: r.again.id, root: shop, pages: 1 }]);
    assert.equal(resolveProject(db, path.join(feat, "plan.html")).projectId, old.id, "the worktree stays in the old project");
  }));

test("forget-root on a root whose folder is gone: refused without --drop; --drop archives its pages and stores no root", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const moved = repo(path.join(dir, "moved"));
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(moved, "docs", "plan.html")) });
    const keep = resolveProject(db, write(path.join(repo(path.join(dir, "keep")), "a.html")));
    const project = findProject(db, "moved")!;
    assert.throws(() => forgetRoot(db, moved, { drop: true }), /still there/);
    fs.rmSync(moved, { recursive: true });
    assert.throws(() => forgetRoot(db, moved), /is gone: its 1 page copies .* --drop/);
    const r = forgetRoot(db, moved, { drop: true });
    assert.equal(r.status, "dropped");
    assert.deepEqual(r.archived, [path.join(moved, "docs", "plan.html")]);
    const row = hub.artifact("aaaaaaaaaaaa")!;
    assert.ok(row.archived_at, "archived, not deleted: its notes are kept");
    assert.equal(row.project_id, project.id, "it stays in its project");
    const rootsUnder = (): string[] => listProjects(db).flatMap((p) => p.roots.map((x) => x.root)).filter((x) => within(moved, x));
    assert.deepEqual(rootsUnder(), []);
    // A later re-key of its project files nothing under the folder that is gone; a merge carries the copy by its page path.
    mergeProjects(db, keep.projectId, project.id);
    assert.deepEqual(rootsUnder(), []);
    const merged = hub.artifact("aaaaaaaaaaaa")!;
    assert.equal(merged.project_id, keep.projectId);
    assert.equal(merged.page_id, pageIdOf(keep.projectId, "docs/plan.html"));
  }));

test("project add takes in a guessed folder root whose folder is gone: its copy joins the new root's project", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const plans = path.join(dir, "plans");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(plans, "q1", "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(plans, "q2", "plan.html")) });
    fs.rmSync(path.join(plans, "q1"), { recursive: true });
    const r = addRoot(db, plans, undefined, { yes: true });
    assert.deepEqual(r.absorbed.map((a) => [a.project, a.pages, a.roots]).sort(), [["q1", 1, [path.join(plans, "q1")]], ["q2", 1, [path.join(plans, "q2")]]]);
    const row = hub.artifact("aaaaaaaaaaaa")!;
    assert.equal(row.project_id, r.project.id);
    assert.equal(row.root, plans);
    assert.equal(row.page_id, pageIdOf(r.project.id, "q1/plan.html"));
    assert.deepEqual(listProjects(db).map((p) => [p.name, p.pages, p.roots.length]), [["plans", 2, 1]]);
  }));

test("forget-root --drop under a root above: the copies stay in their project, and a later merge carries them to its target", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const plans = path.join(dir, "plans");
    const gone = repo(path.join(plans, "repo"));
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(gone, "y.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(plans, "top.html")) });
    const project = findProject(db, "repo")!;
    fs.rmSync(gone, { recursive: true });
    forgetRoot(db, gone, { drop: true });
    assert.equal(hub.artifact("aaaaaaaaaaaa")!.project_id, project.id);
    assert.deepEqual(listProjects(db).map((p) => [p.name, p.pages]), [["plans", 1], ["repo", 1]]);
    // A merge re-keys every copy of both projects: the dropped copy goes to the target by its page path, not to the root above.
    const keep = resolveProject(db, write(path.join(repo(path.join(dir, "keep")), "a.html")));
    mergeProjects(db, keep.projectId, project.id);
    const moved = hub.artifact("aaaaaaaaaaaa")!;
    assert.equal(moved.project_id, keep.projectId);
    assert.equal(moved.page_id, pageIdOf(keep.projectId, "y.html"));
    assert.deepEqual(listProjects(db).map((p) => [p.name, p.pages]), [["keep", 1], ["plans", 1]]);
  }));

test("forget-root on a folder root with pages in it: found again as a folder, not as a .git", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const plans = path.join(dir, "plans");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(plans, "a.html")) });
    addRoot(db, plans);
    const r = forgetRoot(db, plans);
    assert.equal(r.status, "found again");
    assert.equal(r.again?.kind, "folder");
  }));

test("forget-root settles the other roots' prefixes and re-keys their pages", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const work = path.join(dir, "work");
    const docs = path.join(work, "docs");
    const nested = repo(path.join(work, "nested"));
    fs.mkdirSync(docs, { recursive: true });
    const other = path.join(dir, "other");
    fs.mkdirSync(other, { recursive: true });
    addRoot(db, work, "W");
    addRoot(db, docs, "W");
    addRoot(db, other, "W");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(docs, "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(nested, "docs", "plan.html")) });
    hub.register({ id: "cccccccccccc", file: write(path.join(other, "docs", "plan.html")) });
    hub.register({ id: "dddddddddddd", file: write(path.join(other, "plan.html")) });
    const paths = (): string[][] => hub.list({ all: true }).map((p) => [p.rel_path, p.copies.map((c) => c.id).sort().join(" ")]).sort();
    assert.deepEqual(paths(), [
      ["docs/plan.html", "aaaaaaaaaaaa cccccccccccc"],
      ["nested/docs/plan.html", "bbbbbbbbbbbb"],
      ["plan.html", "dddddddddddd"],
    ]);
    forgetRoot(db, work);
    // Without /work, /work/docs and the repository have no prefix: their pages' paths are inside them.
    assert.deepEqual(paths(), [
      ["docs/plan.html", "bbbbbbbbbbbb cccccccccccc"],
      ["plan.html", "aaaaaaaaaaaa dddddddddddd"],
    ]);
    assert.deepEqual((db.prepare("SELECT prefix FROM project_roots WHERE root IN (?, ?)").all(docs, nested) as { prefix: string }[]).map((r) => r.prefix), ["", ""]);
    const before = paths();
    addRoot(db, other, "W");
    assert.deepEqual(paths(), before, "nothing left for the next project add to re-key");
  }));

test("forget-root: worktrees of two repositories in one project stay two pages", async () =>
  withDb(async (db, dir) => {
    const hub = new Hub(db);
    const ra = repo(path.join(dir, "repos", "a"));
    const rb = repo(path.join(dir, "repos", "b"));
    hub.register({ id: "111111111111", file: write(path.join(ra, "docs", "plan.html")) });
    hub.register({ id: "222222222222", file: write(path.join(rb, "docs", "plan.html")) });
    const work = path.join(dir, "work");
    fs.mkdirSync(work, { recursive: true });
    addRoot(db, work, "W");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(worktree(ra, path.join(work, "wa"), "ref: refs/heads/a"), "docs", "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(worktree(rb, path.join(work, "wb"), "ref: refs/heads/b"), "docs", "plan.html")) });
    forgetRoot(db, work);
    const rows = hub.list({ all: true }).filter((p) => p.copies.some((c) => c.id === "aaaaaaaaaaaa" || c.id === "bbbbbbbbbbbb"));
    assert.deepEqual(rows.map((p) => [p.rel_path, p.copies.map((c) => c.id)]).sort(), [["wa/docs/plan.html", ["aaaaaaaaaaaa"]], ["wb/docs/plan.html", ["bbbbbbbbbbbb"]]]);
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

test("a bare repository with worktrees: one project named from its origin, the repository is the main root", () =>
  withDb((db, dir) => {
    const hub = new Hub(db);
    const repoDir = bare(path.join(dir, ".repos", "ws", "github.com+MandalorianBatman+austere-axi.git"), "https://github.com/MandalorianBatman/austere-axi.git");
    const a = bareWorktree(repoDir, path.join(dir, "runs", "a", "austere-axi"), "agent/a");
    const b = bareWorktree(repoDir, path.join(dir, "runs", "b", "austere-axi"), "agent/b");
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(b, "docs", "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(a, "docs", "plan.html")) });
    const projects = listProjects(db);
    assert.deepEqual(
      projects.map((p) => [p.name, p.roots]),
      [["austere-axi", [{ root: repoDir, kind: "git" }, { root: b, kind: "worktree" }, { root: a, kind: "worktree" }]]],
      "named after the repository, not github.com+…; the repository first, then its worktrees in the order stored",
    );
    assert.equal(projects[0].sameAs, undefined);
    assert.deepEqual(hub.projects()[0].roots[0], repoDir);
    assert.match(hubPage(hub.list({ all: true }), { version: "1", q: "", project: "", view: "all", projects: hub.projects(), counts: hub.viewCounts() }), /<h2><a [^>]*>austere-axi<\/a> <small title="[^"]*">[^<]*\+austere-axi\.git · \+2 more folders<\/small>/);
  }));

test("no origin: the folder's name without .git; a .bare folder takes its parent's", () =>
  withDb((db, dir) => {
    const named = bare(path.join(dir, "named.git"));
    const wt = resolveProject(db, write(path.join(bareWorktree(named, path.join(dir, "wt", "feat"), "feat"), "a.html")));
    assert.equal(findProject(db, wt.projectId)?.name, "named");
    const dotBare = bare(path.join(dir, "proj", ".bare"));
    const main = resolveProject(db, write(path.join(bareWorktree(dotBare, path.join(dir, "proj", "main"), "main"), "a.html")));
    assert.equal(findProject(db, main.projectId)?.name, "proj");
    const plain = resolveProject(db, write(path.join(repo(path.join(dir, "plain")), "a.html")));
    assert.equal(findProject(db, plain.projectId)?.name, "plain", "a .git with no config file");
  }));

test("two repositories with one name: the second takes its parent folder as a suffix", () =>
  withDb((db, dir) => {
    const one = resolveProject(db, write(path.join(repo(path.join(dir, "a", "shop")), "x.html")));
    const two = resolveProject(db, write(path.join(repo(path.join(dir, "b", "shop")), "x.html")));
    const three = resolveProject(db, write(path.join(repo(path.join(dir, "deeper", "b", "shop")), "x.html")));
    assert.deepEqual([one, two, three].map((l) => findProject(db, l.projectId)?.name), ["shop", "shop (b)", "shop (b) 2"]);
    assert.equal(findProject(db, "shop")?.id, one.projectId, "the name finds one project");
    const c = path.join(dir, "c", "shop");
    fs.mkdirSync(c, { recursive: true });
    assert.equal(addRoot(db, c).project.name, "shop (c)", "project add without --name too");
  }));

test("two clones of one repository: the newer project gets a merge hint, nothing is grouped", () =>
  withDb((db, dir) => {
    const hub = new Hub(db);
    const clone = repo(path.join(dir, "Austere"));
    fs.writeFileSync(path.join(clone, ".git", "config"), gitConfig("git@github.com:MandalorianBatman/austere-axi.git"));
    const repoDir = bare(path.join(dir, ".repos", "ws", "github.com+MandalorianBatman+austere-axi.git"), "https://github.com/MandalorianBatman/austere-axi");
    const wt = bareWorktree(repoDir, path.join(dir, "runs", "a", "austere-axi"), "agent/a");
    const other = repo(path.join(dir, "other"));
    fs.writeFileSync(path.join(other, ".git", "config"), gitConfig("https://github.com/MandalorianBatman/austere-cloud.git"));
    hub.register({ id: "aaaaaaaaaaaa", file: write(path.join(clone, "plan.html")) });
    hub.register({ id: "bbbbbbbbbbbb", file: write(path.join(wt, "plan.html")) });
    hub.register({ id: "cccccccccccc", file: write(path.join(other, "plan.html")) });

    let projects = listProjects(db);
    const older = projects.find((p) => p.roots[0].root === clone);
    const newer = projects.find((p) => p.roots[0].root === repoDir);
    assert.ok(older && newer && older.id !== newer.id, "two projects: suggest only, never grouped");
    assert.deepEqual([older.name, newer.name], ["austere-axi", "austere-axi (ws)"]);
    assert.equal(older.sameAs, undefined, "the hint is on the newer project");
    assert.deepEqual(newer.sameAs, { id: older.id, name: "austere-axi", merge: `project merge austere-axi ${newer.id}` }, "a name with a space is given as its id");
    assert.equal(projects.find((p) => p.name === "austere-cloud")?.sameAs, undefined, "another repository: no hint");
    const html = hubPage(hub.list({ all: true }), { version: "1", q: "", project: "", view: "all", projects: hub.projects(), counts: hub.viewCounts() });
    assert.ok(html.includes(`<p class="same">Same repository as project austere-axi: <code>austere-axi project merge austere-axi ${newer.id}</code></p>`), "the hub shows the hint");
    assert.equal(html.match(/class="same"/g)?.length, 1);

    // The owner follows the hint: one project, the first clone is its main root, and the hint is gone.
    mergeProjects(db, "austere-axi", newer.id);
    projects = listProjects(db).filter((p) => p.name !== "austere-cloud");
    assert.deepEqual(
      projects.map((p) => [p.name, p.roots.map((r) => r.root), p.sameAs]),
      [["austere-axi", [clone, repoDir, wt], undefined]],
    );
    assert.equal(hub.list({ all: true }).filter((p) => p.rel_path === "plan.html" && p.project === "austere-axi")[0].copies.length, 2, "one page, two copies");
  }));

test("origin url with quotes or trailing comments is parsed cleanly, and option-like names use id in merge hint", () =>
  withDb((db, dir) => {
    const r1 = repo(path.join(dir, "repo1"));
    fs.writeFileSync(path.join(r1, ".git", "config"), '[remote "origin"]\n\turl = "https://github.com/org/test-repo.git" # primary\n');
    const r2 = repo(path.join(dir, "repo2"));
    fs.writeFileSync(path.join(r2, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/org/test-repo.git ; secondary\n');
    const p1 = resolveProject(db, write(path.join(r1, "a.html")));
    const p2 = resolveProject(db, write(path.join(r2, "b.html")));
    assert.equal(findProject(db, p1.projectId)?.name, "test-repo");

    // Rename p1 to option-like name "-h": merge command in p2 should use p1 ID instead of "-h"
    db.prepare("UPDATE projects SET name = ? WHERE id = ?").run("-h", p1.projectId);
    const projects = listProjects(db);
    const newer = projects.find((p) => p.id === p2.projectId);
    assert.ok(newer?.sameAs);
    assert.equal(newer?.sameAs?.merge, `project merge ${p1.projectId} ${p2.projectId}`);
  }));
