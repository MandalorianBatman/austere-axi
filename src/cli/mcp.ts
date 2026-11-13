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
  groups?: string[];
  fix?: boolean;
  render?: boolean;
  no_open?: boolean;
  reopen?: boolean;
  agent_reply?: string;
  cursor?: number;
  takeover?: boolean;
  timeout_ms?: number;
  text: string;
  statements: string;
  command: string;
  args?: string[];
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
      reopen: { type: "boolean", description: "Reopen a review the user ended. Only when the user asks." },
    },
    required: ["file"],
    run: (a) => [{ args: ["open", ...(a.no_open ? ["--no-open"] : []), ...(a.reopen ? ["--reopen"] : []), "--", a.file] }],
  },
  poll: {
    title: "Wait for feedback",
    description: `Wait for the reviewer's feedback on an open review. Returns status feedback (items addressed by statement name), ended, browser_disconnected, replaced, interrupted, or timeout (call poll again: nothing is lost). Feedback comes back on every poll until acknowledged: after applying it, pass agent_reply, or pass the cursor it returned.`,
    properties: {
      file,
      agent_reply: { type: "string", description: "One line for the reviewer: what you changed." },
      cursor: { type: "integer", minimum: 0, description: "The cursor the last poll returned: acknowledges that feedback, so it is not returned again. A reply acknowledges it too." },
      takeover: { type: "boolean", description: "Replace a poll that is stuck listening on this session." },
      timeout_ms: { type: "integer", minimum: 0, description: `Return status timeout after this long (default ${POLL_TIMEOUT_MS}). 0 waits until feedback arrives; use it only if your client allows long tool calls.` },
    },
    required: ["file"],
    run: (a) => {
      const args = ["poll", "--timeout-ms", String(a.timeout_ms ?? POLL_TIMEOUT_MS)];
      if (a.takeover) args.push("--takeover");
      if (Number.isInteger(a.cursor)) args.push("--cursor", String(a.cursor));
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
    },
    required: ["file", "text"],
    run: (a) => [{ args: ["reply", ...(Number.isInteger(a.cursor) ? ["--cursor", String(a.cursor)] : []), "--agent-reply-file", "-", "--", a.file], stdin: a.text }],
  },
  patch: {
    title: "Merge statements into a page",
    description: "Merge OpenUI Lang statements into the page's program: a statement with an existing name replaces it, a new name adds it, `name = null` deletes it. Returns the check result.",
    properties: { file, statements: { type: "string", description: "One or more `name = ...` statements." } },
    required: ["file", "statements"],
    run: (a) => [{ args: ["patch", "--", a.file], stdin: a.statements }],
  },
  end: {
    title: "End the review",
    description: "End the review as the agent.",
    properties: { file },
    required: ["file"],
    run: (a) => [{ args: ["end", "--", a.file] }],
  },
  components: {
    title: "Find and install components",
    description: "Components spec leaves out, and packs on npm. Third-party packs the user has not trusted are refused: ask the user to install them.",
    openWorld: true,
    properties: {
      command: { type: "string", enum: ["search", "show", "list", "add"], description: "search <words>, show <Name...>, list [group], add <npm-package>." },
      args: { type: "array", items: { type: "string" }, description: "The command's words, component names, group, or one npm package name[@version]." },
    },
    required: ["command"],
    // An MCP client installs from the registry only: a folder or .tgz would run local files the user never vetted.
    reject: (a) => {
      if (a.command !== "add") return null;
      if (a.args?.length !== 1) return "add takes exactly one npm package name[@version] in args";
      if (looksLikePath(a.args[0]) || !isValidPackName(splitSpec(a.args[0]).name)) return "add takes an npm package name[@version]; folders and .tgz files are installed from the command line";
      return null;
    },
    run: (a) => [{ args: ["components", a.command, "--", ...(a.args ?? [])] }],
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
