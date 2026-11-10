// Pure helpers for the austere-axi GitHub Action. No dependencies: runs on the runner's Node.
import fs from "node:fs";
import path from "node:path";

export const SITE = "https://github.com/MandalorianBatman/austere-axi";
export const MAX_COMMENT_ERRORS = 20;

/** One pattern per line; each is a path or a glob. Returns unique, sorted paths relative to `cwd`. */
export function expandPages(input, cwd) {
  const patterns = String(input || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const found = new Set();
  for (const pattern of patterns) {
    for (const hit of fs.globSync(pattern, { cwd })) {
      if (fs.statSync(path.resolve(cwd, hit)).isFile()) found.add(hit.split(path.sep).join("/"));
    }
  }
  return [...found].sort();
}

function scalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Read `austere-axi check` output (compact YAML): status, statements, errors, warnings.
 * @param {string} text
 */
export function parseCheck(text) {
  const out = { status: "", statements: 0, error: "", errors: /** @type {Record<string, any>[]} */ ([]), warnings: 0 };
  let section = "";
  /** @type {Record<string, any> | null} */
  let item = null;
  for (const line of String(text).split(/\r?\n/)) {
    const top = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (top) {
      section = top[1];
      item = null;
      const value = top[2] === undefined ? "" : scalar(top[2]);
      if (section === "status") out.status = String(value);
      else if (section === "statements") out.statements = Number(value) || 0;
      else if (section === "error") out.error = String(value);
      continue;
    }
    if (section !== "errors" && section !== "warnings") continue;
    const start = /^ {2}- ([a-z_]+): ?(.*)$/.exec(line);
    if (start) {
      item = { [start[1]]: scalar(start[2]) };
      if (section === "errors") out.errors.push(item);
      else out.warnings++;
      continue;
    }
    const field = /^ {4}([a-z_]+): ?(.*)$/.exec(line);
    if (field && item) item[field[1]] = scalar(field[2]);
  }
  return out;
}

export function pageTitle(html, fallback) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = m ? m[1].replace(/\s+/g, " ").trim() : "";
  return title || fallback;
}

/** Text from a PR is untrusted: neutralize markdown, HTML and table syntax. */
export function escapeMd(text, max = 200) {
  let s = String(text).replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s.replace(/[\\`*_[\]<>#|~&@]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function marker(tag) {
  return `<!-- austere-axi-review:${tag} -->`;
}

/**
 * @typedef {{ page: string, title: string, ok: boolean, statements: number, warnings: number,
 *   errors: { statement?: string, line?: number, message?: string, code?: string }[], error?: string, exported?: string }} PageResult
 */

/**
 * @param {PageResult[]} results
 * @param {{ tag: string, artifactUrl?: string, runUrl?: string }} opts
 */
export function renderComment(results, { tag, artifactUrl, runUrl }) {
  const failed = results.filter((r) => !r.ok);
  const exported = results.filter((r) => r.exported);
  const lines = [marker(tag), ""];
  lines.push(
    failed.length
      ? `### austere review: ${failed.length} of ${results.length} page${results.length === 1 ? "" : "s"} failed \`austere-axi check\``
      : `### austere review: ${results.length} page${results.length === 1 ? "" : "s"} ready`,
  );
  lines.push("", "| Page | Check | Statements | Warnings |", "|---|---|---|---|");
  for (const r of results) {
    const name = `\`${r.page.replace(/`/g, "")}\``;
    const title = r.title && r.title !== r.page ? ` ${escapeMd(r.title, 80)}` : "";
    lines.push(`| ${name}${title} | ${r.ok ? "ok" : "**errors**"} | ${r.ok ? r.statements : "-"} | ${r.warnings} |`);
  }
  let shown = 0;
  let omitted = 0;
  const errorLines = [];
  for (const r of failed) {
    const list = r.errors.length ? r.errors : [{ message: r.error || "check failed" }];
    for (const e of list) {
      if (shown >= MAX_COMMENT_ERRORS) {
        omitted++;
        continue;
      }
      shown++;
      const where = e.statement ? `${e.statement}${e.line ? `:${e.line}` : ""}: ` : "";
      errorLines.push(`- \`${r.page.replace(/`/g, "")}\` ${where ? `${escapeMd(where, 80)} ` : ""}${escapeMd(e.message || e.code || "error", 300)}`);
    }
  }
  if (errorLines.length) {
    lines.push("", ...errorLines);
    if (omitted) lines.push(`- …and ${omitted} more in the job log`);
  }
  lines.push("");
  if (exported.length) {
    const link = artifactUrl || runUrl;
    lines.push(
      link
        ? `**[Download the review page${exported.length === 1 ? "" : "s"}](${link})** (workflow artifact${artifactUrl ? "" : ", see the run's Artifacts section"}). Unzip and open in a browser; each file is self-contained and works offline.`
        : "The review pages are in this run's workflow artifacts.",
    );
  } else if (runUrl) {
    lines.push(`No page was exported. Errors are in [the job log](${runUrl}).`);
  }
  lines.push("", `<sub>made with [austere-axi](${SITE})</sub>`);
  return lines.join("\n");
}

/**
 * Create or update the one comment carrying `marker(tag)` that this token posted. Anyone can write a comment that
 * starts with the marker, so only the token's own account counts: `GET /user` names it for a user token; the
 * workflow's `github.token` and app tokens cannot call it and post as a bot.
 * @param {{ api: string, repo: string, pr: number, token: string, body: string, tag: string, fetch?: typeof fetch }} o
 * @returns {Promise<{ action: "created" | "updated", url: string }>}
 */
export async function upsertComment({ api, repo, pr, token, body, tag, fetch: f = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "austere-axi-action",
  };
  const call = async (method, url, payload) => {
    const res = await f(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
    if (!res.ok) {
      const err = new Error(`${method} ${url.replace(api, "")} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      /** @type {any} */ (err).status = res.status;
      throw err;
    }
    return res.json();
  };
  const mark = marker(tag);
  /** @type {string | null} */
  let login = null;
  try {
    login = (await call("GET", `${api}/user`))?.login || null;
  } catch {}
  const ours = (c) => (login ? c.user?.login === login : c.user?.type === "Bot");
  let existing = null;
  for (let page = 1; !existing; page++) {
    const batch = await call("GET", `${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    existing = batch.find((c) => typeof c.body === "string" && c.body.startsWith(mark) && ours(c)) || null;
    if (batch.length < 100) break;
  }
  if (existing) {
    const c = await call("PATCH", `${api}/repos/${repo}/issues/comments/${existing.id}`, { body });
    return { action: "updated", url: c.html_url };
  }
  const c = await call("POST", `${api}/repos/${repo}/issues/${pr}/comments`, { body });
  return { action: "created", url: c.html_url };
}

/**
 * `cli` as a program and arguments to spawn without a shell: a shell would re-parse the page paths, which the PR controls.
 * On Windows `npx` is a `.cmd` shim that Node starts only through a shell, so it becomes this Node running npm's
 * `npx-cli.js`, from the first `npx.cmd` on PATH (as the shell would pick it) or from next to this Node.
 * @param {string[]} cli
 * @param {{ platform?: string, env?: Record<string, string | undefined>, execPath?: string, exists?: (p: string) => boolean }} [o]
 * @returns {string[]}
 */
export function resolveCli(cli, { platform = process.platform, env = process.env, execPath = process.execPath, exists = fs.existsSync } = {}) {
  if (platform !== "win32" || cli[0] !== "npx") return cli;
  const entry = (dir) => path.win32.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
  const onPath = String(env.PATH || "").split(";").map((d) => d.replace(/"/g, "").trim()).filter(Boolean);
  const dir = onPath.find((d) => exists(path.win32.join(d, "npx.cmd")) && exists(entry(d))) ?? path.win32.dirname(execPath);
  return exists(entry(dir)) ? [execPath, entry(dir), ...cli.slice(1)] : cli;
}
