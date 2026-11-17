// `austere-axi mcp`: an MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Each tool runs this same CLI as a child process, so the MCP surface returns
// exactly what the CLI prints and stdout stays reserved for the protocol.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { splitSpec, isValidPackName } from "../shared/packs-meta.ts";
import { looksLikePath } from "./install.ts";
import { CLI_ENTRY, VERSION } from "./paths.ts";

/** One CLI run: its arguments and what to pipe to its stdin. */
interface Run {
  args: string[];
  stdin?: string;
}

/** A tool argument's JSON schema. */
interface ArgSchema {
  type: "string" | "boolean" | "integer" | "array";
  description: string;
  enum?: string[];
  items?: { type: "string" };
  minimum?: number;
}

/** Tool arguments once `validate` has passed: every key is one the tool lists, with its type. */
type ToolArgs = {
  file: string;
  project?: string;
  groups?: string[];
  fix?: boolean;
  render?: boolean;
  no_open?: boolean;
  agent_reply?: string;
  cursor?: number;
  timeout_ms?: number;
  text: string;
  statements: string;
  command: string;
  args?: string[];
  pack?: string;
  session?: string;
  id: string;
};

interface Tool {
  title: string;
  description: string;
  readOnly?: boolean;
  /** Reaches the npm registry. */
  openWorld?: boolean;
  properties: Record<string, ArgSchema>;
  required?: string[];
  /** Why these arguments are refused before the CLI runs, or null. */
  reject?: (a: ToolArgs) => string | null;
  run: (a: ToolArgs) => Run[];
}

type RpcId = string | number | null;

/** A JSON-RPC request or notification, once it has a string method. */
type RpcRequest = {
  id?: RpcId;
  method: string;
  params?: { requestId?: RpcId; protocolVersion?: string; name?: unknown; arguments?: unknown };
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

// 2025-03-26 is left out: it requires JSON-RPC batches, which this server does not accept.
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2024-11-05"];

/** Many MCP clients give up on a tool call after about a minute, so poll returns `timeout` before that. */
const POLL_TIMEOUT_MS = 50_000;

const INSTRUCTIONS = `austere-axi turns plans, comparisons, decisions, code reviews and reports into review pages the user annotates in the browser. Call \`spec\` once per session for the workflow, the file skeleton and the component reference. Results are the CLI's output: where a \`next:\` hint names an \`austere-axi <command>\`, call the tool of that name instead. Pass absolute file paths. The reviewer judges how a page looks: do not open, screenshot or inspect it yourself unless the user asks. Revise a page only with the \`patch\` tool: send the changed statements (every statement that shows a changed value), never the whole file.`;

const file: ArgSchema = { type: "string", description: "Path of the .html page. Use an absolute path; a relative one resolves against the server's working directory." };

/** `--session`: for a client whose harness does not name its session in the environment. */
const session: ArgSchema = { type: "string", description: "Optional: the agent session you run in, as <harness>:<id> (omp, copilot, dsh), when your harness does not set PI_SESSION_ID, COPILOT_AGENT_SESSION_ID or DSH_SESSION_ID. Stays on this machine." };
const withSession = (a: ToolArgs): string[] => (typeof a.session === "string" ? ["--session", a.session] : []);

const TOOLS: Record<string, Tool> = {
  spec: {
    title: "Workflow and component reference",
    description: "The page workflow, the HTML file skeleton and the component reference. Call once per session before writing a page. With groups or pack names, returns only those signatures.",
    readOnly: true,
    properties: {
      groups: { type: "array", items: { type: "string" }, description: "Optional: Layout, Content, Data, Charts, Forms, Buttons, or an installed pack name." },
    },
    run: (a) => (a.groups?.length ? [{ args: ["spec", "--", ...a.groups] }] : [{ args: ["--help"] }, { args: ["spec"] }]),
  },
  check: {
    title: "Validate a page",
    description: "Validate the page's OpenUI Lang program without a browser: syntax, component names, required props, unresolved references, unreachable statements.",
    properties: {
      file,
      fix: { type: "boolean", description: "Write the <meta name=\"austere-packs\"> tag for the packs the page uses." },
      render: { type: "boolean", description: "Also render the page in headless Chrome and report render errors and sideways scrolling as text. Only when the user asks to verify the page." },
    },
    required: ["file"],
    run: (a) => [{ args: ["check", ...(a.fix ? ["--fix"] : []), ...(a.render ? ["--render"] : []), "--", a.file] }],
  },
  open: {
    title: "Validate and open the review",
    description: "Validate the page and open it for review in the browser. Returns the review url, then call `poll`.",
    properties: {
      file,
      no_open: { type: "boolean", description: "Do not launch a browser; give the user the printed url." },
      session,
    },
    required: ["file"],
    run: (a) => [{ args: ["open", ...(a.no_open ? ["--no-open"] : []), ...withSession(a), "--", a.file] }],
  },
  poll: {
    title: "Wait for feedback",
    description: `Wait for the reviewer's feedback. One poll covers every page of the project of the server's working folder (project: another one); each batch names its file. file: that page only. On status timeout, call poll again: nothing is lost. replaced: a newer poll took over, maybe your own: stop this one. archived (file poll): the owner archived the page, so it takes no notes: stop, and unarchive only if the user asks. final: true on a batch means that page is done (the reviewer pressed Done or Send & finish): apply it and reply, keep polling while another page you opened is still in review. Feedback comes back until acknowledged: reply for each page (or agent_reply on a file poll), then poll with the cursor it returned.`,
    properties: {
      file: { type: "string", description: "Path of the .html page to wait on. Leave out to wait on every page of the project. Use an absolute path." },
      project: { type: "string", description: "Without file: the project to wait on, a name, an id, or a folder inside one of its roots (default: the server's working folder)." },
      agent_reply: { type: "string", description: "File polls only. One line for the reviewer: what you changed. For a project poll use the reply tool on each page." },
      cursor: { type: "integer", minimum: 0, description: "The cursor the last poll returned: acknowledges that feedback, so it is not returned again. A reply acknowledges it too. On a project poll it acknowledges every page in the answer." },
      timeout_ms: { type: "integer", minimum: 0, description: `Return status timeout after this long (default ${POLL_TIMEOUT_MS}). 0 waits until feedback arrives; use it only if your client allows long tool calls.` },
      session,
    },
    reject: (a) => {
      if (typeof a.file === "string" && typeof a.project === "string") return "pass a file or a project, not both";
      if (typeof a.file !== "string" && typeof a.agent_reply === "string") return "a reply belongs to one page: use the reply tool for each page, then poll with the cursor";
      return null;
    },
    run: (a) => {
      const args = ["poll", "--timeout-ms", String(a.timeout_ms ?? POLL_TIMEOUT_MS), ...withSession(a)];
      if (Number.isInteger(a.cursor)) args.push("--cursor", String(a.cursor));
      // No file: the CLI resolves the project from --project, else from its working folder (this server's).
      if (typeof a.file !== "string") return [{ args: [...args, ...(typeof a.project === "string" ? ["--project", a.project] : [])] }];
      if (typeof a.agent_reply === "string") return [{ args: [...args, "--agent-reply-file", "-", "--", a.file], stdin: a.agent_reply }];
      return [{ args: [...args, "--", a.file] }];
    },
  },
  reply: {
    title: "Reply without polling",
    description: "Post a short reply to the reviewer without waiting for feedback; marks earlier feedback answered.",
    properties: {
      file,
      text: { type: "string", description: "A line or two; a small Markdown subset renders." },
      cursor: { type: "integer", minimum: 0, description: "The cursor the last poll returned; without it the reply acknowledges what that poll handed over." },
      session,
    },
    required: ["file", "text"],
    run: (a) => [{ args: ["reply", ...(Number.isInteger(a.cursor) ? ["--cursor", String(a.cursor)] : []), ...withSession(a), "--agent-reply-file", "-", "--", a.file], stdin: a.text }],
  },
  patch: {
    title: "Merge statements into a page",
    description: "Merge OpenUI Lang statements into the page's program: a statement with an existing name replaces it, a new name adds it, `name = null` deletes it. Returns the check result.",
    properties: { file, statements: { type: "string", description: "One or more `name = ...` statements." }, session },
    required: ["file", "statements"],
    run: (a) => [{ args: ["patch", ...withSession(a), "--", a.file], stdin: a.statements }],
  },
  components: {
    title: "Find and install components",
    description: "Components spec leaves out, and packs on npm. Third-party packs the user has not trusted are refused: ask the user to install them.",
    openWorld: true,
    properties: {
      command: { type: "string", enum: ["search", "show", "list", "add"], description: "search <words>, show <Name...>, list [group], add <npm-package>." },
      args: { type: "array", items: { type: "string" }, description: "The command's words, component names, group, or one npm package name[@version]." },
      pack: { type: "string", description: "show only: look the names up in this pack (core, or an npm package name) when two packs share a name." },
    },
    required: ["command"],
    reject: (a) => {
      if (a.pack !== undefined) {
        if (a.command !== "show") return "pack is only for show";
        if (a.pack !== "core" && !isValidPackName(a.pack)) return "pack must be core or an npm package name";
      }
      // An MCP client installs from the registry only: a folder or .tgz would run local files the user never vetted.
      if (a.command !== "add") return null;
      if (a.args?.length !== 1) return "add takes exactly one npm package name[@version] in args";
      if (looksLikePath(a.args[0]) || !isValidPackName(splitSpec(a.args[0]).name)) return "add takes an npm package name[@version]; folders and .tgz files are installed from the command line";
      return null;
    },
    run: (a) => [{ args: ["components", a.command, ...(a.pack !== undefined ? ["--pack", a.pack] : []), "--", ...(a.args ?? [])] }],
  },
  sessions_list: {
    title: "Agent sessions of a page",
    description:
      "The agent sessions that opened, patched, polled, replied to or read the feedback of a page: harness, short id, role (author, editor, listener), last seen, and whether the harness process still runs (alive, exited, unknown). Pass a file for one page, or a project (a name, an id or a folder) for every page of it.",
    readOnly: true,
    properties: {
      file: { type: "string", description: "Path of the .html page. Leave out to list a project. Use an absolute path." },
      project: { type: "string", description: "The project to list when no file is given: a name, an id, or a folder inside one of its roots." },
    },
    reject: (a) => {
      if (typeof a.file === "string" && typeof a.project === "string") return "pass a file or a project, not both";
      if (typeof a.file !== "string" && typeof a.project !== "string") return "pass a file, or a project to list all of its pages";
      return null;
    },
    run: (a) => [{ args: typeof a.project === "string" ? ["sessions", "list", "--project", a.project] : ["sessions", "list", "--", a.file] }],
  },
  run_list: {
    title: "Runs of the attached agent",
    description:
      "The runs the owner's attach setting started on a page (a note the owner sent or released starts the attached harness headless): status (queued, waiting_for_session, running, done, failed, stopped, interrupted), why it failed, harness and mode, the notes it was for. Pass a file for one page, or a project (a name, an id or a folder) for every page of it.",
    readOnly: true,
    properties: {
      file: { type: "string", description: "Path of the .html page. Leave out to list a project. Use an absolute path." },
      project: { type: "string", description: "The project to list when no file is given: a name, an id, or a folder inside one of its roots." },
    },
    reject: (a) => {
      if (typeof a.file === "string" && typeof a.project === "string") return "pass a file or a project, not both";
      if (typeof a.file !== "string" && typeof a.project !== "string") return "pass a file, or a project to list all of its pages";
      return null;
    },
    run: (a) => [{ args: typeof a.project === "string" ? ["run", "list", "--project", a.project] : ["run", "list", "--", a.file] }],
  },
  run_log: {
    title: "Log of one run",
    description: "What one run of the attached agent printed (its stdout and stderr, up to 1 MB, kept 30 days), with its status and reason. The id comes from run_list.",
    readOnly: true,
    properties: { id: { type: "string", description: "The run's id, as run_list shows it." } },
    required: ["id"],
    run: (a) => [{ args: ["run", "log", "--", a.id] }],
  },
  attach_status: {
    title: "Attach setting of a page",
    description:
      "Whether an agent is attached to a page (a note the owner sends or releases starts the page's harness headless) and what would stop a run: the setting that applies (the page's, else its project's, else off) and where it comes from, the mode, the session a run resumes, the harness, the model, the last run, and warnings such as a harness without the write grant. Read-only: only the user turns attach on or off, at a terminal or from the review page. Pass a file for one page, or a project (a name, an id or a folder) for its default.",
    readOnly: true,
    properties: {
      file: { type: "string", description: "Path of the .html page. Leave out to show a project's default. Use an absolute path." },
      project: { type: "string", description: "The project to show when no file is given: a name, an id, or a folder inside one of its roots." },
    },
    reject: (a) => {
      if (typeof a.file === "string" && typeof a.project === "string") return "pass a file or a project, not both";
      if (typeof a.file !== "string" && typeof a.project !== "string") return "pass a file, or a project to show its default";
      return null;
    },
    run: (a) => [{ args: typeof a.project === "string" ? ["attach", "status", "--project", a.project] : ["attach", "status", "--", a.file] }],
  },
};

/** Run the CLI once; resolves with what it printed and its exit code. */
function runCli({ args, stdin }: Run, signal: AbortSignal): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
    const kill = () => child.kill();
    signal.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => resolve({ code: 1, text: `status: error\nerror: ${err.message}\n` }));
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      resolve({ code: code ?? 1, text: Buffer.concat(out).toString("utf8") });
    });
  });
}

function validate(tool: Tool, a: Record<string, unknown>): string | null {
  for (const key of tool.required || []) {
    const v = a[key];
    if (typeof v !== "string" || !v.trim()) return `${key} is required`;
  }
  for (const [key, v] of Object.entries(a)) {
    const p = tool.properties[key];
    if (!p) return `unknown argument: ${key}`;
    const ok =
      p.type === "array" ? Array.isArray(v) && v.every((x) => typeof x === "string")
      : p.type === "integer" ? typeof v === "number" && Number.isInteger(v) && v >= 0
      : typeof v === p.type;
    if (!ok) return `${key} must be ${p.type === "integer" ? "a non-negative integer" : `a ${p.type}`}`;
    if (p.enum && !p.enum.includes(v as string)) return `${key} must be one of: ${p.enum.join(", ")}`;
  }
  return tool.reject?.(a as ToolArgs) ?? null;
}

async function callTool(name: string, a: Record<string, unknown>, signal: AbortSignal): Promise<{ content: { type: "text"; text: string }[]; isError: boolean }> {
  const tool = TOOLS[name];
  const bad = validate(tool, a);
  if (bad) return { content: [{ type: "text", text: `status: error\nerror: ${bad}` }], isError: true };
  if (typeof a.file === "string") a = { ...a, file: path.resolve(a.file) };
  // validate checked every argument against the tool's schema, and that the required ones are there.
  const args = a as ToolArgs;
  let text = "";
  let isError = false;
  for (const run of tool.run(args)) {
    const r = await runCli(run, signal);
    text += r.text;
    if (r.code !== 0) {
      isError = true;
      break;
    }
  }
  return { content: [{ type: "text", text: text.trimEnd() }], isError };
}

function listTools() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    title: t.title,
    description: t.description,
    inputSchema: { type: "object", properties: t.properties, required: t.required, additionalProperties: false },
    annotations: { title: t.title, readOnlyHint: !!t.readOnly, openWorldHint: !!t.openWorld },
  }));
}

export function runMcp(): Promise<void> {
  const inflight = new Map<RpcId, AbortController>();
  const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const error = (id: unknown, code: number, message: string) => send({ id, error: { code, message } });

  async function handle(msg: RpcRequest): Promise<unknown> {
    const { id, method, params = {} } = msg;
    // A notification (no id) never gets a response; the only one acted on is a cancellation.
    if (id === undefined || id === null) {
      if (method === "notifications/cancelled" && params.requestId !== undefined) inflight.get(params.requestId)?.abort();
      return;
    }
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return send({
          id,
          result: {
            protocolVersion: asked !== undefined && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "austere-axi", title: "austere-axi", version: VERSION },
            instructions: INSTRUCTIONS,
          },
        });
      }
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({ id, result: { tools: listTools() } });
      case "tools/call": {
        if (typeof params.name !== "string" || !Object.hasOwn(TOOLS, params.name)) return error(id, -32602, `unknown tool: ${params.name}`);
        const args = params.arguments ?? {};
        if (!isRecord(args) || Array.isArray(args)) return error(id, -32602, "arguments must be an object");
        const ctl = new AbortController();
        inflight.set(id, ctl);
        try {
          const result = await callTool(params.name, args, ctl.signal);
          if (!ctl.signal.aborted) send({ id, result });
        } finally {
          inflight.delete(id);
        }
        return;
      }
      default:
        error(id, -32601, `method not found: ${method}`);
    }
  }

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return error(null, -32700, "parse error");
    }
    if (Array.isArray(msg)) return error(null, -32600, "batch not supported");
    if (!isRecord(msg) || typeof msg.method !== "string") {
      if (isRecord(msg) && "id" in msg && !("result" in msg || "error" in msg)) error(msg.id ?? null, -32600, "invalid request");
      return;
    }
    // A JSON-RPC message with a string method: the protocol's request shape.
    const req = msg as RpcRequest;
    handle(req).catch((err: unknown) => {
      if (req.id !== undefined && req.id !== null) error(req.id, -32603, String((isRecord(err) ? err.message : undefined) || err));
    });
  });
  return new Promise<void>((resolve) => {
    lines.on("close", () => {
      for (const ctl of inflight.values()) ctl.abort();
      resolve(undefined);
    });
  });
}
