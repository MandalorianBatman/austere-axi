// Turns bench/results/results.json into the summary tables (bench/results/summary.md,
// and the results section of docs/benchmark.md), the chart (docs/benchmark.svg) and
// the README headline. Runs at the end of every bench run; `npm run bench:report`
// re-renders without calling any model.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(BENCH);
const RESULTS_FILE = path.join(BENCH, "results", "results.json");
const TOOLS = ["austere", "lavish"];
const TOOL_NAME = { austere: "austere-axi", lavish: "lavish-axi" };

const median = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "–");
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "–");
const usd = (n) => (Number.isFinite(n) ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}` : "–");
const pct = (a, b) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "–");
const times = (r) => (Number.isFinite(r) ? `${r.toFixed(1)}×` : "–");

// A page's cost includes the fix turn, when the tool told the agent to fix
// something on open: that is what it takes to get a page the reviewer can use.
const pageOut = (t) => t.first.usage.output + (t.fix?.usage.output ?? 0);
const pageWall = (t) => t.first.wallMs + (t.fix?.wallMs ?? 0);
const pageCost = (t) => t.first.costUsd + (t.fix?.costUsd ?? 0);

export function summarize(results) {
  const trials = results.trials.filter((t) => !t.error);
  const models = [...new Set(trials.map((t) => t.model))];
  const cells = {};
  for (const model of models)
    for (const tool of TOOLS) {
      const ts = trials.filter((t) => t.model === model && t.tool === tool);
      if (!ts.length) continue;
      const fixed = ts.filter((t) => t.fix);
      cells[`${model}/${tool}`] = {
        n: ts.length,
        firstOutTok: median(ts.map((t) => t.first.usage.output)),
        bytes: median(ts.map((t) => t.first.bytes)),
        valid: ts.filter((t) => t.first.valid.ok).length,
        fixes: fixed.length,
        fixOk: fixed.filter((t) => t.fix.ok).length,
        fixOutTok: median(fixed.map((t) => t.fix.usage.output)),
        outTok: median(ts.map(pageOut)),
        wallMs: median(ts.map(pageWall)),
        cost: mean(ts.map(pageCost)),
        render: ts.filter((t) => t.first.render.ok).length,
        facts: [ts.reduce((a, t) => a + t.first.facts.found, 0), ts.reduce((a, t) => a + t.first.facts.of, 0)],
        truncated: ts.filter((t) => t.first.stopReason === "max_tokens").length,
        revOutTok: median(ts.map((t) => t.revision.usage.output)),
        revWallMs: median(ts.map((t) => t.revision.wallMs)),
        revCost: mean(ts.map((t) => t.revision.costUsd)),
        revOk: ts.filter((t) => t.revision.success).length,
      };
    }
  // Paired ratios: the same model, task and repetition, lavish over austere.
  const pairs = [];
  for (const a of trials.filter((t) => t.tool === "austere")) {
    const l = trials.find((t) => t.tool === "lavish" && t.model === a.model && t.task === a.task && t.rep === a.rep);
    if (l) pairs.push({ model: a.model, task: a.task, a, l });
  }
  const ratio = (ps, f) => median(ps.map((p) => f(p.l) / f(p.a)));
  const ratios = (ps) => ({
    n: ps.length,
    firstOutTok: ratio(ps, (t) => t.first.usage.output),
    outTok: ratio(ps, pageOut),
    wallMs: ratio(ps, pageWall),
    cost: ratio(ps, pageCost),
    revOutTok: ratio(ps, (t) => t.revision.usage.output),
    revWallMs: ratio(ps, (t) => t.revision.wallMs),
    revCost: ratio(ps, (t) => t.revision.costUsd),
  });
  const byModel = Object.fromEntries(models.map((m) => [m, ratios(pairs.filter((p) => p.model === m))]));
  const byTask = {};
  for (const task of TASKS)
    for (const model of models) {
      const ps = pairs.filter((p) => p.task === task.id && p.model === model);
      if (!ps.length) continue;
      byTask[`${model}/${task.id}`] = {
        austere: median(ps.map((p) => pageOut(p.a))),
        lavish: median(ps.map((p) => pageOut(p.l))),
        outTok: ratio(ps, pageOut),
        wallMs: ratio(ps, pageWall),
        revOutTok: ratio(ps, (t) => t.revision.usage.output),
      };
    }
  return { models, tasks: new Set(trials.map((t) => t.task)).size, cells, overall: ratios(pairs), byModel, byTask, trials: trials.length };
}

export function headline(s) {
  const o = s.overall;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `Across ${o.n} paired runs (${plural(s.tasks, "review page")}, ${plural(s.models.length, "model")}), lavish-axi spent a median **${times(o.outTok)}** the output tokens of austere-axi to produce the same page, took **${times(o.wallMs)}** as long and cost **${times(o.cost)}** as much. Answering one reviewer note took **${times(o.revOutTok)}** the output tokens.`;
}

export function tables(results, s) {
  const meta = results.meta;
  const out = [];
  const modelLabel = (m) => `${m} (${meta.models[m]?.model ?? "?"})`;
  out.push(`Versions: austere-axi ${meta.versions.austere}, lavish-axi ${meta.versions.lavish}. ${s.trials} trials, last run ${meta.updated.slice(0, 10)}.`, "");
  out.push("### The page", "");
  out.push(
    "Medians, except cost (mean per page). *First try*: the tool's own validator passed on the model's first answer. *Fix turns*: opening the page told the agent to fix something, so it got one more turn (median output tokens of that turn in brackets). *Tokens*, *time* and *cost* include the fix turn. *Clean render*: no page errors and no sideways scrolling at 1440 and 390 px. *Facts kept*: the task's facts that appear on the page.",
    "",
  );
  out.push("| Model | Tool | Runs | Valid first try | Fix turns (tokens) | Fixed | Output tokens | Time | Cost | Clean render | Facts kept |");
  out.push("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const m of s.models)
    for (const tool of TOOLS) {
      const c = s.cells[`${m}/${tool}`];
      if (!c) continue;
      out.push(
        `| ${modelLabel(m)} | ${TOOL_NAME[tool]} | ${c.n} | ${pct(c.valid, c.n)} | ${c.fixes}${c.fixes ? ` (${int(c.fixOutTok)})` : ""} | ${c.fixes ? `${c.fixOk}/${c.fixes}` : "–"} | ${int(c.outTok)}${c.truncated ? ` (${c.truncated} cut off)` : ""} | ${secs(c.wallMs)} | ${usd(c.cost)} | ${pct(c.render, c.n)} | ${pct(c.facts[0], c.facts[1])} |`,
      );
    }
  out.push("", "### One revision round", "");
  out.push("The reviewer leaves one note; the agent answers with the tool's cheapest edit (statements for `austere-axi patch`, SEARCH/REPLACE edits for the lavish-axi HTML). An edit that does not apply gets its error back once; both attempts count. *Ok*: applied, contains what the note asked for, and did not make a valid page invalid.", "");
  out.push("| Model | Tool | Output tokens | Time | Cost | Ok |");
  out.push("|---|---|--:|--:|--:|--:|");
  for (const m of s.models)
    for (const tool of TOOLS) {
      const c = s.cells[`${m}/${tool}`];
      if (c) out.push(`| ${modelLabel(m)} | ${TOOL_NAME[tool]} | ${int(c.revOutTok)} | ${secs(c.revWallMs)} | ${usd(c.revCost)} | ${pct(c.revOk, c.n)} |`);
    }
  out.push("", "### lavish-axi ÷ austere-axi (median of paired ratios)", "");
  out.push("Each pair is the same model, task and repetition. Above 1× means lavish-axi used more.", "");
  out.push("| Model | Pairs | Output tokens, first try | Output tokens, page | Time, page | Cost, page | Revision tokens | Revision time | Revision cost |");
  out.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const [m, r] of [...Object.entries(s.byModel), ["all", s.overall]])
    out.push(
      `| ${m === "all" ? "**all**" : modelLabel(m)} | ${r.n} | ${times(r.firstOutTok)} | ${times(r.outTok)} | ${times(r.wallMs)} | ${times(r.cost)} | ${times(r.revOutTok)} | ${times(r.revWallMs)} | ${times(r.revCost)} |`,
    );
  out.push("", "### Per task (median output tokens per page, fix turn included)", "");
  out.push("| Task | Model | austere-axi | lavish-axi | Tokens ÷ | Time ÷ | Revision tokens ÷ |");
  out.push("|---|---|--:|--:|--:|--:|--:|");
  for (const task of TASKS)
    for (const m of s.models) {
      const r = s.byTask[`${m}/${task.id}`];
      if (r) out.push(`| ${task.title} | ${m} | ${int(r.austere)} | ${int(r.lavish)} | ${times(r.outTok)} | ${times(r.wallMs)} | ${times(r.revOutTok)} |`);
    }
  return out.join("\n");
}

/** Grouped bars: one panel per metric, one group per model, austere vs lavish. */
export function chart(s) {
  const panels = [
    { title: "Output tokens per page", key: "outTok", fmt: int },
    { title: "Seconds per page", key: "wallMs", fmt: (v) => (v / 1000).toFixed(0) },
    { title: "Output tokens per revision", key: "revOutTok", fmt: int },
  ];
  const color = { austere: "#3b82f6", lavish: "#f59e0b" };
  const pw = 300;
  const ph = 220;
  const gap = 24;
  const top = 56;
  const W = panels.length * pw + (panels.length - 1) * gap + 32;
  const H = top + ph + 64;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="16" y="24" font-size="15" font-weight="600" fill="#111827">austere-axi vs lavish-axi: medians, lower is better</text>`);
  parts.push(`<rect x="16" y="34" width="10" height="10" fill="${color.austere}"/><text x="30" y="43" fill="#374151">austere-axi</text>`);
  parts.push(`<rect x="110" y="34" width="10" height="10" fill="${color.lavish}"/><text x="124" y="43" fill="#374151">lavish-axi</text>`);
  panels.forEach((p, i) => {
    const x0 = 16 + i * (pw + gap);
    const vals = s.models.flatMap((m) => TOOLS.map((t) => s.cells[`${m}/${t}`]?.[p.key] ?? 0));
    const max = Math.max(1, ...vals);
    parts.push(`<text x="${x0}" y="${top + 6}" font-weight="600" fill="#111827">${esc(p.title)}</text>`);
    const base = top + ph;
    parts.push(`<line x1="${x0}" y1="${base}" x2="${x0 + pw}" y2="${base}" stroke="#d1d5db"/>`);
    const groupW = pw / Math.max(1, s.models.length);
    s.models.forEach((m, gi) => {
      const gx = x0 + gi * groupW;
      const bw = Math.min(48, (groupW - 24) / 2);
      TOOLS.forEach((tool, ti) => {
        const v = s.cells[`${m}/${tool}`]?.[p.key];
        if (v == null || !Number.isFinite(v)) return;
        const h = ((ph - 40) * v) / max;
        const bx = gx + groupW / 2 - bw - 2 + ti * (bw + 4);
        parts.push(`<rect x="${bx.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color[tool]}" rx="2"/>`);
        parts.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${(base - h - 4).toFixed(1)}" text-anchor="middle" fill="#374151" font-size="11">${esc(p.fmt(v))}</text>`);
      });
      parts.push(`<text x="${(gx + groupW / 2).toFixed(1)}" y="${base + 16}" text-anchor="middle" fill="#374151">${esc(m)}</text>`);
    });
  });
  parts.push(`<text x="16" y="${H - 12}" fill="#6b7280" font-size="11">Source: bench/results/results.json. Bars are medians over every task and repetition per model.</text>`);
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

function replaceBetween(file, start, end, body) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) return;
  fs.writeFileSync(file, `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`);
}

export function writeReport() {
  const results = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  const s = summarize(results);
  if (!s.trials) return;
  const body = `${headline(s)}\n\n${tables(results, s)}`;
  fs.writeFileSync(path.join(BENCH, "results", "summary.md"), `# Benchmark summary\n\nGenerated by \`npm run bench:report\` from \`results.json\`.\n\n${body}\n`);
  fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "docs", "benchmark.svg"), chart(s));
  replaceBetween(path.join(ROOT, "docs", "benchmark.md"), "<!-- results:start -->", "<!-- results:end -->", body);
  replaceBetween(path.join(ROOT, "README.md"), "<!-- bench:start -->", "<!-- bench:end -->", headline(s));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeReport();
  console.log(fs.readFileSync(path.join(BENCH, "results", "summary.md"), "utf8"));
}
