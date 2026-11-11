// Step 1 of the action: `austere-axi check`, then `austere-axi export`, for every page.
// Writes the exported HTML to <RUNNER_TEMP>/austere-review and the results to <RUNNER_TEMP>/austere-results.json,
// prints the `check` output (errors included) to the log, and exits 1 if any page failed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandPages, pageTitle, parseCheck, resolveCli } from "./lib.ts";
import type { PageResult } from "./lib.ts";

const cwd = process.cwd();
const temp = process.env.RUNNER_TEMP || os.tmpdir();
const outDir = path.join(temp, "austere-review");
const resultsFile = path.join(temp, "austere-results.json");
const input = (process.env.INPUT_CLI || "").trim().split(/\s+/).filter(Boolean);
const cli = resolveCli(input.length ? input : ["npx", "-y", `austere-axi@${(process.env.INPUT_VERSION || "latest").trim()}`]);

// check registers pages with the hub when it is on; never touch a user-level state dir on a runner.
const env = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: path.join(temp, "austere-state"),
  AUSTERE_AXI_NO_OPEN: "1",
  AUSTERE_AXI_NO_TAILSCALE: "1",
};

function austere(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cli[0], [...cli.slice(1), ...args], {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
}

const oneLine = (s: unknown): string => String(s).replace(/[\r\n%]+/g, " ");

const pages = expandPages(process.env.INPUT_PAGES, cwd);
if (!pages.length) {
  console.log(`::error title=austere-axi::No page matched \`pages\`: ${oneLine(process.env.INPUT_PAGES || "(empty)")}`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const used = new Set<string>();
const results: PageResult[] = [];

for (const page of pages) {
  console.log(`\n$ austere-axi check ${page}`);
  const check = austere(["check", page]);
  process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);
  const parsed = parseCheck(check.stdout);
  const ok = check.code === 0 && parsed.status === "ok";
  const result: PageResult = {
    page,
    title: pageTitle(fs.readFileSync(path.resolve(cwd, page), "utf8"), path.basename(page)),
    ok,
    statements: parsed.statements,
    warnings: parsed.warnings,
    errors: parsed.errors,
    error: ok ? "" : parsed.error || check.stderr.trim().split("\n")[0] || "",
  };
  if (ok) {
    let name = path.basename(page).replace(/\.html?$/i, "") + ".html";
    for (let n = 2; used.has(name); n++) name = `${path.basename(page).replace(/\.html?$/i, "")}-${n}.html`;
    used.add(name);
    console.log(`$ austere-axi export ${page}`);
    const exported = austere(["export", page, "--out", path.join(outDir, name)]);
    process.stdout.write(exported.stdout);
    if (exported.stderr) process.stderr.write(exported.stderr);
    if (exported.code === 0 && fs.existsSync(path.join(outDir, name))) result.exported = name;
    else {
      result.ok = false;
      result.error = parseCheck(exported.stdout).error || "export failed";
      console.log(`::error file=${page},title=austere-axi export::${oneLine(result.error)}`);
    }
  } else {
    for (const e of result.errors.length ? result.errors : [{ message: result.error }]) {
      const where = e.statement ? `${e.statement}${e.line ? `:${e.line}` : ""} ` : "";
      console.log(`::error file=${page},title=austere-axi check::${oneLine(where + (e.message || e.code || "check failed"))}`);
    }
  }
  results.push(result);
}

fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${failed.length ? "false" : "true"}\nexported=${results.filter((r) => r.exported).length}\n`);
}
if (failed.length) {
  console.log(`\naustere-axi: ${failed.length} of ${results.length} page(s) failed: ${failed.map((r) => r.page).join(", ")}`);
  process.exit(1);
}
console.log(`\naustere-axi: ${results.length} page(s) checked and exported to ${outDir}`);
