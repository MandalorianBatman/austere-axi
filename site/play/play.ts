// The /play page. Bundled by scripts/site.ts into _site/play/play.js.
//
//   editor ──▶ checkProgram (the code behind `austere-axi check`) ──▶ problems + status
//          └─▶ sandboxed iframe running dist/austere.js, fed over the review bridge
//   click in the frame ──▶ "annotate" message ──▶ the text `austere-axi poll` would print
//
// The page plays the part of the review chrome (src/chrome/chrome.ts): it answers the
// frame's "hello" with "init", pushes edits as "source" messages so the frame re-renders
// in place, and receives the queued annotations.
import { createParser } from "@openuidev/lang-core";
import type { LibraryJSONSchema } from "@openuidev/lang-core";
import type { Catalog, CatalogEntry } from "../../types/catalog.d.ts";
import { escapeHtml, readArtifact, replaceProgram, rewriteRuntime, skeleton } from "../../src/cli/artifact.ts";
import { format } from "../../src/cli/output.ts";
import { checkProgram } from "../../src/shared/check-program.ts";
import type { CheckEntry } from "../../src/shared/check-program.ts";
import { describeItem, locator } from "../../src/shared/feedback.ts";
import type { FeedbackItem } from "../../src/shared/feedback.ts";
import { splitStatements } from "../../src/shared/statements.ts";
import type { Statement } from "../../src/shared/statements.ts";
import { createEditor } from "./editor.ts";
import type { Severity } from "./editor.ts";
import { decodeProgram, encodeProgram, hashFor, hashParam } from "./share.ts";

interface Template {
  id: string;
  title: string;
  program: string;
}

/** data.json, written by scripts/site.ts. */
interface PlayData {
  templates: Template[];
  spec: LibraryJSONSchema & { root?: string };
  catalog: Catalog;
}

/** A check finding, a render error from the frame, or the `</script` error. */
interface Problem extends CheckEntry {
  severity: Severity;
}

/** Messages the frame posts over the review bridge. */
type FrameMessage = { austere: 1 } & (
  | { type: "hello" }
  | { type: "ready" }
  | { type: "annotate" | "action"; item: FeedbackItem }
  | { type: "runtime-error"; error?: { statementId?: string; message: string } }
  | { type: "toggle-mode" }
);

/** Messages the page posts to the frame. */
type PageMessage = { type: "init"; mode: string; scrollY: number } | { type: "source"; program: string } | { type: "mode"; mode: string };

type Timer = ReturnType<typeof setTimeout>;

// Elements of index.html: the queries are of known elements (a cast at the boundary).
const $ = <E extends Element = HTMLElement>(selector: string): E => document.querySelector(selector) as E;
const BLANK: Template = {
  id: "blank",
  title: "Blank page",
  program: `root = Stack([intro, body], "column", "l")
intro = Card([CardHeader("Hello", "Edit the source on the left")])
body = Card([CardHeader("A section"), text])
text = MarkDownRenderer("Every line is a **statement**. Click this card to see its name.")
`,
};
const DEFAULT_TEMPLATE = "session-migration";
const RUNTIME_URL = new URL("../austere.js", document.baseURI).href;
const LONG_LINK = 8000;

const data: PlayData = await fetch("data.json").then((r) => r.json());
const templates = [BLANK, ...data.templates];
const parser = createParser(data.spec, data.spec.root || "Stack");

const app = $("#app");
const frame = $<HTMLIFrameElement>("#frame");
const state: { program: string; mode: string; feedback: FeedbackItem[]; problems?: Problem[]; runtimeErrors: Problem[]; frameReady: boolean; sent: string } = { program: "", mode: "annotate", feedback: [], runtimeErrors: [], frameReady: false, sent: "" };

// ── page documents ─────────────────────────────────────────────────────────

const titleOf = (program: string): string => /CardHeader\(\s*"((?:[^"\\]|\\.)*)"/.exec(program)?.[1]?.replace(/\\(.)/g, "$1") || "austere-axi page";

/** The artifact file for a program. The frame and the download differ only in the runtime tag. */
function pageHtml(program: string, runtimeTag?: string): string {
  const base = skeleton(titleOf(program));
  const html = runtimeTag ? rewriteRuntime(base, runtimeTag) : base;
  return replaceProgram(html, program);
}

// ── editor ─────────────────────────────────────────────────────────────────

const editor = createEditor({
  root: $("#editor"),
  onInput: (text) => {
    $<HTMLSelectElement>("#template").value = ""; // no longer the template's text
    change(text);
  },
});
let statementIndex = new Map<string, Statement>();

/** Pending work after an edit. */
const timers: { check?: Timer; push?: Timer; hash?: Timer } = {};

function change(program: string, { reload = false } = {}) {
  state.program = program;
  state.runtimeErrors = [];
  clearTimeout(timers.check);
  clearTimeout(timers.push);
  clearTimeout(timers.hash);
  timers.check = setTimeout(runCheck, 120);
  timers.hash = setTimeout(updateHash, 400);
  if (reload) loadFrame();
  else timers.push = setTimeout(pushSource, 150);
}

function runCheck() {
  const program = state.program;
  statementIndex = new Map(splitStatements(program).map((s) => [s.id, s]));
  const lineOf = (id: string | undefined) => (id === undefined ? undefined : statementIndex.get(id)?.line);
  const result = checkProgram(program, { parser: () => parser, lineOf });
  const problems: Problem[] = [
    ...result.errors.map((e) => ({ ...e, severity: "error" as const })),
    ...result.warnings.map((e) => ({ ...e, severity: "warning" as const })),
  ];
  if (/<\/script/i.test(program)) {
    problems.unshift({
      severity: "error",
      code: "script-close",
      message: "`</script` ends the page's script block, so an .html file cannot contain it. Write the text another way.",
    });
  }
  state.problems = problems;
  renderProblems();
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.length - errors;
  const tokens = Math.round(program.length / 3.8);
  const facts = `${result.statements} statements · ~${tokens.toLocaleString("en-US")} tokens`;
  const status = $("#status");
  status.className = `status ${errors ? "bad" : "ok"}`;
  status.textContent = errors
    ? `${errors} error${errors > 1 ? "s" : ""}${warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""} · the page renders what it can · ${facts}`
    : `Passes austere-axi check${warnings ? ` with ${warnings} warning${warnings > 1 ? "s" : ""}` : ""} · ${facts}`;
  if (state.feedback.length) renderFeedback();
}

function problemLine(p: Problem): number {
  return p.line || (p.statement && statementIndex.get(p.statement)?.line) || (p.statements && statementIndex.get(p.statements[0])?.line) || 0;
}

function renderProblems() {
  const all = [...(state.problems || []), ...state.runtimeErrors];
  editor.mark(all.map((p) => ({ line: problemLine(p), severity: p.severity })).filter((m) => m.line));
  const list = $("#diag");
  list.replaceChildren(
    ...all.map((p) => {
      const li = document.createElement("li");
      li.className = p.severity;
      const line = problemLine(p);
      const where = [line ? `line ${line}` : "", p.statement || (p.statements && p.statements.join(", ")) || ""].filter(Boolean).join(" · ");
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = !line;
      button.innerHTML = `<b>${p.severity === "error" ? "Error" : "Warning"}</b>${where ? ` <span class="where">${escapeHtml(where)}</span>` : ""}<span class="msg">${escapeHtml(p.message)}</span>`;
      if (line) {
        button.addEventListener("click", () => {
          showView("source");
          const s = (p.statement && statementIndex.get(p.statement)) || [...statementIndex.values()].find((x) => x.line === line);
          editor.reveal(line, s ? s.endLine : line);
          editor.focus();
        });
      }
      li.append(button);
      return li;
    }),
  );
}

// ── the frame ──────────────────────────────────────────────────────────────

function loadFrame() {
  state.frameReady = false;
  // A program containing `</script` would break out of the srcdoc script block; load empty and let pushSource deliver it via postMessage once the frame is ready.
  const inline = /<\/script/i.test(state.program) ? "" : state.program;
  state.sent = inline;
  frame.srcdoc = pageHtml(inline, `<script src="${RUNTIME_URL}"></script>`);
}

function post(message: PageMessage) {
  frame.contentWindow?.postMessage({ austere: 1, ...message }, "*");
}

function pushSource() {
  if (!state.frameReady || state.program === state.sent) return;
  state.sent = state.program;
  post({ type: "source", program: state.program });
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const d = event.data as FrameMessage | null | undefined;
  if (!d || d.austere !== 1) return;
  switch (d.type) {
    case "hello":
      post({ type: "init", mode: state.mode, scrollY: 0 });
      break;
    case "ready":
      state.frameReady = true;
      // The frame mounts its listeners right after "ready"; give React a tick to commit.
      setTimeout(pushSource, 80);
      break;
    case "annotate":
    case "action":
      queueItem(d.item);
      break;
    case "runtime-error":
      const error = d.error;
      if (error && !state.runtimeErrors.some((e) => e.statement === error.statementId && e.message === error.message)) {
        state.runtimeErrors.push({ severity: "error", code: "render", statement: error.statementId, message: `Render error: ${error.message}` });
        renderProblems();
      }
      break;
    case "toggle-mode":
      setMode(state.mode === "annotate" ? "explore" : "annotate");
      break;
  }
});

function setMode(mode: string) {
  state.mode = mode;
  $("#mode-annotate").setAttribute("aria-pressed", String(mode === "annotate"));
  $("#mode-explore").setAttribute("aria-pressed", String(mode === "explore"));
  $("#mode-hint").textContent =
    mode === "annotate"
      ? "Click any part of the page. Buttons and links keep working; Alt-click one to annotate it."
      : "Buttons, tabs and forms work as they would in a review.";
  post({ type: "mode", mode });
}
$("#mode-annotate").addEventListener("click", () => setMode("annotate"));
$("#mode-explore").addEventListener("click", () => setMode("explore"));

// ── what the agent receives ────────────────────────────────────────────────

function queueItem(item: FeedbackItem) {
  state.feedback.push(item);
  renderFeedback();
  $<HTMLDetailsElement>("#feedback").open = true;
}

function renderFeedback() {
  const items = state.feedback;
  $("#fb-empty").hidden = items.length > 0;
  $("#fb-body").hidden = items.length === 0;
  $("#fb-count").textContent = items.length ? `(${items.length})` : "";
  if (!items.length) return;
  const at = locator(statementIndex);
  $("#fb-text").textContent = format({ status: "feedback", file: "page.html", items: items.map((item) => describeItem(item, at)) });
  const targets = [...new Set(items.filter((i) => i.kind === "annotation").map((i) => i.target))];
  const jump = $("#fb-jump");
  jump.replaceChildren(
    ...targets.map((id) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.textContent = id ?? null;
      button.title = "Show this statement in the source";
      button.disabled = id === undefined || !statementIndex.has(id);
      button.addEventListener("click", () => {
        const s = id === undefined ? undefined : statementIndex.get(id);
        if (!s) return;
        showView("source");
        editor.reveal(s.line, s.endLine);
        editor.focus();
      });
      return button;
    }),
  );
}
$("#fb-clear").addEventListener("click", () => {
  state.feedback = [];
  renderFeedback();
});

// ── templates, share, download ─────────────────────────────────────────────

const select = $<HTMLSelectElement>("#template");
const option = (props: Partial<HTMLOptionElement>) => Object.assign(document.createElement("option"), props);
select.replaceChildren(...templates.map((t) => option({ value: t.id, textContent: t.title })), option({ value: "", textContent: "Your page", hidden: true }));
select.addEventListener("change", () => {
  const t = templates.find((x) => x.id === select.value);
  if (t) load(t.program);
});

function load(program: string) {
  editor.set(program);
  state.feedback = [];
  renderFeedback();
  change(program, { reload: true });
}

async function updateHash() {
  const program = state.program;
  const value = await encodeProgram(program);
  if (program === state.program) history.replaceState(null, "", hashFor(value)); // else edited again while encoding
}

async function currentUrl() {
  clearTimeout(timers.hash);
  await updateHash();
  return location.href;
}

$("#copy-link").addEventListener("click", async () => {
  const url = await currentUrl();
  const long = url.length > LONG_LINK ? ` The link is ${url.length.toLocaleString("en-US")} characters; some apps cut links over ${LONG_LINK.toLocaleString("en-US")}.` : "";
  try {
    await navigator.clipboard.writeText(url);
    toast(`Link copied. It holds the whole page, so anyone who opens it sees what you see.${long}`);
  } catch {
    toast(`Copy the address bar: it already holds your page.${long}`);
  }
});

$("#download").addEventListener("click", () => {
  const html = pageHtml(state.program);
  const name = (readArtifact(html).title || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([html], { type: "text/html" })),
    download: `${name}.html`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Saved ${name}.html. Run \`npx -y austere-axi ${name}.html\` to review it with an agent.`);
});

let toastTimer: Timer | 0 = 0;
function toast(text: string) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 7000);
}

// ── panels ─────────────────────────────────────────────────────────────────

function showView(view: string | undefined) {
  app.dataset.view = view;
  for (const tab of document.querySelectorAll<HTMLElement>(".tabs [role=tab]")) tab.setAttribute("aria-selected", String(tab.dataset.view === view));
}
for (const tab of document.querySelectorAll<HTMLElement>(".tabs [role=tab]")) tab.addEventListener("click", () => showView(tab.dataset.view));

// ── component reference (catalog.json) ─────────────────────────────────────

const code = (text: string): string => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

function renderReference(filter = "") {
  const q = filter.trim().toLowerCase();
  const groups = new Map(data.catalog.groups.map((g): [string, { notes: string[]; items: CatalogEntry[] }] => [g.name, { notes: g.notes, items: [] }]));
  for (const c of data.catalog.components) {
    if (q && !`${c.name} ${c.description} ${c.group}`.toLowerCase().includes(q)) continue;
    if (!groups.has(c.group)) groups.set(c.group, { notes: [], items: [] });
    groups.get(c.group)?.items.push(c);
  }
  const html = [...groups]
    .filter(([, g]) => g.items.length)
    .map(([name, g]) => {
      const notes = q || !g.notes.length ? "" : `<ul class="notes">${g.notes.map((n) => `<li>${code(n.replace(/^-\s*/, ""))}</li>`).join("")}</ul>`;
      const items = g.items
        .map(
          (c) => `<article class="comp">
  <h4><span>${escapeHtml(c.name)}</span>${c.tier === "extended" ? '<em class="tag">extended</em>' : ""}${c.pack !== "core" ? `<em class="tag">${escapeHtml(c.pack.replace(/^@austere-axi\//, ""))}</em>` : ""}<button type="button" class="copy" data-signature="${escapeHtml(c.signature)}" aria-label="Copy signature of ${escapeHtml(c.name)}">Copy</button></h4>
  <p>${code(c.description)}</p>
  <pre tabindex="0"><code>${escapeHtml(c.signature)}</code></pre>
</article>`,
        )
        .join("");
      return `<section><h3>${escapeHtml(name)}</h3>${notes}${items}</section>`;
    })
    .join("");
  $("#ref").innerHTML = html || '<p class="none">No component matches.</p>';
}
$("#ref-filter").addEventListener("input", (e) => {
  if (e.target instanceof HTMLInputElement) renderReference(e.target.value);
});
$("#ref").addEventListener("click", async (e) => {
  const button = e.target instanceof Element ? e.target.closest<HTMLElement>("button.copy") : null;
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.signature ?? "");
    toast("Signature copied.");
  } catch {
    toast("Could not copy; select the signature instead.");
  }
});

// ── start ──────────────────────────────────────────────────────────────────

renderReference();
setMode("annotate");
let initial: string | undefined;
const shared = hashParam(location.hash);
if (shared) {
  try {
    initial = await decodeProgram(shared);
    select.value = "";
  } catch (err) {
    toast(`${(err as Error).message} Showing the default page instead.`);
  }
}
if (initial === undefined) {
  const t = templates.find((x) => x.id === DEFAULT_TEMPLATE) || templates[0];
  initial = t.program;
  select.value = t.id;
}
editor.set(initial);
state.program = initial;
runCheck();
loadFrame();
