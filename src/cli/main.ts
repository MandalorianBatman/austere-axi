process.env.OPENUI_TELEMETRY_DISABLED = process.env.OPENUI_TELEMETRY_DISABLED || "1";

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { mergeStatements } from "@openuidev/lang-core";
import { CDN_RUNTIME_URL, readArtifact, replaceProgram } from "./artifact.ts";
import { checkHtml, statementLines } from "./check.ts";
import type { CheckResult } from "./check.ts";
import { splitStatements } from "../shared/statements.ts";
import { ensureServer, health, loginUrl, openBrowser, probePort, request, serverIfRunning, shutdownServer, takeServerNote } from "./client.ts";
import { Hub, hubDbFile, openHubDirect, registerWithHub, unanswered } from "./hub.ts";
import type { HubCounts, HubNoteRow, HubPage } from "./hub.ts";
import { addRoot, copyLabel, findProject, forgetRoot, listProjects, mergeProjects, renameProject } from "./projects.ts";
import { InviteStore, inviteId } from "./invites.ts";
import { lockStateDir } from "./lock.ts";
import { installService, installedServiceFor, serverUnit, serviceContext, serviceStatus, uninstallService } from "./service.ts";
import { SessionStore, sessionId } from "./sessions.ts";
import type { FeedbackEntry, NoteItem } from "./sessions.ts";
import type { FeedbackResponse, InviteSummary, OpenResponse, PollResponse, ProjectFeedbackResponse, RevokeResponse, SessionListing, SessionsResponse, ShareListResponse, ShareResponse } from "./server.ts";
import * as cloud from "./cloud.ts";
import { exportHtml } from "./export.ts";
import { renderCheck } from "./render-check.ts";
import { format, print as printOutput } from "./output.ts";
import { describeItem, locator } from "../shared/feedback.ts";
import type { FeedbackItem } from "../shared/feedback.ts";
import { VERSION, applyDevDefaults, assetPath, canonicalFile, port, quote, stateDir } from "./paths.ts";
import { listComponents, searchComponents, showComponents } from "./components.ts";
import type { InstallError } from "./install.ts";
import { installedPacks, isThirdParty, neededPacks, pagePacks, setPacksMeta } from "./packs.ts";
import type { InstalledPack } from "./packs.ts";
import { isScope, readTrustList, trustFile, updateTrustList } from "./trust.ts";
import { defaultRegistry, npmView, readRegistries, registriesFile, registryEntry, registryFor, writeRegistries } from "./registries.ts";
import { splitSpec } from "../shared/packs-meta.ts";
import type { PackRef } from "../shared/packs-meta.ts";

/** A YAML-shaped result for print(), built up field by field. */
type Printed = Record<string, unknown>;

/** Parsed flags: a switch is `true`, a value flag its string, a repeatable flag every value given. */
interface Flags {
  [flag: string]: string | true | string[] | undefined;
  "also-listen"?: string[];
  invite?: string[];
}

/** A command's entry in COMMANDS. */
interface CommandSpec {
  usage: string;
  summary: string;
  /** Flag name → one-line help. */
  flags: Record<string, string>;
  example: string;
}

/** The message of what a catch caught: the CLI's own code throws Errors. */
function messageOf(err: unknown): string {
  const e = err as Error;
  return e.message;
}

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
     Arguments are positional and typed: follow each signature in spec exactly (order and
     type; an array stays an array). Pass null to skip an optional one.
  3. ${BIN} <file.html>          validate + register + open for review; fix any errors it lists.
                                   --no-open: print the url for the user instead. Any registered
                                   page takes notes while the server runs; no browser need be open.
  4. ${BIN} poll                 wait for feedback on every page of this folder's project, one poll
                                   (foreground; if the call times out, poll again). Each batch names
                                   its file. If your harness wakes you when a background job
                                   finishes, run poll as a background job; otherwise run it in the
                                   foreground. --project <dir|name>: another project. One page only:
                                   ${BIN} poll <file.html>
  5. Revise with patch only: send just the changed statements; do not rewrite or re-read
     the file (each note carries its statement's line and source):
       ${BIN} patch <file.html> <<'EOF'
       risks = Table([...])        same name replaces, new name adds, \`name = null\` deletes
       EOF
     If a changed value appears in several statements, patch each of them.
     Then reply for each page (a reply acknowledges that page's batch) and listen again;
     --cursor acknowledges every page in the batch list:
       ${BIN} reply <file.html> --agent-reply "one line: what changed"
       ${BIN} poll --cursor <n>
     (With one page: ${BIN} poll <file.html> --cursor <n> --agent-reply "one line: what changed")
  6. On final: true (the reviewer pressed Send & End): apply that batch and reply, then stop
     polling and continue in chat (no further poll). A note sent later waits for your next poll.

FEEDBACK (poll)
  status: feedback | timeout | replaced | interrupted, plus next:   (replaced: a newer poll on the same
          page or project took over, notes are safe and go to it; stop. interrupted: the server restarted; poll again)
  batches: a project poll lists one batch per page: file, copy (the branch or folder that page lives in), final, items.
  final: true   the reviewer pressed Send & End on this batch: apply it, then stop listening.
  cursor: pass it back to acknowledge (poll --cursor covers every page in the batch list); unacknowledged feedback is returned again.
  items: annotation: <statement> (<Component>) with line, source, note
         action: <@ToAssistant message> with form values | message: <free text>
         render_error: <statement>  sent by the open review page on its own

CHECK verifies syntax, component names, required props, unresolved references and
statements unreachable from root. It warns when an Architecture diagram will not fit the
page (it would scroll sideways).

LOOKS
  The reviewer judges how the page looks. Do not open, screenshot or inspect the page
  yourself (browser tools, curl, headless runs) unless the user asks: check ok + open is
  done. Render failures come back through poll. When the user asks you to verify the
  page, run \`${BIN} check --render <file>\` (headless Chrome, text report, no image).

COMMANDS
  ${BIN} check <file>            validate without a browser: syntax, components, props,
                                   references   [--fix: declare packs] [--render]
  ${BIN} reply <file>            reply without polling  --agent-reply "..."  [--cursor n]
  ${BIN} archive <file>          put a page away: the hub's lists leave it out (unarchive: back)
  ${BIN} feedback [file]         notes no agent has answered yet (no file: the whole project)   [--all] [--peek]
  ${BIN} login [file]            single-use sign-in link for a browser the CLI did not open
  ${BIN} components search <words> | show <Name...>   components spec leaves out, and packs on npm
  ${BIN} trust list              packs and scopes the user lets you add without --trust
  ${BIN} registry list           private registries the user mapped npm scopes to
  ${BIN} server install          the server as a service of your user account: always on (owner only)
  ${BIN} publish <file>          hosted share link (austere.kasat.xyz), only when the user asks
  ${BIN} <command> --help        one command's flags and an example
  ${BIN} help all                every command, notes and environment
`;

/** `help all`: every command from COMMANDS (generated, so it cannot drift), then notes and the environment. */
function helpAll() {
  const rows = Object.entries(COMMANDS).map(([, c]) => `  ${BIN} ${c.usage}\n      ${c.summary}`);
  return `
ALL COMMANDS
${rows.join("\n")}

NOTES
  The CDN script tag lets the file open on its own (needs network); review and export work
  offline. A browser the CLI did not open gets 403 until it signs in with \`${BIN} login\`.
  check warns when an Architecture diagram will not fit the page.
  check --render needs Chrome, Chromium or Edge (or CHROME_PATH).

ENV
  AUSTERE_AXI_PORT (4388)  AUSTERE_AXI_STATE_DIR (~/.austere-axi)  AUSTERE_AXI_NO_OPEN=1
  AUSTERE_AXI_HOST  AUSTERE_AXI_NO_TAILSCALE=1
  AUSTERE_AXI_IDLE_TIMEOUT_MS (1800000)  AUSTERE_AXI_PERSIST=1  AUSTERE_AXI_ALLOWED_HOSTS  AUSTERE_AXI_LINK_URL
  AUSTERE_AXI_NPM_REGISTRY  CHROME_PATH (check --render)  AUSTERE_AXI_CLOUD_URL (https://austere.kasat.xyz)
  A scope's token variable (registry add --token-env), sent only to that scope's registry
`;
}

/**
 * Every command: usage line, one-line summary, the flags it accepts (name → help) and an example.
 * main() rejects any flag a command does not list, and `<command> --help` prints its entry.
 * Keep in step with HELP above and docs/cli.md.
 */
const COMMANDS: Record<string, CommandSpec> = {
  open: {
    usage: "<file> [--no-open]",
    summary: "validate the page and open it for review (`open <file>` is the same)",
    flags: { "no-open": "do not launch a browser; print the url (and a phone url when Tailscale is up)" },
    example: "plan.html --no-open",
  },
  poll: {
    usage: "poll [file] [--project p] [--cursor n] [--agent-reply text | --agent-reply-file path|-]",
    summary:
      "wait until the reviewer presses Send; returns the feedback batch and a cursor. With no file it listens to every page of the project (the folder you run it in, or --project): each batch names its file and copy, --cursor acknowledges every page, and a poll on one page wins for that page. Replies stay per page: use reply <file>",
    flags: {
      cursor: "acknowledge feedback up to n (the cursor the last poll printed)",
      after: "return everything after n again",
      "agent-reply": "post a reply first: a small Markdown subset (paragraphs, - lists, `code`, **bold**, links), a line or two",
      "agent-reply-file": "read the reply from a file, or - for stdin",
      project: "the project to listen to when no file is given: a name, an id, or a folder inside one of its roots (default: the current folder)",
      "timeout-ms": "return status: timeout after n ms (default: wait for feedback)",
    },
    example: 'poll plan.html --cursor 3 --agent-reply "Switched the rollout to dual-write."   |   poll --cursor 9',
  },
  reply: {
    usage: "reply <file> --agent-reply text | --agent-reply-file path|- [--cursor n]",
    summary: "post a reply without polling; acknowledges feedback up to the cursor. On a published file the reply is also posted to the hosted page (a warning says when it is queued)",
    flags: {
      "agent-reply": "reply text: a small Markdown subset, a line or two",
      "agent-reply-file": "read the reply from a file, or - for stdin",
      cursor: "acknowledge feedback up to n",
    },
    example: 'reply plan.html --cursor 3 --agent-reply "Done."',
  },

  login: {
    usage: "login [file]",
    summary: "single-use link that signs a browser in as you (SSH, --no-open, another browser)",
    flags: {},
    example: "login plan.html",
  },
  feedback: {
    usage: "feedback [file] [--project p] [--all] [--peek]",
    summary: "feedback no agent has answered yet; reading it acknowledges it, reply answers it. With no file it reads every page of the project (the folder you run it in, or --project)",
    flags: { project: "the project to read when no file is given: a name, an id, or a folder inside one of its roots (default: the current folder)", all: "include feedback already answered", peek: "read without acknowledging" },
    example: "feedback plan.html",
  },
  check: {
    usage: "check <file> [--fix] [--render]",
    summary: "validate the program without a browser: syntax, components, props, references, reachability",
    flags: {
      fix: 'declare the packs the page uses (writes the <meta name="austere-packs"> tag)',
      render: "also render it in headless Chrome and report render errors and sideways scrolling as text (needs Chrome or CHROME_PATH); only when the user asks",
    },
    example: "check plan.html",
  },
  patch: {
    usage: "patch <file> < statements",
    summary: "merge statements from stdin: same name replaces, new name adds, `name = null` deletes",
    flags: {},
    example: "patch plan.html <<'EOF'\n  intro = Card([CardHeader(\"New title\")])\n  EOF",
  },
  spec: {
    usage: "spec [group|pack...]",
    summary: "component reference; groups: Layout Content Data Charts Forms Buttons",
    flags: {},
    example: "spec Charts Forms",
  },
  components: {
    usage: "components [list [group] | search <words> | show <Name...> [--pack pkg] | add <pkg|folder|file.tgz> [--trust] | remove <pkg> | new <dir> [--name pkg] | build [dir]]",
    summary: "every component, including ones spec leaves out; search also lists up to 3 from packs on npm (not installed) under `npm`, and show finds them; install, remove and write packs",
    flags: {
      trust: "install a third-party pack not on the user's trust list; ask the user to review it and run the command themselves",
      name: "npm package name for `new`",
      pack: "`show` looks only in this pack (core, an installed pack, or one on npm), for a name several packs share",
    },
    example: "components search scatter",
  },
  trust: {
    usage: "trust [list | add <pkg[@range]|@scope> | remove <pkg|@scope>]",
    summary:
      "the user's trust list: packs you may add without --trust, as pinned versions (same pack.js) or scopes on the registry they were added from; add asks the user at a terminal",
    flags: {},
    example: "trust add austere-pack-gantt@1.2.0",
  },
  registry: {
    usage: "registry [list | add <@scope> <url> [--token-env NAME] | remove <@scope>]",
    summary:
      "private npm registries for scopes: search, show and add fetch the scope's packs from its registry; grants no trust (its packs stay third-party unless on the trust list); add needs the user at a terminal",
    flags: { "token-env": "name of an environment variable holding a bearer token for the registry (the token itself is never stored)" },
    example: "registry add @acme https://npm.acme.dev/ --token-env ACME_NPM_TOKEN",
  },
  export: {
    usage: "export <file> [--out path]",
    summary: "one self-contained HTML file that works offline; keep reviewing and patching the source page, not the copy",
    flags: { out: "output path (default: <file>.export.html)" },
    example: "export plan.html --out review.html",
  },
  hub: {
    usage: "hub [list|notes|open] [words] [--project p] [--archived] [--all] [--unanswered] [--limit n]",
    summary: "the owner's home page, always on: every page by project (one entry per page, a copy per worktree), every note",
    flags: {
      project: "only pages or notes from this project: a name, an id, or a folder inside one of its roots (list, notes)",
      archived: "list archived pages instead (list)",
      all: "also list pages only checked, never opened for review, and archived ones (list)",
      unanswered: "only notes no agent answered (notes)",
      limit: "show up to n pages or notes (default 40)",
    },
    example: "hub notes --unanswered",
  },
  project: {
    usage: "project [list | add <dir> [--name n] | merge <a> <b> | rename <p> <name> | forget-root <dir>]",
    summary:
      "projects in the hub: a name and its root folders, found without git (a .git folder or a worktree's .git file, else the page's folder); add assigns a root, merge moves b's roots into a, forget-root drops one",
    flags: { name: "the project to add the root to, made if there is none (add)" },
    example: "project add ~/work/site --name site",
  },
  archive: { usage: "archive <file>", summary: "put a page away: the hub's lists leave it out (`hub list --archived` shows it) and its composer is locked; its notes stay", flags: {}, example: "archive plan.html" },
  unarchive: { usage: "unarchive <file>", summary: "bring an archived page back: it is listed again and takes notes", flags: {}, example: "unarchive plan.html" },
  share: {
    usage: 'share <file> --as "<name>" [--auto] | share list [--links] | share revoke <name|id>',
    summary: "invite link for a teammate on your tailnet; their notes wait for you unless --auto",
    flags: { as: "the reviewer's name", auto: "send this reviewer's notes straight to the agent", links: "show the links (list)" },
    example: 'share plan.html --as "Ana"',
  },
  publish: {
    usage:
      "publish <file> [--invite <name>]... [--expires <dur>] [--unlisted] [--auto] [--no-presence] [--new] | publish invites <file> | publish revoke <file> <name> | publish list | publish rm <file|id>",
    summary:
      "hosted share link on austere.kasat.xyz: uploads the page, its installed packs and the images beside it; again on the same file updates the same link. Pages are invite-only: each --invite prints that reviewer's own link, revocable with publish revoke. The only command that publishes a page; run it only when the user asks to share a page. Afterwards the local server syncs the page: its notes reach poll and feedback marked remote: true, held for the owner unless --auto, and replies and the owner's Send/Discard go to the hosted page",
    flags: {
      invite: "invite a reviewer by name and print their link (repeatable); the same name again keeps its link",
      expires: "the invites of this publish stop working after this long: 30m, 12h, 7d, 2w (default: with the page)",
      unlisted: "anyone with the plain page URL may review, naming themselves (applies to this publish)",
      auto: "reviewers' notes go straight to the agent instead of held (applies to this publish)",
      "no-presence": "viewers do not see who else is on the page or what they clicked (applies to this publish)",
      new: "a fresh link instead of updating this file's",
    },
    example: 'publish plan.html --invite "Ana" --invite "Ben"',
  },
  stop: { usage: "stop", summary: "stop the background server", flags: {}, example: "stop" },
  server: {
    usage: "server [install|uninstall|status] [--persist] [--port n] [--verbose] [--link-url u]",
    summary:
      "run the server in the foreground (behind a reverse proxy); `server install` (at a terminal only) makes it always on as a per-user systemd or launchd service that starts at login and restarts on failure, `server uninstall` removes it, `server status` shows it",
    flags: {
      persist: "never idle out",
      port: "listen port (default: AUSTERE_AXI_PORT or 4388); with install, the port the service listens on",
      verbose: "log requests",
      "also-listen": "extra address to listen on (repeatable)",
      "link-url": "install: the address reviewers reach the server at, e.g. https://austere.example.com (AUSTERE_AXI_LINK_URL in the unit)",
    },
    example: "server install --link-url https://austere.example.com",
  },
  mcp: { usage: "mcp", summary: "MCP server on stdio: spec check open poll reply patch components as tools", flags: {}, example: "mcp" },
  help: { usage: "help [command]", summary: "the full workflow, or one command's help", flags: {}, example: "help poll" },
};

/** Flags that take a value; every other flag is a switch. */
const VALUE_FLAGS = new Set(["agent-reply", "agent-reply-file", "owner", "out", "port", "also-listen", "timeout-ms", "name", "pack", "project", "as", "cursor", "after", "token-env", "invite", "expires", "link-url", "limit"]);

function parseArgs(argv: string[]): { flags: Flags; pos: string[]; error?: string } {
  const flags: Flags = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let val: string | true = true;
      if (eq > 0) val = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(key)) {
        if (i + 1 >= argv.length) return { flags, pos, error: `--${key} needs a value` };
        val = argv[++i];
      }
      if (key === "also-listen" || key === "invite") (flags[key] ||= []).push(String(val));
      else flags[key] = val;
    } else if (a === "-h") flags.help = true;
    else if (a === "-v" || a === "-V") flags.version = true;
    else pos.push(a);
  }
  return { flags, pos };
}

/**
 * The command's own output. A note the server left (a supervised server that needs a restart)
 * goes with it, so a harness that reads stdout sees it.
 */
function print(obj: Printed): void {
  // The server's note goes with the command's own note, not instead of it.
  const note = takeServerNote();
  printOutput(note ? { ...obj, server_note: note } : obj);
}

/** A failure while running: exit 1. */
function fail(message: string, extra: Printed = {}): void {
  print({ status: "error", error: message, ...extra });
  process.exitCode = 1;
}

/** The command was called wrong (unknown command or flag, missing argument): exit 2, before anything runs. */
function usage(message: string, cmd?: string | null): void {
  const spec = cmd && COMMANDS[cmd];
  print({ status: "error", code: "USAGE", error: message, usage: spec ? `${BIN} ${spec.usage}` : undefined, help: `${BIN} ${spec ? `${cmd} ` : ""}--help` });
  process.exitCode = 2;
}

/**
 * Commands and flags the review loop dropped in 0.12 (RLM-338): a page always takes notes, so there is nothing to
 * end, close or reopen, and the newest poll wins. Each exits 2 with its replacement; 0.13 reports them as unknown.
 */
const REMOVED_COMMANDS: Record<string, string> = {
  end: "a page always takes notes, so there is nothing to end; stop polling and continue in chat",
  close: `use \`${BIN} archive <file>\`: it locks the composer`,
  reopen: `use \`${BIN} unarchive <file>\`; a page that is not archived needs nothing`,
};
const REMOVED_FLAGS: Record<string, string> = {
  reopen: `a page always takes notes; to unlock an archived page run \`${BIN} unarchive <file>\``,
  takeover: "the newest poll replaces the older one by itself",
  owner: "nothing shows a listener's label any more: the newest poll replaces the older one",
};

function removed(what: string, instead: string): void {
  print({ status: "error", code: "REMOVED", error: `${what} was removed: ${instead}`, help: `${BIN} --help` });
  process.exitCode = 2;
}

function commandHelp(cmd: string): void {
  const spec = COMMANDS[cmd];
  const lines = [`${BIN} ${spec.usage}`, `  ${spec.summary}`];
  const flags = Object.entries(spec.flags);
  if (flags.length) {
    lines.push("", "FLAGS");
    const width = Math.max(...flags.map(([k]) => k.length + (VALUE_FLAGS.has(k) ? 6 : 0)));
    for (const [k, text] of flags) lines.push(`  ${(`--${k}` + (VALUE_FLAGS.has(k) ? " <val>" : "")).padEnd(width + 4)}${text}`);
  }
  lines.push("", "EXAMPLE", `  ${BIN} ${spec.example}`, "", `Full workflow and file skeleton: ${BIN} --help`);
  process.stdout.write(lines.join("\n") + "\n");
}

function needFile(file: string | undefined, cmd: string): string | null {
  if (!file) {
    usage(`${cmd} needs a file: ${BIN} ${cmd} <file.html>`, cmd);
    return null;
  }
  const abs = canonicalFile(file);
  if (!fs.existsSync(abs)) {
    fail(`no such file: ${abs}`);
    return null;
  }
  return abs;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function replyText(flags: Flags): Promise<string> {
  if (typeof flags["agent-reply-file"] === "string") {
    const f = flags["agent-reply-file"];
    return (f === "-" ? await readStdin() : fs.readFileSync(f, "utf8")).trim();
  }
  if (typeof flags["agent-reply"] === "string") return flags["agent-reply"].trim();
  return "";
}

function compactCheck(result: CheckResult): string | Printed {
  if (result.ok && !result.warnings.length) return `ok (${result.statements} statements)`;
  const out: Printed = { ok: result.ok, statements: result.statements };
  if (result.errors.length) out.errors = result.errors;
  if (result.warnings.length) out.warnings = result.warnings;
  return out;
}

// ── commands ──

async function cmdHome() {
  const h = await serverIfRunning();
  let sessions: SessionListing[] = [];
  if (h) {
    const r = await request<SessionsResponse>("GET", "/api/sessions");
    sessions = (r.data.sessions || []).filter((s) => !s.archived);
  }
  const shown = sessions.slice(0, 12).map((s) => ({
    file: s.file,
    presence: s.presence,
    browsers: s.browsers,
    pending: s.pending || undefined,
    url: s.links.local,
  }));
  print({
    bin: `${BIN} ${VERSION}`,
    description: "review pages written in OpenUI Lang; the reviewer annotates them in the browser and notes come back by statement name",
    server: h ? `running on ${port()} (v${h.version})` : "not running",
    open_sessions: sessions.length > shown.length ? `${shown.length} of ${sessions.length} shown` : sessions.length,
    sessions: shown.length ? shown : undefined,
    commands: Object.fromEntries(Object.entries(COMMANDS).map(([name, c]) => [name === "open" ? "<file>" : name, c.summary])),
    next: shown.length
      ? `${BIN} poll waits for feedback on every page of this folder's project (${BIN} poll <file> for one page). ${BIN} --help: workflow and file skeleton.`
      : `${BIN} --help: workflow and file skeleton. ${BIN} spec: component reference. ${BIN} <command> --help: one command.`,
  });
}

async function cmdOpen(file: string | undefined, flags: Flags): Promise<void> {
  const abs = needFile(file, "open");
  if (!abs || file === undefined) return; // needFile reported a missing file
  const html = fs.readFileSync(abs, "utf8");
  const check = checkHtml(html, { file: quote(file) });
  await ensureServer();
  const r = await request<OpenResponse>("POST", "/api/open", { file: abs });
  if (r.status !== 200) return fail(r.data?.error || `open failed (${r.status})`);
  const d = r.data;
  const noOpen = flags["no-open"] || browserDisabled();
  let browser: string;
  if (d.browsers > 0) browser = `already open (${d.browsers} tab${d.browsers > 1 ? "s" : ""}); it live-updates`;
  else if (noOpen) browser = "not opened (--no-open)";
  else browser = (await openBrowser(d.links.local)) ? "opened" : "could not launch";
  const out: Printed = {
    status: "open",
    file: abs,
    url: d.links.local,
    phone: d.links.remote,
    browser,
    sign_in: browser === "opened" || d.browsers > 0 ? undefined : signInHint(file),
    check: compactCheck(check),
  };
  if (d.pending) out.queued_feedback = d.pending;
  if (d.held) out.held_notes = `${d.held} from teammates, waiting for the owner to send them`;
  if (d.session.archived) out.archived = "notes are locked until the owner unarchives this page";
  if (d.session.archived) {
    out.next = `The page is archived, so it takes no notes. Only if the user asks, run \`${BIN} unarchive ${quote(file)}\`, then \`${BIN} poll ${quote(file)}\`.`;
  } else {
    out.next = check.ok
      ? `Run \`${BIN} poll ${quote(file)}\` and leave it running until it returns.`
      : `Fix the errors above (the page renders what it can), then run \`${BIN} poll ${quote(file)}\`.`;
  }
  print(out);
}

function describeItems(abs: string, items: NoteItem[]): Printed[] {
  let lines = new Map<string, { line: number; text: string }>();
  try {
    lines = statementLines(fs.readFileSync(abs, "utf8"));
  } catch {
    // file gone
  }
  const at = locator(lines);
  return items.map((it) => {
    let o: Printed;
    try {
      // Stored items are untrusted: a malformed one throws, caught here.
      const item: FeedbackItem = it;
      o = describeItem(item, at);
    } catch {
      // one malformed item must not hide the rest of the delivery, which the server already marked received
      o = { malformed: `could not read this ${typeof it?.kind === "string" ? it.kind : "feedback"} item` };
    }
    return it?.author ? { from: it.author, ...(it.remote === true ? { remote: true } : {}), ...o } : o;
  });
}


function thirdPartyOf(abs: string): string[] {
  try {
    return pagePacks(fs.readFileSync(abs, "utf8")).thirdParty.map((p) => `${p.name}@${p.version}`);
  } catch {
    return [];
  }
}

const NEXT: Record<string, (f: string, cursor?: number) => string> = {
  feedback: (f, cursor) =>
    `Revise with \`${BIN} patch ${f}\`: send only the changed statements on stdin (same name replaces, new name adds); do not rewrite or re-read the file. Then \`${BIN} poll ${f} --cursor ${cursor} --agent-reply "<one line: what changed>"\`.`,
  feedbackFinal: (f, cursor) =>
    `The reviewer sent this with Send & End. Apply it with \`${BIN} patch ${f}\` (changed statements only), then \`${BIN} reply ${f} --cursor ${cursor} --agent-reply "<what changed>"\` and summarize in chat. Do not poll again; a note sent later waits for your next poll.`,
  replaced: () => "A newer poll took over this page. Stop polling here.",
  interrupted: (f) => `The server restarted; the feedback is safe and still unread. Run the same poll again: \`${BIN} poll ${f}\`.`,
  timeout: (f) => `No feedback yet. Run \`${BIN} poll ${f}\` again.`,
};

/** `--cursor` / `--after` as given; the server checks they are whole numbers. */
function seqFlag(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/** The project a poll or feedback with no file means: `--project` (a name, an id or a folder), else the folder the command runs in. */
async function projectOfFlags(flags: Flags): Promise<{ id: string; name: string; scope: string; files: string[] } | null> {
  const ref = typeof flags.project === "string" ? flags.project : process.cwd();
  let hub: Hub;
  try {
    hub = await openHubDirect({ write: false });
  } catch (err) {
    fail(`could not open hub.db: ${messageOf(err)}`);
    return null;
  }
  try {
    const project = findProject(hub.db, ref);
    if (!project) {
      fail(
        typeof flags.project === "string"
          ? `no project ${flags.project} (a project name, id, or a folder inside one of its roots; \`${BIN} project list\` shows them)`
          : `no project holds this folder (${ref}): open a page from it with \`${BIN} <file>\`, or name a project with --project`,
      );
      return null;
    }
    const files = (hub.db.prepare("SELECT file FROM artifacts WHERE project_id = ?").all(project.id) as { file: string }[]).map((r) => r.file);
    return { id: project.id, name: project.name, scope: typeof flags.project === "string" ? ` --project ${quote(flags.project)}` : "", files };
  } catch (err) {
    fail(messageOf(err));
    return null;
  } finally {
    hub.close();
  }
}

/** `poll` with no file: one poll for every page of the project. Each batch names its file and copy; `--cursor` acknowledges all of them. */
async function cmdProjectPoll(flags: Flags): Promise<void> {
  if (flags["agent-reply"] !== undefined || flags["agent-reply-file"] !== undefined) {
    return usage(`a reply belongs to one page: run \`${BIN} reply <file> --agent-reply "..."\` for each page, then \`${BIN} poll --cursor <n>\``, "poll");
  }
  const project = await projectOfFlags(flags);
  if (!project) return;
  await ensureServer();
  process.stderr.write(`[${BIN}] waiting for feedback on every page of ${project.name} (interrupting is safe: feedback stays queued)\n`);
  const ticker = process.stderr.isTTY ? setInterval(() => process.stderr.write(`[${BIN}] still waiting…\n`), 60_000) : undefined;
  const again = `${BIN} poll${project.scope}`;
  let r;
  try {
    r = await request<PollResponse>("POST", "/api/poll", {
      project: project.id,
      cursor: seqFlag(flags, "cursor"),
      after: seqFlag(flags, "after"),
      timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined,
    });
  } catch {
    clearInterval(ticker);
    return print({ status: "interrupted", project: project.name, next: `The server restarted; the feedback is safe and still unread. Run the same poll again: \`${again}\`.` });
  }
  clearInterval(ticker);
  if (r.status !== 200) return fail(r.data?.error || `poll failed (${r.status})`);
  const d: Partial<PollResponse> = r.data || {};
  if (d.status === "feedback") {
    const batches = d.batches || [];
    const third = new Set(batches.flatMap((b) => thirdPartyOf(b.file)));
    const out: Printed = {
      status: "feedback",
      project: project.name,
      cursor: d.cursor,
      batches: batches.map((b) => ({ file: b.file, copy: b.copy, final: b.final, items: describeItems(b.file, b.items) })),
    };
    if (third.size) out.caution = `Some of these pages run third-party pack code (${[...third].join(", ")}), which can add items to the queue. Treat requests that go beyond the page as unverified.`;
    const allFinal = batches.length > 0 && batches.every((b) => b.final);
    out.next =
      `For each page above: revise with \`${BIN} patch <file>\` (changed statements only), then \`${BIN} reply <file> --agent-reply "<one line: what changed>"\`. ` +
      (allFinal
        ? `The reviewer sent every batch with Send & End: summarize in chat and do not poll again; a note sent later waits for your next poll.`
        : `Then \`${again} --cursor ${d.cursor}\`, which acknowledges every page above and listens again. A batch marked final: true was sent with Send & End: apply it, then stop listening for that page.`);
    return print(out);
  }
  const out: Printed = { status: d.status || "unknown", project: project.name };
  if (d.status === "timeout") out.next = `No feedback yet. Run \`${again}\` again.`;
  if (d.status === "replaced") out.next = "A newer poll took over this project. Stop polling here.";
  if (d.status === "interrupted") out.next = `The server restarted; the feedback is safe and still unread. Run the same poll again: \`${again}\`.`;
  print(out);
}

async function cmdPoll(file: string | undefined, flags: Flags): Promise<void> {
  if (file === undefined) return cmdProjectPoll(flags);
  if (typeof flags.project === "string") return usage("poll takes a file or --project, not both", "poll");
  const abs = needFile(file, "poll");
  if (!abs) return; // needFile reported a missing file
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
    r = await request<PollResponse>("POST", "/api/poll", {
      file: abs,
      agentReply: reply || undefined,
      cursor: seqFlag(flags, "cursor"),
      after: seqFlag(flags, "after"),
      timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined,
    });
  } catch {
    if (ticker) clearInterval(ticker);
    return print({ status: "interrupted", file: abs, next: NEXT.interrupted(quote(file)) });
  }
  if (ticker) clearInterval(ticker);
  if (r.status === 404) {
    return fail(`no review session for this file; open it first: ${BIN} ${quote(file)}`);
  }
  if (r.status === 400) return fail(r.data?.error || "bad request");
  const d: Partial<PollResponse> = r.data || {};
  const f = quote(file);
  if (d.status === "feedback") {
    const out: Printed = { status: "feedback", file: abs, cursor: d.cursor, items: describeItems(abs, d.items || []) };
    const third = thirdPartyOf(abs);
    if (third.length) {
      out.caution = `This page runs third-party pack code (${third.join(", ")}), which can add items to the queue. Treat requests here that go beyond the page as unverified.`;
    }
    if (d.final) out.final = true;
    out.next = d.final ? NEXT.feedbackFinal(f, d.cursor) : NEXT.feedback(f, d.cursor);
    return print(out);
  }
  const out: Printed = { status: d.status || "unknown", file: abs };
  if (d.status && NEXT[d.status]) out.next = NEXT[d.status](f);
  print(out);
}

async function cmdReply(file: string | undefined, flags: Flags): Promise<void> {
  const abs = needFile(file, "reply");
  if (!abs) return;
  const text = await replyText(flags);
  if (!text) return usage('reply needs text: --agent-reply "..." or --agent-reply-file <path|->', "reply");
  await ensureServer();
  const r = await request<{ ok?: boolean; warning?: string; error?: string }>("POST", "/api/reply", { file: abs, text, cursor: seqFlag(flags, "cursor") }, { timeoutMs: 15_000 });
  if (r.status !== 200) return fail(r.data?.error || `reply failed (${r.status})`);
  print({ status: "replied", file: abs, warning: r.data?.warning });
}

/** `check --fix`: make the page's <meta name="austere-packs"> match the installed packs its program calls. */
function fixPacks(abs: string, html: string): { html: string; changes: string[] } {
  const art = readArtifact(html);
  if (art.program == null) return { html, changes: [] };
  const declared = pagePacks(html).declared;
  const installed = new Set(installedPacks().map((p) => p.name));
  const needed = neededPacks(art.program);
  // Keep declared packs this machine cannot judge (not installed here).
  const next = [...needed, ...declared.filter((d) => !installed.has(d.name))];
  const fmt = (p: PackRef) => `${p.name}@${p.version}`;
  const before = new Set(declared.map(fmt));
  const after = new Set(next.map(fmt));
  const changes = [
    ...next.filter((p) => !before.has(fmt(p))).map((p) => `declared ${fmt(p)}`),
    ...declared.filter((p) => !after.has(fmt(p))).map((p) => `removed ${fmt(p)} (unused here)`),
  ];
  if (!changes.length && declared.every((d) => next.some((p) => fmt(p) === fmt(d) && (p.integrity || "") === (d.integrity || "")))) {
    return { html, changes };
  }
  const out = setPacksMeta(html, next);
  if (out !== html) fs.writeFileSync(abs, out);
  return { html: out, changes: changes.length ? changes : ["updated integrity hashes"] };
}

async function cmdCheck(file: string | undefined, flags: Flags = {}): Promise<void> {
  const abs = needFile(file, "check");
  if (!abs || file === undefined) return; // needFile reported a missing file
  let html = fs.readFileSync(abs, "utf8");
  let fixed: string[] = [];
  if (flags.fix) ({ html, changes: fixed } = fixPacks(abs, html));
  const result = checkHtml(html, { file: quote(file) });
  await registerWithHub(abs, result.title, sessionId(abs));
  const out: Printed = { status: result.ok ? "ok" : "errors", file: abs, statements: result.statements };
  if (fixed.length) out.fixed = fixed;
  if (result.errors.length) out.errors = result.errors;
  if (result.warnings.length) out.warnings = result.warnings;
  if (flags.render) {
    if (!result.ok) out.render = "skipped: fix the errors above first";
    else {
      const render = await renderOut(html, path.dirname(abs));
      out.render = render;
      if (render.errors) out.status = "errors";
      // The check the user asked for did not run: say so in the status and the exit code.
      else if (render.status === "unavailable") out.status = "render_unavailable";
    }
  }
  print(out);
  if (out.status !== "ok") process.exitCode = 1;
}

/** `check --render`'s part of the output: only what is wrong, or `clean`. */
async function renderOut(html: string, dir: string): Promise<Printed> {
  const r = await renderCheck(html, dir);
  if (r.status === "unavailable") return { status: "unavailable", reason: r.reason };
  const status = r.errors.length ? "errors" : r.overflow.length ? "warnings" : "clean";
  const out: Printed = { status, widths: "1280, 390", statements: r.statements };
  if (r.errors.length) out.errors = r.errors.map((e) => ({ statement: e.statement || "(page)", message: e.error }));
  if (r.overflow.length) {
    out.scrolls_sideways = r.overflow.map((o) => ({ width: o.width, statements: o.statements.length ? o.statements.join(", ") : "(not one statement)" }));
  }
  if (r.notices.length) out.notices = r.notices;
  return out;
}

async function cmdPatch(file: string | undefined): Promise<void> {
  const abs = needFile(file, "patch");
  if (!abs || file === undefined) return; // needFile reported a missing file
  if (process.stdin.isTTY) return usage(`pipe the changed statements on stdin: ${BIN} patch ${quote(file)} <<'EOF' ... EOF`, "patch");
  const patch = await readStdin();
  if (!patch.trim()) return fail("stdin was empty");
  const html = fs.readFileSync(abs, "utf8");
  const art = readArtifact(html);
  if (art.program == null) return fail('no <script type="text/openui"> block to patch');
  const merged = mergeStatements(art.program.trim(), patch.trim(), "root");
  // mergeStatements garbage-collects statements unreachable from root; report patched ones it dropped (`x = null` deletes are intended).
  const kept = new Set(splitStatements(merged).map((s) => s.id));
  const patched = new Set(splitStatements(patch).filter((s) => !/=\s*null\s*;?$/.test(s.text)).map((s) => s.id));
  const dropped = [...patched].filter((id) => !kept.has(id));
  const next = replaceProgram(html, merged);
  fs.writeFileSync(abs, next);
  const result = checkHtml(next, { file: quote(file) });
  await registerWithHub(abs, result.title, sessionId(abs));
  const out: Printed = { status: "patched", file: abs };
  if (dropped.length) Object.assign(out, { dropped, warning: `unreferenced statement(s) dropped: ${dropped.join(", ")} (reference them from a parent to keep them on the page)` });
  print({ ...out, check: compactCheck(result) });
}

/** A pack's part of the reference: its signatures and notes, as `spec` prints core groups. */
function packSpec(p: InstalledPack): string {
  const lines = [`### ${p.name}@${p.version}${isThirdParty(p.name, p) ? " (third-party)" : ""}`];
  lines.push(`A page using these must declare the pack: run \`${BIN} check --fix <file>\` after writing it. Examples: \`${BIN} components show <Name>\`.`);
  for (const c of p.catalog.components) lines.push(`${c.signature}${c.description ? ` — ${c.description}` : ""}`);
  for (const g of p.catalog.groups || []) lines.push(...(g.notes || []));
  return lines.join("\n") + "\n";
}

function cmdSpec(groups: string[]): boolean | void {
  let text = fs.readFileSync(assetPath("prompt.md"), "utf8");
  const packs = installedPacks();
  const packArgs = groups.filter((g) => packs.some((p) => p.name === g));
  if (packArgs.length) {
    // packArgs holds only names of installed packs, so every find succeeds.
    return process.stdout.write(packArgs.map((g) => packSpec(packs.find((p) => p.name === g) as InstalledPack)).join("\n"));
  }
  if (!groups.length) {
    if (!text.endsWith("\n")) text += "\n";
    if (packs.length) {
      text += `\n## Installed packs\nMore components (\`${BIN} spec <pack>\` for signatures). A page using one must declare its pack: run \`${BIN} check --fix <file>\` after writing it.\n`;
      for (const p of packs) text += `- ${p.name}@${p.version}: ${p.catalog.components.map((c) => c.name).join(", ")}\n`;
    }
    return process.stdout.write(text);
  }
  const wanted = new Set(groups.map((g) => g.toLowerCase()));
  const parts = text.split(/\n(?=### )/);
  const head = parts[0].split("\n## Component Signatures")[0];
  const picked = parts.filter((p) => p.startsWith("### ") && wanted.has(p.slice(4, p.indexOf("\n")).trim().toLowerCase()));
  if (!picked.length) return usage(`unknown group; one of: Layout Content Data Charts Forms Buttons, or an installed pack`, "spec");
  const trimmed = picked.map((p) => p.split(/\n## /)[0]);
  process.stdout.write(`${head}\n\n## Component Signatures (subset)\n\n${trimmed.join("\n")}\n`);
}

function cmdExport(file: string | undefined, flags: Flags): void {
  const abs = needFile(file, "export");
  if (!abs) return;
  const out = typeof flags.out === "string" ? path.resolve(flags.out) : abs.replace(/\.html?$/i, "") + ".export.html";
  const { html, notices } = exportHtml(fs.readFileSync(abs, "utf8"), path.dirname(abs));
  fs.writeFileSync(out, html);
  print({ status: "exported", file: out, bytes: html.length, notices: notices.length ? notices : undefined });
}

function printResult(out: object): void {
  print(out as Printed);
  if (out && "status" in out && out.status === "error") process.exitCode = 1;
}

async function cmdComponents(sub: string | undefined, args: string[], flags: Flags): Promise<void> {
  switch (sub) {
    case undefined:
    case "list":
      return printResult(listComponents(args[0]));
    case "search":
      return printResult(await searchComponents(args));
    case "show":
      return printResult(await showComponents(args, typeof flags.pack === "string" ? flags.pack : undefined));
    case "add": {
      if (!args[0]) return usage(`add needs a pack: ${BIN} components add <npm-package>[@version] | <folder> | <file.tgz>`, "components");
      const { addPack } = await import("./install.ts");
      let r;
      try {
        r = await addPack(args[0], { trust: !!flags.trust });
      } catch (caught) {
        // addPack throws Errors, flagged with `code` or `network` where main says more.
        const err = caught as InstallError;
        const out: Printed = { status: err.code === "untrusted" ? "needs --trust" : "error", error: err.message };
        if (err.network) out.next = `Offline or behind a proxy? \`npm pack ${args[0]}\` downloads it; then \`${BIN} components add ./<file>.tgz\`.`;
        print(out);
        process.exitCode = 1;
        return;
      }
      return print({
        status: "added",
        pack: `${r.name}@${r.version}`,
        replaced: r.previous && r.previous !== r.version ? r.previous : undefined,
        trust: r.trust,
        components: r.components,
        warnings: r.warnings.length ? r.warnings : undefined,
        next: r.previous === r.version
          ? `Same version as before: run \`${BIN} check --fix <file>\` on pages that use it, to update their integrity hash.`
          : `\`${BIN} components show ${r.components[0]}\` for its signature. A page that uses it must declare it: \`${BIN} check --fix <file>\` adds the tag.`,
      });
    }
    case "remove": {
      if (!args[0]) return usage(`remove needs a pack name: ${BIN} components remove <name>`, "components");
      const { removePack } = await import("./install.ts");
      const r = removePack(args[0]);
      if (!r) return fail(`${args[0]} is not installed (${BIN} components list)`);
      return print({
        status: "removed",
        pack: `${r.name}@${r.version}`,
        note: "Pages that declare it lose its components under review and in `check`; opened directly, they still load it from the CDN.",
      });
    }
    case "new": {
      const { newPack } = await import("./pack-dev.ts");
      try {
        const r = newPack(args[0], { name: typeof flags.name === "string" ? flags.name : undefined });
        return print({
          status: "created",
          pack: r.name,
          dir: r.dir,
          files: r.files,
          next: `cd ${quote(path.relative(process.cwd(), r.dir) || ".")} && npm install && npm run build, then \`${BIN} components add .\``,
        });
      } catch (err) {
        return fail(messageOf(err));
      }
    }
    case "build": {
      const { buildPackDir } = await import("./pack-dev.ts");
      try {
        const r = await buildPackDir(args[0] || ".");
        return print({
          status: "built",
          pack: `${r.name}@${r.version}`,
          components: r.components,
          bytes: r.size,
          files: r.files,
          warnings: r.warnings.length ? r.warnings : undefined,
          next: `\`${BIN} components add ${quote(args[0] || ".")}\` to use it here (again after each build), then \`${BIN} check --fix <file>\` on pages that use it.`,
        });
      } catch (err) {
        return fail(messageOf(err));
      }
    }
    default: {
      // `components charts` reads as `components list charts`.
      const listed = listComponents(sub);
      if (listed.status !== "error") return print(listed as Printed);
      return usage(`unknown components command: ${sub}. One of: list search show add remove new build`, "components");
    }
  }
}

/** Ask the user at the terminal; only a yes counts. */
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function cmdTrust(sub: string | undefined, args: string[]): Promise<void> {
  // install.ts is loaded only by the commands that install, like `components add`.
  const { readRegistryPack } = await import("./install.ts");
  switch (sub) {
    case undefined:
    case "list": {
      const list = readTrustList();
      const pins = Object.entries(list.pins).map(([name, p]) => `${name}@${p.version} ${p.integrity}`);
      return print({
        file: trustFile(),
        pins: pins.length ? pins : "none",
        scopes: list.scopes.length ? list.scopes.map((s) => `${s.scope} on ${s.registry}`) : "none",
        note: "An agent may run `components add` on a pinned version (same pack.js), or on any pack in these scopes from the registry the scope was added from, without --trust. Only the user adds to this list.",
      });
    }
    case "add": {
      const target = args[0];
      if (!target) return usage(`add needs a pack or scope: ${BIN} trust add <npm-package>[@version] | @scope`, "trust");
      if (!process.stdin.isTTY) {
        return fail(`trust add needs the user at a terminal and changes nothing here. Ask the user to run \`${BIN} trust add ${target}\` themselves after reviewing it.`);
      }
      const list = readTrustList();
      const regs = readRegistries();
      if (isScope(target)) {
        const registry = registryFor(regs, target).url;
        if (list.scopes.some((s) => s.scope === target && s.registry === registry)) return print({ status: "already trusted", scope: target, registry });
        if (!(await confirm(`Let agents install any pack under ${target}/ from ${registry} without --trust? Its code runs inside your review pages.`))) {
          return print({ status: "not changed" });
        }
        updateTrustList((fresh) => {
          if (fresh.scopes.some((s) => s.scope === target && s.registry === registry)) return false;
          fresh.scopes.push({ scope: target, registry });
          return true;
        });
        return print({ status: "trusted", scope: target, registry, file: trustFile() });
      }
      let p;
      const registry = registryFor(regs, splitSpec(target).name);
      try {
        p = await readRegistryPack(target, registry);
      } catch (err) {
        return fail(messageOf(err));
      }
      const pin = { version: p.version, integrity: p.integrity };
      const previous = Object.hasOwn(list.pins, p.name) ? list.pins[p.name] : undefined;
      if (previous && previous.version === pin.version && previous.integrity === pin.integrity) return print({ status: "already pinned", pack: `${p.name}@${p.version}` });
      process.stderr.write(`${p.name}@${p.version}  ${p.integrity}\ncomponents: ${p.catalog.components.map((c) => c.name).join(", ")}\nsource: ${npmView(p.name, registry)}\n`);
      if (!(await confirm(`Pin ${p.name}@${p.version}? Agents could then install this exact version without --trust; its code runs inside your review pages.`))) {
        return print({ status: "not changed" });
      }
      let replaced: string | undefined;
      updateTrustList((fresh) => {
        const before = Object.hasOwn(fresh.pins, p.name) ? fresh.pins[p.name].version : undefined;
        replaced = before !== p.version ? before : undefined;
        fresh.pins[p.name] = pin;
        return true;
      });
      return print({
        status: "pinned",
        pack: `${p.name}@${p.version}`,
        integrity: p.integrity,
        replaced,
        file: trustFile(),
      });
    }
    case "remove": {
      const target = args[0];
      if (!target) return usage(`remove needs a pack or scope: ${BIN} trust remove <npm-package> | @scope`, "trust");
      const removed = updateTrustList((list) => {
        if (isScope(target) && list.scopes.some((s) => s.scope === target)) {
          list.scopes = list.scopes.filter((s) => s.scope !== target);
          return true;
        }
        if (!Object.hasOwn(list.pins, target)) return false;
        delete list.pins[target];
        return true;
      });
      if (!removed) return fail(`${target} is not on the trust list (${BIN} trust list)`);
      return print({ status: "removed", entry: target, note: "Packs already installed stay installed: `components remove` removes one." });
    }
    default:
      return usage(`unknown trust command: ${sub}. One of: list add remove`, "trust");
  }
}

async function cmdRegistry(sub: string | undefined, args: string[], flags: Flags): Promise<void> {
  switch (sub) {
    case undefined:
    case "list": {
      const regs = readRegistries();
      return print({
        file: registriesFile(),
        default: defaultRegistry().url,
        scopes: regs.size ? [...regs.values()].map((r) => `${r.scope} ${r.url}${r.tokenEnv ? ` (token from $${r.tokenEnv})` : ""}`) : "none",
        note: "Packs in a listed scope come from its registry for search, show and add; every other pack from the default one. A registry grants no trust: its packs are third-party unless on the trust list.",
      });
    }
    case "add": {
      const [scope, url] = args;
      if (!scope || !url) return usage(`add needs a scope and a registry URL: ${BIN} registry add @scope <url> [--token-env NAME]`, "registry");
      const tokenEnv = typeof flags["token-env"] === "string" ? flags["token-env"] : undefined;
      let entry;
      try {
        entry = registryEntry(scope, url, tokenEnv);
      } catch (err) {
        return usage(messageOf(err), "registry");
      }
      // A mapping decides which host gets the token in --token-env, so only the user at a terminal may make one, as with trust add.
      if (!process.stdin.isTTY) {
        return fail(`registry add needs the user at a terminal and changes nothing here. Ask the user to run \`${BIN} registry add ${scope} <url>\` themselves.`);
      }
      const regs = readRegistries();
      const previous = regs.get(scope);
      regs.set(scope, entry);
      writeRegistries(regs);
      return print({
        status: "added",
        scope,
        registry: entry.url,
        replaced: previous && previous.url !== entry.url ? previous.url : undefined,
        token: entry.tokenEnv ? `$${entry.tokenEnv}${process.env[entry.tokenEnv] ? "" : " (not set in this shell)"}` : undefined,
        file: registriesFile(),
        note: `Packs under ${scope}/ now come from this registry. They stay third-party until the user trusts them: \`${BIN} trust add ${scope}\` at a terminal.`,
      });
    }
    case "remove": {
      const scope = args[0];
      if (!scope) return usage(`remove needs a scope: ${BIN} registry remove @scope`, "registry");
      const regs = readRegistries();
      if (!regs.delete(scope)) return fail(`${scope} is not mapped to a registry (${BIN} registry list)`);
      writeRegistries(regs);
      return print({ status: "removed", scope, note: `Packs under ${scope}/ come from the default registry again (${defaultRegistry().url}).` });
    }
    default:
      return usage(`unknown registry command: ${sub}. One of: list add remove`, "registry");
  }
}

// ── feedback (any later session) ──

function shortDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One page's notes as `feedback` prints them: each with when it was sent, and its status under --all. */
function feedbackItems(abs: string, entries: FeedbackEntry[], all: boolean): Printed[] {
  const items: Printed[] = [];
  for (const e of entries) {
    for (const it of describeItems(abs, (e.items || []).map((x) => (e.author ? { ...x, author: e.author, ...(e.remote ? { remote: true } : {}) } : x)))) {
      items.push(all ? { sent: shortDate(e.at), status: e.status, ...it } : { sent: shortDate(e.at), ...it });
    }
  }
  return items;
}

/** The newest batch was sent with Send & End and nothing has answered it yet. */
function endsWithFinal(entries: FeedbackEntry[]): boolean {
  const last = entries[entries.length - 1];
  return Boolean(last?.end) && last.status !== "addressed";
}

async function cmdFeedback(file: string | undefined, flags: Flags): Promise<void> {
  if (file === undefined) return cmdProjectFeedback(flags);
  if (typeof flags.project === "string") return usage("feedback takes a file or --project, not both", "feedback");
  const abs = needFile(file, "feedback");
  if (!abs) return; // needFile reported a missing file
  const opts = { all: !!flags.all, peek: !!flags.peek };
  let entries: FeedbackEntry[] | null = null;
  let archived = false;
  // A published file's hosted notes come in through the server: start it so it can catch up.
  if (cloud.readCloud().pages[abs]) await ensureServer();
  if (await serverIfRunning()) {
    const r = await request<FeedbackResponse>("POST", "/api/feedback", { file: abs, ...opts }, { timeoutMs: 15_000 });
    if (r.status === 200) {
      entries = r.data.entries;
      archived = r.data.session.archived;
    } else if (r.status !== 404) return fail(r.data?.error || `feedback failed (${r.status})`);
  } else {
    // No server: read hub.db directly, holding the state dir's lock so a server cannot start on it meanwhile.
    const release = await lockStateDir(stateDir(), { wait: 5000 });
    try {
      const store = await SessionStore.open(stateDir());
      try {
        const s = store.byFile(abs);
        if (s) {
          ({ entries } = store.feedback(s, opts));
          archived = Boolean(s.archivedAt);
        }
      } finally {
        store.close();
      }
    } finally {
      release();
    }
  }
  if (!entries) {
    return print({ status: "none", file: abs, note: "This file has never been reviewed." });
  }
  if (!entries.length) {
    return print({ status: "none", file: abs, archived: archived || undefined, note: "Every piece of feedback on it has been answered." });
  }
  const f = quote(file);
  const final = endsWithFinal(entries);
  print({
    status: "feedback",
    file: abs,
    archived: archived || undefined,
    final: final || undefined,
    items: feedbackItems(abs, entries, opts.all),
    next:
      `Apply what still applies with \`${BIN} patch ${f}\` (changed statements only; names are stable), then \`${BIN} reply ${f} --agent-reply "<what changed>"\`, ` +
      `which marks it addressed. ` +
      (final ? `The reviewer pressed Send & End on the newest batch: continue in chat, do not poll afterwards.` : `To continue live with the reviewer: ${archived ? `\`${BIN} unarchive ${f}\` (the page is archived, so it takes no notes), then ` : ""}\`${BIN} ${f}\`, then poll.`),
  });
}

/** `feedback` with no file: the notes no agent has answered on every page of the project. */
async function cmdProjectFeedback(flags: Flags): Promise<void> {
  const project = await projectOfFlags(flags);
  if (!project) return;
  const opts = { all: !!flags.all, peek: !!flags.peek };
  let batches: ProjectFeedbackResponse["batches"] = [];
  // Hosted notes come in through the server: start it when a page of the project is published.
  const published = cloud.readCloud().pages;
  if (project.files.some((f) => published[f])) await ensureServer();
  if (await serverIfRunning()) {
    const r = await request<ProjectFeedbackResponse>("POST", "/api/feedback", { project: project.id, ...opts }, { timeoutMs: 15_000 });
    if (r.status !== 200) return fail(r.data?.error || `feedback failed (${r.status})`);
    batches = r.data.batches;
  } else {
    const release = await lockStateDir(stateDir(), { wait: 5000 });
    try {
      const store = await SessionStore.open(stateDir());
      try {
        const roots = new Hub(store.db);
        for (const s of store.inProject(project.id)) {
          const { entries } = store.feedback(s, opts);
          const root = roots.artifact(s.id)?.root;
          if (entries.length) batches.push({ file: s.file, copy: root ? copyLabel(root) : path.basename(path.dirname(s.file)), archived: Boolean(s.archivedAt), entries });
        }
      } finally {
        store.close();
      }
    } finally {
      release();
    }
  }
  if (!batches.length) return print({ status: "none", project: project.name, note: "Every piece of feedback in this project has been answered." });
  const final = batches.every((b) => endsWithFinal(b.entries));
  print({
    status: "feedback",
    project: project.name,
    batches: batches.map((b) => ({ file: b.file, copy: b.copy, archived: b.archived || undefined, final: endsWithFinal(b.entries) || undefined, items: feedbackItems(b.file, b.entries, opts.all) })),
    next:
      `For each page above: apply what still applies with \`${BIN} patch <file>\` (changed statements only), then \`${BIN} reply <file> --agent-reply "<what changed>"\`, which marks it addressed. ` +
      (final ? `The reviewer pressed Send & End on every newest batch: continue in chat, do not poll afterwards.` : `To continue live with the reviewer: \`${BIN} poll${project.scope}\`.`),
  });
}

// ── hub ──

/**
 * Run `fn` on hub.db without the server: a database that cannot be opened, or an error `fn` throws,
 * fails the command. `write`: `fn` changes it, which a state dir another version holds refuses.
 */
async function withHub(write: boolean, fn: (hub: Hub) => void): Promise<void> {
  let hub: Hub;
  try {
    hub = await openHubDirect({ write });
  } catch (err) {
    return fail(`${hubDbFile()} cannot be opened: ${messageOf(err)}`);
  }
  try {
    fn(hub);
  } catch (err) {
    fail(messageOf(err));
  } finally {
    hub.close();
  }
}

/** `--project <name|id|folder>` as a project id ("" when absent); throws when it names none. */
function projectFlag(hub: Hub, flags: Flags): string {
  if (typeof flags.project !== "string") return "";
  const p = findProject(hub.db, flags.project);
  if (!p) throw new Error(`no project ${flags.project} (a project name, id, or a folder inside one of its roots; \`${BIN} project list\` shows them)`);
  return p.id;
}

function feedbackText(c: HubCounts): string | undefined {
  const waiting = unanswered(c);
  return [waiting ? `${waiting} unanswered` : "", c.addressed ? `${c.addressed} answered` : ""].filter(Boolean).join(", ") || undefined;
}

const HUB_LIMIT = 40;

/** `--limit n` of `hub list` and `hub notes`: a positive whole number, else the default; null (after a usage error) when the value is bad. */
function limitFlag(flags: Flags): number | null {
  if (flags.limit === undefined) return HUB_LIMIT;
  const n = typeof flags.limit === "string" && /^\d+$/.test(flags.limit) ? Number(flags.limit) : 0;
  if (n < 1) {
    usage(`--limit takes a whole number of 1 or more, not ${JSON.stringify(flags.limit)}`, "hub");
    return null;
  }
  return n;
}

/** The first `limit` of `all`, and the line that says how many were left out ("40 of 45 shown; --limit n for more"). */
function limited<T>(all: T[], limit: number, what: string): { shown: T[]; shownNote?: string } {
  return all.length > limit ? { shown: all.slice(0, limit), shownNote: `${limit} of ${all.length} ${what} shown; \`--limit n\` shows more` } : { shown: all };
}

/** AUSTERE_AXI_NO_OPEN=1: this machine has no screen, so never start a browser. */
function browserDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.AUSTERE_AXI_NO_OPEN || "");
}

async function cmdHub(sub: string | undefined, args: string[], flags: Flags): Promise<void> {
  const url = `http://127.0.0.1:${port()}/`;
  switch (sub) {
    case "on":
    case "off":
    case "status":
      print({ error: `the hub is always on; open it with \`${BIN} hub open\`` });
      process.exitCode = 2;
      return;
    case undefined:
    case "list": {
      const limit = limitFlag(flags);
      if (limit === null) return;
      return withHub(false, (hub) => {
        const found: HubPage[] = hub.list({ q: args.join(" "), project: projectFlag(hub, flags), archived: !!flags.archived, all: !!flags.all, limit: Infinity });
        const { shown: pages, shownNote } = limited(found, limit, "pages");
        if (!pages.length) return print({ pages: "none", note: flags.all || flags.archived ? undefined : "pages only checked (never opened for review) and archived ones are left out: --all lists them" });
        print({
          pages: pages.map((p) => ({
            title: p.title || undefined,
            project: p.project,
            page: p.rel_path,
            updated: shortDate(p.updated_at),
            feedback: feedbackText(p),
            copies: p.copies.map((c) => ({
              label: c.label,
              file: c.file,
              state: [c.reviewed ? "" : "checked", c.missing ? "missing" : "", c.archived_at ? "archived" : ""].filter(Boolean).join(", ") || undefined,
              feedback: p.copies.length > 1 ? feedbackText(c) : undefined,
            })),
          })),
          shown: shownNote,
          next: `\`${BIN} feedback <file>\` for what a reviewer said that no agent has answered.`,
        });
      });
    }
    case "notes": {
      const limit = limitFlag(flags);
      if (limit === null) return;
      return withHub(false, (hub) => {
        const found: HubNoteRow[] = hub.notes({ q: args.join(" "), project: projectFlag(hub, flags), status: flags.unanswered ? "unanswered" : "", limit: -1 });
        const { shown: rows, shownNote } = limited(found, limit, "notes");
        if (!rows.length) return print({ notes: "none" });
        print({
          notes: rows.map((r) => ({
            from: r.author || undefined,
            text: r.text || undefined,
            target: r.target || undefined,
            status: r.status === "addressed" ? "answered" : r.status === "held" ? "held" : "unanswered",
            page: r.title || path.basename(r.file),
            project: r.project,
            copy: r.label || undefined,
            file: r.file,
            sent: shortDate(r.at),
          })),
          shown: shownNote,
          next: `\`${BIN} feedback <file>\` for what a reviewer said that no agent has answered.`,
        });
      });
    }
    case "open": {
      await ensureServer();
      const noOpen = browserDisabled();
      const opened = !noOpen && (await openBrowser(url));
      return print({ status: opened ? "opened" : "open the url", url, note: noOpen ? "AUSTERE_AXI_NO_OPEN is set: no browser was started" : undefined, sign_in: opened ? undefined : signInHint() });
    }
    default:
      return usage(`unknown hub command: ${sub}. One of: list notes open`, "hub");
  }
}

// ── projects ──

async function cmdProject(sub: string | undefined, args: string[], flags: Flags): Promise<void> {
  const need = (n: number, what: string): boolean => {
    if (args.length >= n) return true;
    usage(`${sub} needs ${what}`, "project");
    return false;
  };
  switch (sub) {
    case undefined:
    case "list":
      return withHub(false, (hub) => {
        const projects = listProjects(hub.db);
        if (!projects.length) return print({ projects: "none", note: "A page you check or open for review files itself under a project." });
        print({ projects: projects.map((p) => ({ name: p.name, id: p.id, pages: p.pages, roots: p.roots.map((r) => `${r.root} (${r.kind})`) })) });
      });
    case "add":
      if (!need(1, `a folder: ${BIN} project add <dir> [--name n]`)) return;
      return withHub(true, (hub) => {
        const r = addRoot(hub.db, args[0], typeof flags.name === "string" ? flags.name : undefined);
        print({ status: "added", project: r.project.name, id: r.project.id, root: r.root });
      });
    case "merge":
      if (!need(2, `two projects: ${BIN} project merge <a> <b>`)) return;
      return withHub(true, (hub) => {
        const p = mergeProjects(hub.db, args[0], args[1]);
        print({ status: "merged", project: p.name, id: p.id, roots: listProjects(hub.db).find((x) => x.id === p.id)?.roots.map((r) => r.root) });
      });
    case "rename":
      if (!need(2, `a project and a name: ${BIN} project rename <p> <name>`)) return;
      return withHub(true, (hub) => {
        const p = renameProject(hub.db, args[0], args.slice(1).join(" "));
        print({ status: "renamed", project: p.name, id: p.id });
      });
    case "forget-root":
      if (!need(1, `a folder: ${BIN} project forget-root <dir>`)) return;
      return withHub(true, (hub) => {
        const r = forgetRoot(hub.db, args[0]);
        print({ status: "forgotten", root: r.root, project: r.project });
      });
    default:
      return usage(`unknown project command: ${sub}. One of: list add merge rename forget-root`, "project");
  }
}

/**
 * `archive` and `unarchive`: put a page away from the hub's lists and lock its composer, or bring it back.
 * Works on a file that is gone too. A running server holds the page in memory, so it makes the change.
 */
async function cmdArchive(file: string | undefined, archive: boolean): Promise<void> {
  const cmd = archive ? "archive" : "unarchive";
  if (!file) return usage(`${cmd} needs a file: ${BIN} ${cmd} <file.html>`, cmd);
  const abs = canonicalFile(file);
  const done = () => print({ status: archive ? "archived" : "unarchived", file: abs, note: archive ? `Notes are refused until \`${BIN} unarchive ${quote(file)}\`.` : undefined });
  if (await serverIfRunning()) {
    const r = await request("POST", `/api/${cmd}`, { file: abs }, { timeoutMs: 10_000 });
    if (r.status === 404) {
      // An older server answers "unknown route": it predates this CLI and must be restarted to know archive.
      if (/unknown route/.test(String(r.data?.error))) return fail(`the running server is older than this CLI and does not know ${cmd}: run \`${BIN} stop\`, then ${cmd} again`);
      return fail(`not in the hub: ${abs}`);
    }
    if (r.status !== 200) return fail(r.data?.error || `${cmd} failed (${r.status})`);
    return done();
  }
  // No server: hold the state dir's lock so hub.db is not written while a server runs or starts on it.
  const release = await lockStateDir(stateDir(), { wait: 5000 });
  try {
    await withHub(true, (hub) => {
      if (!hub.setArchived(sessionId(abs), archive ? Date.now() : null)) return fail(`not in the hub: ${abs}`);
      done();
    });
  } finally {
    release();
  }
}

// ── share (team review) ──

function ago(ms: number): string {
  return shortDate(ms);
}

async function cmdShare(args: string[], flags: Flags): Promise<void> {
  const [sub, ...more] = args;
  if (sub === "list") {
    let invites: InviteSummary[];
    const withLinks = Boolean(flags.links);
    if (await serverIfRunning()) {
      const r = await request<ShareListResponse>("GET", `/api/share/list${withLinks ? "?links=1" : ""}`);
      if (r.status !== 200) return fail(r.data?.error || `share list failed (${r.status})`);
      invites = r.data.invites;
    } else {
      invites = new InviteStore(stateDir()).list().map((i) => ({ id: inviteId(i), name: i.name, file: i.file, auto: i.auto, createdAt: i.createdAt }));
    }
    if (!invites.length) return print({ invites: "none", next: `${BIN} share <file> --as "<name>"` });
    return print({
      invites: invites.map((i) => ({
        name: i.name,
        id: i.id,
        file: i.file,
        mode: i.auto ? "auto" : "hold",
        created: ago(i.createdAt),
        link: i.link,
      })),
      next: withLinks ? undefined : `--links shows the links. ${BIN} share revoke <name|id> cuts one off.`,
    });
  }
  if (sub === "revoke") {
    const key = more.join(" ");
    if (!key) return usage(`revoke needs a name or id: ${BIN} share revoke <name|id> (see ${BIN} share list)`, "share");
    let revoked: RevokeResponse["revoked"];
    if (await serverIfRunning()) {
      const r = await request<RevokeResponse>("POST", "/api/share/revoke", { key });
      if (r.status !== 200) return fail(r.data?.error || `revoke failed (${r.status})`);
      revoked = r.data.revoked;
    } else {
      revoked = new InviteStore(stateDir()).revoke(key).map((i) => ({ id: inviteId(i), name: i.name, file: i.file }));
      if (!revoked.length) return fail("no invite matches that name or id");
    }
    return print({ status: "revoked", invites: revoked.map((i) => `${i.name} (${i.id})`), note: "Their link and open pages stop working at once." });
  }
  // share <file> --as "<name>"
  const abs = needFile(sub, "share");
  if (!abs) return;
  if (typeof flags.as !== "string" || !flags.as.trim()) return usage(`share needs a reviewer name: ${BIN} share ${quote(sub)} --as "<name>"`, "share");
  await ensureServer();
  const r = await request<ShareResponse>("POST", "/api/share", { file: abs, name: flags.as, auto: !!flags.auto });
  if (r.status !== 200) return fail(r.data?.error || `share failed (${r.status})`);
  const d = r.data;
  print({
    status: "shared",
    reviewer: d.name,
    file: abs,
    mode: d.auto ? "auto: their notes go straight to the agent" : "hold: their notes wait until the owner sends them on",
    link: d.link,
    note: "Anyone with this link on your tailnet can post notes under this name until you revoke it.",
    next: `${BIN} share revoke ${JSON.stringify(d.name)} cuts it off.`,
  });
}

// ── publish (hosted share links) ──

/** `publish`: the one command that talks to the hosted service. */
async function cmdPublish(args: string[], flags: Flags): Promise<void> {
  const [sub, ...more] = args;
  try {
    if (sub === "list") {
      const pages = await cloud.listPages();
      if (!pages.length) return print({ pages: "none", next: `${BIN} publish <file>` });
      return print({
        pages: pages.map((p) => ({ id: p.id, title: p.title, file: p.file, url: p.url, expires: shortDate(p.expiresAt), notes: p.notes })),
        next: `${BIN} publish rm <file|id> deletes one now.`,
      });
    }
    if (sub === "rm") {
      const key = more.join(" ");
      if (!key) return usage(`rm needs a file or page id: ${BIN} publish rm <file|id> (see ${BIN} publish list)`, "publish");
      const asFile = canonicalFile(key);
      const r = await cloud.removePage(cloud.readCloud().pages[asFile] ? asFile : key);
      return print({ status: "removed", id: r.id, file: r.file, note: r.gone ? "It was already gone from the service (expired or deleted)." : "The link stops working at once." });
    }
    if (sub === "invites" || sub === "revoke") {
      const [file, ...name] = more;
      if (!file) return usage(`${sub} needs a file: ${BIN} publish ${sub} <file>${sub === "revoke" ? " <name>" : ""}`, "publish");
      // The saved page entry is enough: the source may have been moved or deleted since it was published.
      const abs = canonicalFile(file);
      if (sub === "revoke") {
        if (!name.length) return usage(`revoke needs an invite name: ${BIN} publish revoke <file> <name> (see ${BIN} publish invites <file>)`, "publish");
        const r = await cloud.revokeInvite(abs, name.join(" "));
        return print({ status: "revoked", invite: r.name, id: r.id, note: "That link stops working now, and any page open with it is disconnected." });
      }
      const r = await cloud.listInvites(abs);
      // A publish sets auto, unlisted and presence every time: the suggested commands repeat the page's current ones.
      const again = `${BIN} publish ${quote(file)}${r.auto ? " --auto" : ""}${r.unlisted ? " --unlisted" : ""}${r.presence ? "" : " --no-presence"}`;
      return print({
        id: r.id,
        access: r.unlisted ? "unlisted (anyone with the page URL) and invites" : "invite-only",
        invites: r.invites.length
          ? r.invites.map((i) => ({
              name: i.name,
              status: i.status,
              link: i.link,
              expires: i.expiresAt === null ? undefined : shortDate(i.expiresAt),
              note: i.replaced ? `granted again from another machine, which has the link; ${again} --invite ${quote(i.name)} makes this machine's link the live one again (the other machine's stops)` : undefined,
            }))
          : "none",
        next: `${again} --invite <name> adds one; ${BIN} publish revoke ${quote(file)} <name> revokes one.`,
      });
    }
    const abs = needFile(sub, "publish");
    if (!abs || !sub) return;
    const r = await cloud.publish(abs, {
      auto: !!flags.auto,
      fresh: !!flags.new,
      unlisted: !!flags.unlisted,
      presence: !flags["no-presence"],
      invite: flags.invite,
      expiresAt: typeof flags.expires === "string" ? cloud.expiryOf(flags.expires) : undefined,
    });
    // Unknown (the rows did not arrive) is not "nobody": warn only when the service showed no live invite.
    const nobody = !r.unlisted && !r.invites.length && r.otherInvites === 0;
    const again = `${BIN} publish ${quote(sub)}${r.auto ? " --auto" : ""}${r.unlisted ? " --unlisted" : ""}${r.presence ? "" : " --no-presence"}`;
    print({
      status: r.updated ? "updated" : "published",
      file: abs,
      id: r.id,
      url: r.unlisted ? r.url : undefined,
      access: r.unlisted ? "unlisted: anyone with the url may review" : "invite-only",
      invites: r.invites.length ? r.invites.map((i) => ({ name: i.name, link: i.link, expires: i.expiresAt === null ? undefined : shortDate(i.expiresAt) })) : undefined,
      mode: r.auto ? "auto" : "hold",
      presence: r.presence ? undefined : "off",
      expires: r.expiresAt === null ? undefined : shortDate(r.expiresAt),
      packs: r.packs || undefined,
      images: r.images || undefined,
      note: `${nobody ? "Nobody can open this page yet: add --invite <name>, or --unlisted for an open link. " : ""}Send each reviewer only their own link. Reviewers' notes reach poll and feedback marked remote: true${r.auto ? "" : ", held until the owner sends them on in the review page"}. The page expires 30 days after the last publish.`,
      next: `${again} again updates this link (earlier invites keep working); ${BIN} publish invites ${quote(sub)} lists invites; ${BIN} publish revoke ${quote(sub)} <name> revokes one; ${BIN} publish rm ${quote(sub)} deletes the page.`,
    });
  } catch (caught) {
    const err = caught as { message: string; status?: number; code?: string };
    fail(err.message, { http: err.status, code: err.code });
  }
}

async function cmdStop(): Promise<void> {
  // A server from before the health proof is stopped too (without the key).
  const h = await serverIfRunning({ legacy: true });
  if (!h) return print({ status: "not running" });
  await shutdownServer(h);
  print({
    status: "stopped",
    port: port(),
    note: h.supervised ? `It runs under ${h.supervised}; the next command that needs a server starts the service again. \`${BIN} server uninstall\` takes the service away for good.` : undefined,
  });
}

/** The hint for a browser the CLI did not open: the plain url answers 403 until that browser signs in. */
function signInHint(file?: string): string {
  return `A browser that is not signed in gets 403 at the url: run \`${BIN} login${file ? ` ${quote(file)}` : ""}\` and open the single-use link it prints.`;
}

async function cmdLogin(file: string | undefined): Promise<void> {
  let url = `http://127.0.0.1:${port()}/`;
  let abs: string | null = null;
  if (file) {
    abs = needFile(file, "login");
    if (!abs) return;
  }
  await ensureServer();
  if (abs && file) {
    const r = await request<SessionsResponse>("GET", "/api/sessions");
    if (r.status !== 200) return fail(r.data?.error || `login failed (${r.status})`);
    const s = (r.data.sessions || []).find((x) => x.file === abs);
    if (!s) return fail(`no review for ${abs} yet: \`${BIN} ${quote(file)} --no-open\` starts one`);
    url = s.links.local;
  }
  const link = await loginUrl(url);
  print({
    url: link.url,
    expires: `after one use, or in ${Math.round(link.ttlMs / 1000)}s`,
    note: "Open it in the browser to sign that browser in as you; then every page's plain url works there. Do not forward it.",
  });
}

async function cmdServer(sub: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const p = flags.port ? Number(flags.port) : undefined;
  if (p !== undefined && !(Number.isInteger(p) && p > 0 && p < 65536)) return usage(`--port must be a port number: ${flags.port}`, "server");
  if (sub === undefined) {
    if (flags["link-url"] !== undefined) return usage("--link-url is for `server install`; a foreground server reads AUSTERE_AXI_LINK_URL", "server");
    // A foreground server and an installed service want the same port and the same state
    // dir: the service would restart in a loop while this one holds them.
    const installed = installedServiceFor(serviceContext(probePort), stateDir(), p ?? port());
    if (installed) {
      process.stderr.write(`a service for this state dir is installed (${installed.file}); it will keep restarting while this server holds the port. Stop it with \`${BIN} server uninstall\`, or run this server on another port.\n`);
    }
    const { runServer } = await import("./server.ts");
    return void (await runServer({ port: p ?? port(), verbose: !!flags.verbose, alsoListen: flags["also-listen"] || [], persist: !!flags.persist }));
  }
  if (!["install", "uninstall", "status"].includes(sub)) return usage(`unknown server subcommand: ${sub}. One of: install uninstall status`, "server");
  if (rest.length > 1) return usage(`server ${sub} takes no arguments; it got ${rest.slice(1).map((a) => `"${a}"`).join(" ")}`, "server");
  const extra = Object.keys(flags).filter((k) => !(sub === "install" ? ["port", "link-url"] : sub === "status" ? ["port"] : []).includes(k));
  if (extra.length) return usage(`server ${sub} does not take ${extra.map((k) => `--${k}`).join(" ")}`, "server");
  const ctx = serviceContext(probePort);
  try {
    if (sub === "install") {
      const linkUrl = typeof flags["link-url"] === "string" ? flags["link-url"] : undefined;
      return print(await installService({ port: p, linkUrl }, ctx));
    }
    if (sub === "uninstall") return print(uninstallService(ctx));
    const h = await health(p ?? port());
    const running = h && !h.foreign && !h.legacy ? h : null;
    // A server from before 0.12 does not say a unit runs it; the system does.
    const unit = running ? serverUnit(running.pid) : null;
    return print(serviceStatus(ctx, running && { ...running, supervised: running.supervised ?? unit?.supervisor, unit: unit?.unit }, VERSION));
  } catch (err) {
    return fail(messageOf(err));
  }
}

/** The oldest Node this CLI supports: node:sqlite, and type stripping for development. Keep in step with `engines`. */
const MIN_NODE = [22, 18];

async function main(): Promise<unknown> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    return fail(`austere-axi needs Node ${MIN_NODE.join(".")} or newer; this is ${process.versions.node}. Install a current Node LTS.`);
  }
  const { flags, pos, error } = parseArgs(process.argv.slice(2));
  if (flags.version) return process.stdout.write(VERSION + "\n");
  const [cmd, ...rest] = pos;
  if (cmd !== undefined && Object.hasOwn(REMOVED_COMMANDS, cmd)) return removed(`${BIN} ${cmd}`, REMOVED_COMMANDS[cmd]);
  const gone = Object.keys(flags).find((k) => Object.hasOwn(REMOVED_FLAGS, k));
  if (gone) return removed(`--${gone}`, REMOVED_FLAGS[gone]);
  // Which COMMANDS entry this is: none for the home view, "open" for a bare file.
  let name: string | null = null;
  if (cmd !== undefined) {
    if (Object.hasOwn(COMMANDS, cmd)) name = cmd;
    else if (/\.html?$/i.test(cmd) || fs.existsSync(cmd)) name = "open";
    else if (flags.help) return process.stdout.write(HELP);
    else return usage(`unknown command: ${cmd}. One of: ${Object.keys(COMMANDS).join(" ")}, or a page file`);
  }
  if (flags.help) return name && name !== "help" ? commandHelp(name) : process.stdout.write(HELP);
  if (error) return usage(error, name);
  const allowed = name ? Object.keys(COMMANDS[name].flags) : [];
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    const valid = allowed.length ? `valid: ${allowed.map((k) => `--${k}`).join(" ")}` : "it takes no flags";
    return usage(`unknown flag${unknown.length > 1 ? "s" : ""} for ${name ?? BIN}: ${unknown.map((k) => `--${k}`).join(" ")}; ${valid}`, name);
  }
  const dev = applyDevDefaults();
  if (dev) process.stderr.write(`[${BIN}] ${dev}\n`);
  stateDir();
  switch (cmd) {
    case undefined:
      return cmdHome();
    case "poll":
      return cmdPoll(rest[0], flags);
    case "reply":
      return cmdReply(rest[0], flags);
    case "login":
      return cmdLogin(rest[0]);
    case "check":
      return cmdCheck(rest[0], flags);
    case "components":
      return cmdComponents(rest[0], rest.slice(1), flags);
    case "trust":
      return cmdTrust(rest[0], rest.slice(1));
    case "registry":
      return cmdRegistry(rest[0], rest.slice(1), flags);
    case "feedback":
      return cmdFeedback(rest[0], flags);
    case "hub":
      return cmdHub(rest[0], rest.slice(1), flags);
    case "project":
      return cmdProject(rest[0], rest.slice(1), flags);
    case "archive":
      return cmdArchive(rest[0], true);
    case "unarchive":
      return cmdArchive(rest[0], false);
    case "patch":
      return cmdPatch(rest[0]);
    case "spec":
      return cmdSpec(rest);
    case "export":
      return cmdExport(rest[0], flags);
    case "share":
      return cmdShare(rest, flags);
    case "publish":
      return cmdPublish(rest, flags);
    case "stop":
      return cmdStop();
    case "server":
      return cmdServer(rest[0], rest, flags);
    case "mcp": {
      const { runMcp } = await import("./mcp.ts");
      return runMcp();
    }
    case "open":
      return cmdOpen(rest[0], flags);
    case "help":
      if (!rest[0]) return process.stdout.write(HELP);
      if (rest[0] === "all") return process.stdout.write(HELP + helpAll());
      if (!Object.hasOwn(COMMANDS, rest[0])) return usage(`no command named ${rest[0]}. One of: all ${Object.keys(COMMANDS).join(" ")}`, "help");
      return commandHelp(rest[0]);
    default:
      return cmdOpen(cmd, flags);
  }
}

main().catch((caught: unknown) => {
  // Whatever escaped: an Error's message, else the thrown value itself.
  const err = caught as { message?: unknown } | null | undefined;
  process.stdout.write(format({ status: "error", error: String(err?.message || caught) }) + "\n");
  process.exitCode = 1;
});
