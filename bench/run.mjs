// austere-axi vs lavish-axi: output tokens, time, cost, first-try validity and one
// revision round, for the same review pages on the same models.
//
//   npm run bench -- [--models minimax-m3,claude-sonnet] [--tasks id,...] [--tools austere,lavish]
//                    [--reps 3] [--concurrency 3] [--fresh]
//
// Results go to bench/results/: results.json (every trial, raw), pages/ (what each
// model wrote), summary.md, and docs/benchmark.svg. A run resumes: trials already in
// results.json are skipped, so an interrupted run or an added model only runs what
// is missing. --fresh starts over. Keys come from the environment (see models.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASKS } from "./tasks.mjs";
import { BENCH, LAVISH_CLI, STATE } from "./lib/paths.mjs";
import { complete, missingCredentials } from "./lib/providers.mjs";
import { applySearchReplace, captureGuidance, fencedBlock, firstPrompt, revisionPrompt } from "./lib/prompts.mjs";
import { Checker, austereAnchor, austereCheck, austerePatch, factsFound, writeFile } from "./lib/validate.mjs";
import { writeReport } from "./report.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODELS = JSON.parse(fs.readFileSync(path.join(BENCH, "models.json"), "utf8"));
const modelIds = opt("models", Object.keys(MODELS).filter((id) => MODELS[id].default).join(",")).split(",");
const taskIds = opt("tasks", TASKS.map((t) => t.id).join(",")).split(",");
const tools = opt("tools", "austere,lavish").split(",");
const reps = Number(opt("reps", "3"));
const concurrency = Number(opt("concurrency", "3"));
const RESULTS = path.join(BENCH, "results");
const RESULTS_FILE = path.join(RESULTS, "results.json");

for (const id of modelIds) if (!MODELS[id]) throw new Error(`unknown model ${id} (models.json has ${Object.keys(MODELS).join(", ")})`);
for (const id of taskIds) if (!TASKS.some((t) => t.id === id)) throw new Error(`unknown task ${id}`);
for (const id of modelIds) {
  const missing = missingCredentials(MODELS[id]);
  if (missing) {
    console.error(`${id}: ${missing}. Set it, or pick other models with --models.`);
    process.exit(2);
  }
}
if (!fs.existsSync(LAVISH_CLI)) {
  console.error("lavish-axi is not installed: run `npm --prefix bench ci` (npm run bench does this).");
  process.exit(2);
}

const guidance = captureGuidance();
const versions = { austere: guidance.austere.version, lavish: guidance.lavish.version };
const results = !args.includes("--fresh") && fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")) : { trials: [] };
if (args.includes("--fresh")) fs.rmSync(path.join(RESULTS, "pages"), { recursive: true, force: true });
results.meta = {
  updated: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  versions: { ...results.meta?.versions, ...versions },
  models: Object.fromEntries(Object.entries({ ...results.meta?.models, ...Object.fromEntries(modelIds.map((id) => [id, MODELS[id]])) }).map(([id, m]) => [id, { provider: m.provider, model: m.model, pricing: m.pricing }])),
};
const done = new Set(results.trials.map((t) => t.id));
const save = () => {
  fs.mkdirSync(RESULTS, { recursive: true });
  results.trials.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  fs.writeFileSync(RESULTS_FILE, `${JSON.stringify(results, null, 1)}\n`);
};

const queue = [];
for (let rep = 1; rep <= reps; rep++)
  for (const taskId of taskIds)
    for (const modelId of modelIds)
      for (const tool of tools) {
        const id = `${modelId}/${taskId}/${tool}/${rep}`;
        if (!done.has(id)) queue.push({ id, modelId, task: TASKS.find((t) => t.id === taskId), tool, rep });
      }
console.log(`austere-axi ${versions.austere} vs lavish-axi ${versions.lavish}: ${queue.length} trials to run (${done.size} already in results.json)`);

const checker = new Checker();
await checker.start();
let finished = 0;
try {
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const trial = await runTrial(job).catch((err) => ({ id: job.id, model: job.modelId, task: job.task.id, tool: job.tool, rep: job.rep, error: String(err.stack ?? err).slice(0, 2000) }));
        finished++;
        const f = trial.first;
        console.log(
          `[${finished}] ${job.id}: ${trial.error ? `ERROR ${trial.error.split("\n")[0]}` : `${f.usage.output} out tok, ${(f.wallMs / 1000).toFixed(1)} s, valid ${f.valid.ok}, revision ${trial.revision?.usage.output ?? "-"} tok ${trial.revision?.success ? "ok" : "failed"}`}`,
        );
        if (!trial.error) {
          results.trials.push(trial);
          save();
        }
      }
    }),
  );
} finally {
  await checker.stop();
}
save();
writeReport();
console.log(`results: ${path.relative(process.cwd(), RESULTS_FILE)}, summary: ${path.relative(process.cwd(), path.join(RESULTS, "summary.md"))}`);

async function runTrial({ id, modelId, task, tool, rep }) {
  const model = { id: modelId, ...MODELS[modelId] };
  const work = path.join(STATE, "work", id.replaceAll("/", "_"));
  const file = tool === "austere" ? path.join(work, "page.html") : path.join(work, ".lavish", "page.html");
  const pages = path.join(RESULTS, "pages", modelId, task.id);
  // Files from an earlier run of this trial (a fix or retry it may not need now).
  if (fs.existsSync(pages)) for (const f of fs.readdirSync(pages)) if (f.startsWith(`${tool}-${rep}.`)) fs.rmSync(path.join(pages, f));
  const convo = { system: guidance[tool].system(task), messages: [{ role: "user", content: firstPrompt(task, tool) }], state: undefined };

  // Turn 1: the page.
  const t1 = await complete(model, convo);
  const html = fencedBlock(t1.text, ["html"]);
  writeFile(file, html);
  writeFile(path.join(pages, `${tool}-${rep}.html`), html);
  const validate = () => (tool === "austere" ? austereCheck(file) : checker.lavishAudit(file));
  const valid = await validate();
  const render = await checker.render(file, task.feedback.anchor);
  const facts = factsFound(html, task.facts);
  let last = t1;
  const next = async (prompt) => {
    convo.messages.push({ role: "assistant", content: last.text }, { role: "user", content: prompt });
    convo.state = last.state;
    last = await complete(model, convo);
    return last;
  };

  // Fix turn, only when opening the page tells the agent to fix something:
  // `austere-axi <file>` lists check errors; `lavish-axi <file>` prints open-time
  // warnings such as self_paint_warning. lavish's layout findings go to the
  // reviewer's inbox, not the agent, so they do not trigger a fix.
  let fix = null;
  let current = valid;
  const openErrors = tool === "austere" ? !valid.ok : valid.openWarnings?.length > 0;
  if (openErrors) {
    const cmd = tool === "austere" ? "austere-axi page.html" : "lavish-axi .lavish/page.html";
    const tf = await next(`\`${cmd}\` returned:\n\n\`\`\`yaml\n${valid.output.trim()}\n\`\`\`\n\nFix it. ${editInstruction(tool)}`);
    writeFile(path.join(pages, `${tool}-${rep}.fix.txt`), tf.text);
    const edit = await applyEdit(tool, file, tf.text, false);
    current = edit.ok ? await validate() : current;
    // Fixed: the edit applied and the tool no longer asks for a fix.
    fix = { ...turn(tf), ok: edit.ok && (tool === "austere" ? current.ok : !current.openWarnings?.length) };
  }

  // Revision: one reviewer note, answered with the tool's cheapest edit. An edit that
  // does not apply gets the tool's error back once, as an agent's Edit tool or
  // `austere-axi patch` would report it; both attempts count toward the revision.
  const before = fs.readFileSync(file, "utf8");
  const anchor = tool === "austere" ? austereAnchor(before, task.feedback.anchor) : (render.anchor ?? { selector: "body", text: "", found: false });
  const attempts = [];
  let applied;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t = await next(attempt === 1 ? revisionPrompt(task, tool, anchor) : applied.retry);
    attempts.push(t);
    writeFile(path.join(pages, `${tool}-${rep}.revision${attempt > 1 ? `-${attempt}` : ""}.txt`), t.text);
    applied = await applyEdit(tool, file, t.text, !current.ok);
    applied.attempts = attempt;
    if (applied.ok) break;
  }
  delete applied.retry;
  const t2 = sumTurns(attempts);
  const revised = fs.readFileSync(file, "utf8");
  writeFile(path.join(pages, `${tool}-${rep}.revised.html`), revised);
  const revisedValid = applied.ok ? await validate() : { ok: false };
  const expectFound = applied.ok ? factsFound(revised, task.feedback.expect) : [];

  return {
    id,
    model: modelId,
    task: task.id,
    tool,
    rep,
    at: new Date().toISOString(),
    first: {
      ...turn(t1),
      bytes: Buffer.byteLength(html),
      valid: strip(valid),
      render: { ok: render.ok, desktop: render.desktop, mobile: render.mobile },
      facts: { found: facts.length, of: task.facts.length, missing: task.facts.filter((f) => !facts.includes(f)) },
    },
    fix,
    revision: {
      ...turn(t2),
      anchor: { found: anchor.found !== false, ...(tool === "austere" ? { statement: anchor.statement } : { selector: anchor.selector }) },
      applied,
      valid: strip(revisedValid),
      expect: { found: expectFound.length, of: task.feedback.expect.length },
      // Applied, says what the note asked, and did not make a valid page invalid.
      success: applied.ok && expectFound.length === task.feedback.expect.length && (revisedValid.ok || !current.ok),
    },
  };
}

function editInstruction(tool) {
  return tool === "austere"
    ? "Reply with only the statements to add or replace, in one ```openui code block and nothing else."
    : "Reply with only your edits, in the same SEARCH/REPLACE format, and nothing else.";
}

/**
 * Applies an edit reply to the file the way the tool would. austere-axi: `patch`,
 * then `check` (an edit that leaves check errors on a page that had none is not
 * applied cleanly). lavish-axi: SEARCH/REPLACE, all or nothing.
 */
async function applyEdit(tool, file, reply, wasInvalid) {
  if (tool === "austere") {
    const patch = await austerePatch(file, fencedBlock(reply, ["openui", "", "text"]));
    const check = patch.ok ? await austereCheck(file) : null;
    const ok = patch.ok && (check.ok || wasInvalid);
    const output = (check?.output ?? patch.output).trim();
    return { ok, detail: ok ? undefined : output.slice(0, 500), retry: `\`austere-axi patch page.html\` returned:\n\n\`\`\`yaml\n${output}\n\`\`\`\n\nFix it. ${editInstruction(tool)}` };
  }
  const edit = applySearchReplace(fs.readFileSync(file, "utf8"), reply);
  if (edit.text != null) writeFile(file, edit.text);
  return { ok: edit.text != null, edits: edit.edits, detail: edit.error, retry: `The edits were not applied: ${edit.error}. The file is unchanged. ${editInstruction(tool)}` };
}

function turn(t) {
  return { usage: t.usage, costUsd: t.costUsd, wallMs: Math.round(t.wallMs), ttftMs: t.ttftMs == null ? null : Math.round(t.ttftMs), stopReason: t.stopReason };
}

function strip(v) {
  const { output, ...rest } = v;
  return rest;
}

function sumTurns(ts) {
  const add = (k) => ts.reduce((a, t) => a + (t.usage[k] ?? 0), 0);
  return {
    usage: { input: add("input"), output: add("output"), cacheRead: add("cacheRead"), cacheWrite: add("cacheWrite"), thinking: ts.some((t) => t.usage.thinking != null) ? add("thinking") : null },
    costUsd: ts.reduce((a, t) => a + t.costUsd, 0),
    wallMs: ts.reduce((a, t) => a + t.wallMs, 0),
    ttftMs: ts[0].ttftMs,
    stopReason: ts.at(-1).stopReason,
  };
}
