// The /play page. Bundled by scripts/site.mjs into _site/play/play.js.
//
//   editor ──▶ checkProgram (the code behind `austere-axi check`) ──▶ problems + status
//          └─▶ sandboxed iframe running dist/austere.js, fed over the review bridge
//   click in the frame ──▶ "annotate" message ──▶ the text `austere-axi poll` would print
//
// The page plays the part of the review chrome (src/chrome/chrome.js): it answers the
// frame's "hello" with "init", pushes edits as "source" messages so the frame re-renders
// in place, and receives the queued annotations.
import { createParser } from "@openuidev/lang-core";
import { escapeHtml, readArtifact, replaceProgram, rewriteRuntime, skeleton } from "../../src/cli/artifact.js";
import { format } from "../../src/cli/output.js";
import { checkProgram } from "../../src/shared/check-program.js";
import { describeItem, locator } from "../../src/shared/feedback.js";
import { splitStatements } from "../../src/shared/statements.js";
import { createEditor } from "./editor.js";
import { decodeProgram, encodeProgram, hashFor, hashParam } from "./share.js";

const $ = (selector) => document.querySelector(selector);
const BLANK = {
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

const data = await fetch("data.json").then((r) => r.json());
const templates = [BLANK, ...data.templates];
const parser = createParser(data.spec, data.spec.root || "Stack");

const app = $("#app");
const frame = $("#frame");
const state = { program: "", mode: "annotate", feedback: [], runtimeErrors: [], frameReady: false, sent: "" };

// ── page documents ─────────────────────────────────────────────────────────

const titleOf = (program) => /CardHeader\(\s*"((?:[^"\\]|\\.)*)"/.exec(program)?.[1]?.replace(/\\(.)/g, "$1") || "austere-axi page";

/** The artifact file for a program. The frame and the download differ only in the runtime tag. */
function pageHtml(program, runtimeTag) {
  const base = skeleton(titleOf(program));
  const html = runtimeTag ? rewriteRuntime(base, runtimeTag) : base;
  return replaceProgram(html, program);
}

// ── editor ─────────────────────────────────────────────────────────────────

const editor = createEditor({
  root: $("#editor"),
  onInput: (text) => {
    $("#template").value = ""; // no longer the template's text
    change(text);
  },
});
let statementIndex = new Map();

function change(program, { reload = false } = {}) {
  state.program = program;
  state.runtimeErrors = [];
  clearTimeout(change.check);
  clearTimeout(change.push);
  clearTimeout(change.hash);
  change.check = setTimeout(runCheck, 120);
  change.hash = setTimeout(updateHash, 400);
  if (reload) loadFrame();
  else change.push = setTimeout(pushSource, 150);
}

function runCheck() {
  const program = state.program;
  statementIndex = new Map(splitStatements(program).map((s) => [s.id, s]));
  const lineOf = (id) => statementIndex.get(id)?.line;
  const result = checkProgram(program, { parser: () => parser, lineOf });
  const problems = [
    ...result.errors.map((e) => ({ ...e, severity: "error" })),
    ...result.warnings.map((e) => ({ ...e, severity: "warning" })),
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
}

function problemLine(p) {
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
          const s = statementIndex.get(p.statement) || [...statementIndex.values()].find((x) => x.line === line);
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
  state.sent = state.program;
  frame.srcdoc = pageHtml(state.program, `<script src="${RUNTIME_URL}"></script>`);
}

function post(message) {
  frame.contentWindow?.postMessage({ austere: 1, ...message }, "*");
}

function pushSource() {
  if (!state.frameReady || state.program === state.sent) return;
  state.sent = state.program;
  post({ type: "source", program: state.program });
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const d = event.data;
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
      if (d.error && !state.runtimeErrors.some((e) => e.statement === d.error.statementId && e.message === d.error.message)) {
        state.runtimeErrors.push({ severity: "error", code: "render", statement: d.error.statementId, message: `Render error: ${d.error.message}` });
        renderProblems();
      }
      break;
    case "toggle-mode":
      setMode(state.mode === "annotate" ? "explore" : "annotate");
      break;
  }
});

function setMode(mode) {
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

function queueItem(item) {
  state.feedback.push(item);
  renderFeedback();
  $("#feedback").open = true;
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
      button.textContent = id;
      button.title = "Show this statement in the source";
      button.disabled = !statementIndex.has(id);
      button.addEventListener("click", () => {
        const s = statementIndex.get(id);
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

const select = $("#template");
const option = (props) => Object.assign(document.createElement("option"), props);
select.replaceChildren(...templates.map((t) => option({ value: t.id, textContent: t.title })), option({ value: "", textContent: "Your page", hidden: true }));
select.addEventListener("change", () => {
  const t = templates.find((x) => x.id === select.value);
  if (t) load(t.program);
});

function load(program) {
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
  clearTimeout(change.hash);
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

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 7000);
}

// ── panels ─────────────────────────────────────────────────────────────────

function showView(view) {
  app.dataset.view = view;
  for (const tab of document.querySelectorAll(".tabs [role=tab]")) tab.setAttribute("aria-selected", String(tab.dataset.view === view));
}
for (const tab of document.querySelectorAll(".tabs [role=tab]")) tab.addEventListener("click", () => showView(tab.dataset.view));

// ── component reference (catalog.json) ─────────────────────────────────────

const code = (text) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

function renderReference(filter = "") {
  const q = filter.trim().toLowerCase();
  const groups = new Map(data.catalog.groups.map((g) => [g.name, { notes: g.notes, items: [] }]));
  for (const c of data.catalog.components) {
    if (q && !`${c.name} ${c.description} ${c.group}`.toLowerCase().includes(q)) continue;
    if (!groups.has(c.group)) groups.set(c.group, { notes: [], items: [] });
    groups.get(c.group).items.push(c);
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
$("#ref-filter").addEventListener("input", (e) => renderReference(e.target.value));
$("#ref").addEventListener("click", async (e) => {
  const button = e.target.closest("button.copy");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.signature);
    toast("Signature copied.");
  } catch {
    toast("Could not copy; select the signature instead.");
  }
});

// ── start ──────────────────────────────────────────────────────────────────

renderReference();
setMode("annotate");
let initial;
const shared = hashParam(location.hash);
if (shared) {
  try {
    initial = await decodeProgram(shared);
    select.value = "";
  } catch (err) {
    toast(`${err.message} Showing the default page instead.`);
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
