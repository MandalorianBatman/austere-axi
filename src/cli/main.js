process.env.OPENUI_TELEMETRY_DISABLED = process.env.OPENUI_TELEMETRY_DISABLED || "1";

import fs from "node:fs";
import path from "node:path";
import { mergeStatements } from "@openuidev/lang-core";
import { CDN_RUNTIME_URL, readArtifact, replaceProgram } from "./artifact.js";
import { checkHtml, statementLines } from "./check.js";
import { ensureServer, openBrowser, request, serverIfRunning } from "./client.js";
import { exportHtml } from "./export.js";
import { format, print } from "./output.js";
import { VERSION, assetPath, canonicalFile, port, stateDir } from "./paths.js";

const BIN = "austere-axi";

const HELP = `${BIN} ${VERSION} — review artifacts written in OpenUI Lang. You write a short
program instead of a whole HTML page; the reviewer annotates it in the browser;
their feedback comes back to you addressed by statement name.

WORKFLOW
  1. ${BIN} spec                 component reference (read once per session)
  2. Write an .html file:
       <!doctype html>
       <html><head><meta charset="utf-8"><title>Short title</title>
       <script src="${CDN_RUNTIME_URL}"></script></head>
       <body><script type="text/openui">
       root = Stack([intro, ...], "column", "l")
       intro = Card([CardHeader("Title", "Subtitle"), introText])
       introText = MarkDownRenderer("...")
       </script></body></html>
     The CDN tag lets the file open on its own (needs network); review and \`export\` work offline.
  3. ${BIN} <file.html>          validate + open for review (fix any errors it lists).
                                   With --no-open the session still exists; it prints the url
                                   (and a phone url when Tailscale is up) for the user.
  4. ${BIN} poll <file.html>     wait for feedback. Leave it running in the foreground;
                                   it returns when the reviewer presses Send. If your tool call
                                   times out first, run the same poll again: nothing is lost.
  5. Apply feedback by editing ONLY the named statements (keep names stable). The page
     live-updates and highlights what changed. Then:
       ${BIN} poll <file.html> --agent-reply "one line: what changed"
  6. On status: ended, stop polling and continue in chat. Never reopen uninvited.

FEEDBACK (what poll returns)
  status: feedback | ended | browser_disconnected | interrupted | replaced, plus a next: hint.
  items, each one of:
    annotation: <statement> (<Component>)   line + source of that statement in the file,
        within (parent statements), selection | excerpt, detail (table row/column, or
        part: the exact piece clicked, e.g. a diff file:+line or a diagram node), note
    action: <@ToAssistant message>           form: {<formName>: {<field>: value}}, context
    message: <free text from the composer>
    render_error: <statement>                a render failure the reviewer asked you to fix

CHECK verifies syntax, component names, required props, unresolved references and
statements unreachable from root. Mermaid syntax is only checked when it renders; failures
show in the reviewer's panel and can come back as render_error.

WHEN TO USE
  Plans, comparisons, decisions, reviews, reports: anything easier to grasp as a page.
  Not for a few sentences of prose.

COMMANDS
  ${BIN}                         sessions + this summary
  ${BIN} <file>                  open/resume a review   [--no-open] [--reopen]
  ${BIN} poll <file>             long-poll for feedback  [--agent-reply "..."] [--agent-reply-file f|-]
                                   one poll per session; --takeover replaces a stuck one
  ${BIN} reply <file>            post a reply without polling  --agent-reply "..." | --agent-reply-file f|-
  ${BIN} end <file>              end the review as the agent
  ${BIN} check <file>            validate the program (no browser)
  ${BIN} patch <file>            merge statements from stdin into the program: same name
                                   replaces, new name adds, \`name = null\` deletes
  ${BIN} spec [group...]         component reference (groups: Layout Content Data Charts Forms Buttons)
  ${BIN} export <file>           single self-contained HTML   [--out path]
  ${BIN} stop                    stop the background server

ENV
  AUSTERE_AXI_PORT (4388)  AUSTERE_AXI_STATE_DIR (~/.austere-axi)  AUSTERE_AXI_NO_OPEN=1
  AUSTERE_AXI_HOST  AUSTERE_AXI_NO_TAILSCALE=1  AUSTERE_AXI_DISCONNECT_GRACE_MS (300000)
  AUSTERE_AXI_IDLE_TIMEOUT_MS (1800000)  AUSTERE_AXI_ALLOWED_HOSTS
`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const takesValue = ["agent-reply", "agent-reply-file", "owner", "out", "port", "also-listen", "timeout-ms"].includes(key);
      let val = true;
      if (eq > 0) val = a.slice(eq + 1);
      else if (takesValue) val = argv[++i];
      if (key === "also-listen") (flags[key] ||= []).push(val);
      else flags[key] = val;
    } else if (a === "-h") flags.help = true;
    else if (a === "-v" || a === "-V") flags.version = true;
    else pos.push(a);
  }
  return { flags, pos };
}

function fail(message, extra = {}) {
  print({ status: "error", error: message, ...extra });
  process.exitCode = 1;
}

function needFile(file, cmd) {
  if (!file) {
    fail(`${cmd} needs a file: ${BIN} ${cmd} <file.html>`);
    return null;
  }
  const abs = canonicalFile(file);
  if (!fs.existsSync(abs)) {
    fail(`no such file: ${abs}`);
    return null;
  }
  return abs;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function replyText(flags) {
  if (typeof flags["agent-reply-file"] === "string") {
    const f = flags["agent-reply-file"];
    return (f === "-" ? await readStdin() : fs.readFileSync(f, "utf8")).trim();
  }
  if (typeof flags["agent-reply"] === "string") return flags["agent-reply"].trim();
  return "";
}

function compactCheck(result) {
  if (result.ok && !result.warnings.length) return `ok (${result.statements} statements)`;
  const out = { ok: result.ok, statements: result.statements };
  if (result.errors.length) out.errors = result.errors;
  if (result.warnings.length) out.warnings = result.warnings;
  return out;
}

// ── commands ──

async function cmdHome() {
  const h = await serverIfRunning();
  let sessions = [];
  if (h) {
    const r = await request("GET", "/api/sessions");
    sessions = (r.data.sessions || [])
      .filter((s) => s.status !== "ended")
      .slice(0, 12)
      .map((s) => ({
        file: s.file,
        presence: s.presence,
        browsers: s.browsers,
        pending: s.pending || undefined,
        url: s.links.local,
      }));
  }
  process.stdout.write(HELP + "\n");
  print({ server: h ? `running on ${port()} (v${h.version})` : "not running", open_sessions: sessions.length ? sessions : "none" });
}

async function cmdOpen(file, flags) {
  const abs = needFile(file, "open");
  if (!abs) return;
  const html = fs.readFileSync(abs, "utf8");
  const check = checkHtml(html);
  await ensureServer();
  const r = await request("POST", "/api/open", { file: abs, reopen: !!flags.reopen });
  if (r.status !== 200) return fail(r.data?.error || `open failed (${r.status})`);
  const d = r.data;
  if (d.status === "refused") {
    return print({
      status: "refused",
      file: abs,
      reason: "The reviewer ended this session from the browser.",
      next: `Continue in chat. Only if the user asks for another review (or something needs their eyes), run: ${BIN} ${quote(file)} --reopen`,
    });
  }
  const noOpen = flags["no-open"] || /^(1|true|yes)$/i.test(process.env.AUSTERE_AXI_NO_OPEN || "");
  let browser;
  if (d.browsers > 0) browser = `already open (${d.browsers} tab${d.browsers > 1 ? "s" : ""}); it live-updates`;
  else if (noOpen) browser = "not opened (--no-open)";
  else browser = openBrowser(d.links.local) ? "opened" : "could not launch; open the url";
  const out = {
    status: "open",
    file: abs,
    url: d.links.local,
    phone: d.links.remote,
    browser,
    check: compactCheck(check),
  };
  if (d.pending) out.queued_feedback = d.pending;
  out.next = check.ok
    ? `Run \`${BIN} poll ${quote(file)}\` and leave it running until it returns.`
    : `Fix the errors above (the page renders what it can), then run \`${BIN} poll ${quote(file)}\`.`;
  print(out);
}

function quote(file) {
  return /[\s"'$`\\]/.test(file) ? JSON.stringify(file) : file;
}

function describeItems(abs, items) {
  let lines = new Map();
  try {
    lines = statementLines(fs.readFileSync(abs, "utf8"));
  } catch {
    // file gone
  }
  const at = (id) => {
    const l = lines.get(id);
    if (!l) return {};
    const first = l.text.split("\n")[0];
    return { line: l.line, source: first.length > 110 ? first.slice(0, 109) + "…" : first };
  };
  return items.map((it) => {
    if (it.kind === "annotation") {
      const o = { annotation: `${it.target} (${it.component})`, ...at(it.target) };
      const within = (it.path || []).slice(0, -1).filter((p) => p !== "root");
      if (within.length) o.within = within.join(" > ");
      if (it.selection) o.selection = it.selection;
      else if (it.excerpt) o.excerpt = it.excerpt;
      if (it.detail) o.detail = it.detail;
      o.note = it.note || "(no note: the selection itself is the point)";
      return o;
    }
    if (it.kind === "action") {
      const o = { action: it.message };
      if (it.form) o.form = it.form;
      if (it.context !== undefined) o.context = it.context;
      return o;
    }
    if (it.kind === "render-error") {
      return { render_error: it.statement || "(page)", ...at(it.statement), error: it.message, note: it.note };
    }
    return { message: it.text ?? it.note ?? "" };
  });
}

const NEXT = {
  feedback: (f) =>
    `Apply it by editing the named statements in place (keep names stable; the page live-updates and highlights changes). Run \`${BIN} check ${f}\` if you restructured, then \`${BIN} poll ${f} --agent-reply "<one line: what changed>"\`.`,
  feedbackEnded: () =>
    "The reviewer sent this and ended the review. Apply it, then summarize what you changed in chat. Do not poll or reopen.",
  ended: (f) =>
    `The review ended. Stop polling and continue in chat. Reopen only if the user asks (\`${BIN} ${f} --reopen\`).`,
  browser_disconnected: (f) =>
    `Every review tab has been closed for a while. Ask the user whether to reopen (\`${BIN} ${f}\`) or end it (\`${BIN} end ${f}\`); do not reopen on your own.`,
  replaced: () => "Another poll took over this session. Stop polling here.",
  interrupted: (f) => `The server restarted; queued feedback is safe. Run the same poll again: \`${BIN} poll ${f}\`.`,
  timeout: (f) => `No feedback yet. Run \`${BIN} poll ${f}\` again.`,
};

async function cmdPoll(file, flags) {
  const abs = needFile(file, "poll");
  if (!abs) return;
  await ensureServer();
  const reply = await replyText(flags);
  if (!reply && (flags["agent-reply"] !== undefined || flags["agent-reply-file"] !== undefined)) {
    return fail("the agent reply is empty");
  }
  process.stderr.write(`[${BIN}] waiting for feedback on ${path.basename(abs)} (interrupting is safe: feedback stays queued)\n`);
  const ticker = process.stderr.isTTY
    ? setInterval(() => process.stderr.write(`[${BIN}] still waiting…\n`), 60_000)
    : null;
  let r;
  try {
    r = await request("POST", "/api/poll", {
      file: abs,
      agentReply: reply || undefined,
      owner: typeof flags.owner === "string" ? flags.owner : undefined,
      takeover: !!flags.takeover,
      timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined,
    });
  } catch (err) {
    if (ticker) clearInterval(ticker);
    return print({ status: "interrupted", file: abs, next: NEXT.interrupted(quote(file)) });
  }
  if (ticker) clearInterval(ticker);
  if (r.status === 404) {
    return fail(`no review session for this file; open it first: ${BIN} ${quote(file)}`);
  }
  if (r.status === 409) {
    return print({
      status: "listener_active",
      file: abs,
      owner: r.data.owner || undefined,
      next: "Another poll is already listening. Leave it, or pass --takeover to replace it.",
    });
  }
  const d = r.data || {};
  const f = quote(file);
  if (d.status === "feedback") {
    const out = { status: "feedback", file: abs, items: describeItems(abs, d.items || []) };
    if (d.ended) out.ended = `by ${d.endedBy || "user"}`;
    out.next = d.ended ? NEXT.feedbackEnded(f) : NEXT.feedback(f);
    return print(out);
  }
  const out = { status: d.status || "unknown", file: abs };
  if (d.endedBy) out.ended_by = d.endedBy;
  if (NEXT[d.status]) out.next = NEXT[d.status](f);
  print(out);
}

async function cmdReply(file, flags) {
  const abs = needFile(file, "reply");
  if (!abs) return;
  const text = await replyText(flags);
  if (!text) return fail('reply needs text: --agent-reply "..." or --agent-reply-file <path|->');
  await ensureServer();
  const r = await request("POST", "/api/reply", { file: abs, text }, { timeoutMs: 10_000 });
  if (r.status !== 200) return fail(r.data?.error || `reply failed (${r.status})`);
  print({ status: "replied", file: abs });
}

async function cmdEnd(file) {
  const abs = needFile(file, "end");
  if (!abs) return;
  const h = await serverIfRunning();
  if (!h) return print({ status: "ended", file: abs, note: "server was not running" });
  const r = await request("POST", "/api/end", { file: abs });
  if (r.status !== 200) return fail(r.data?.error || `end failed (${r.status})`);
  print({ status: "ended", file: abs });
}

function cmdCheck(file) {
  const abs = needFile(file, "check");
  if (!abs) return;
  const result = checkHtml(fs.readFileSync(abs, "utf8"));
  const out = { status: result.ok ? "ok" : "errors", file: abs, statements: result.statements };
  if (result.errors.length) out.errors = result.errors;
  if (result.warnings.length) out.warnings = result.warnings;
  if (result.ok && result.hasMermaid) out.note = "Mermaid sources are checked only when they render in the review page.";
  print(out);
  if (!result.ok) process.exitCode = 1;
}

async function cmdPatch(file) {
  const abs = needFile(file, "patch");
  if (!abs) return;
  if (process.stdin.isTTY) return fail(`pipe the changed statements on stdin: ${BIN} patch ${quote(file)} <<'EOF' ... EOF`);
  const patch = await readStdin();
  if (!patch.trim()) return fail("stdin was empty");
  const html = fs.readFileSync(abs, "utf8");
  const art = readArtifact(html);
  if (art.program == null) return fail('no <script type="text/openui"> block to patch');
  const merged = mergeStatements(art.program.trim(), patch.trim(), "root");
  const next = replaceProgram(html, merged);
  fs.writeFileSync(abs, next);
  const result = checkHtml(next);
  print({ status: "patched", file: abs, check: compactCheck(result) });
}

function cmdSpec(groups) {
  const text = fs.readFileSync(assetPath("prompt.md"), "utf8");
  if (!groups.length) return process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  const wanted = new Set(groups.map((g) => g.toLowerCase()));
  const parts = text.split(/\n(?=### )/);
  const head = parts[0].split("\n## Component Signatures")[0];
  const picked = parts.filter((p) => p.startsWith("### ") && wanted.has(p.slice(4, p.indexOf("\n")).trim().toLowerCase()));
  if (!picked.length) return fail(`unknown group; one of: Layout Content Data Charts Forms Buttons`);
  const trimmed = picked.map((p) => p.split(/\n## /)[0]);
  process.stdout.write(`${head}\n\n## Component Signatures (subset)\n\n${trimmed.join("\n")}\n`);
}

function cmdExport(file, flags) {
  const abs = needFile(file, "export");
  if (!abs) return;
  const out = typeof flags.out === "string" ? path.resolve(flags.out) : abs.replace(/\.html?$/i, "") + ".export.html";
  const { html, notices } = exportHtml(fs.readFileSync(abs, "utf8"));
  fs.writeFileSync(out, html);
  print({ status: "exported", file: out, bytes: html.length, notices: notices.length ? notices : undefined });
}

async function cmdStop() {
  const h = await serverIfRunning();
  if (!h) return print({ status: "not running" });
  await request("POST", "/api/shutdown", {}).catch(() => {});
  print({ status: "stopped", port: port() });
}

async function cmdServer(flags) {
  const { runServer } = await import("./server.js");
  const p = flags.port ? Number(flags.port) : port();
  await runServer({ port: p, verbose: !!flags.verbose, alsoListen: flags["also-listen"] || [] });
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  if (flags.version) return process.stdout.write(VERSION + "\n");
  const [cmd, ...rest] = pos;
  if (flags.help) {
    if (cmd === "reply" || cmd === "poll") {
      return process.stdout.write(
        `${BIN} ${cmd} <file> --agent-reply "text" | --agent-reply-file <path|->\n` +
          "Replies render a small Markdown subset (paragraphs, - lists, `code`, **bold**, links). Keep them to a line or two.\n",
      );
    }
    return process.stdout.write(HELP);
  }
  stateDir();
  switch (cmd) {
    case undefined:
      return cmdHome();
    case "poll":
      return cmdPoll(rest[0], flags);
    case "reply":
      return cmdReply(rest[0], flags);
    case "end":
      return cmdEnd(rest[0]);
    case "check":
      return cmdCheck(rest[0]);
    case "patch":
      return cmdPatch(rest[0]);
    case "spec":
      return cmdSpec(rest);
    case "export":
      return cmdExport(rest[0], flags);
    case "stop":
      return cmdStop();
    case "server":
      return cmdServer(flags);
    case "open":
      return cmdOpen(rest[0], flags);
    case "help":
      return process.stdout.write(HELP);
    default:
      if (/\.html?$/i.test(cmd) || fs.existsSync(cmd)) return cmdOpen(cmd, flags);
      return fail(`unknown command: ${cmd}. Run ${BIN} --help`);
  }
}

main().catch((err) => {
  process.stdout.write(format({ status: "error", error: String(err?.message || err) }) + "\n");
  process.exitCode = 1;
});
