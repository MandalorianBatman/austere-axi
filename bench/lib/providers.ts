// Model backends. Each returns one assistant turn plus what it cost.
//
//   anthropic   Anthropic Messages API, streamed. Also serves Anthropic-compatible
//               endpoints (MiniMax) through `baseUrl`. Key from `keyEnv`.
//   claude-cli  The `claude` CLI in print mode (Claude Code login or ANTHROPIC_API_KEY).
//               No tools; the system prompt replaces Claude Code's own.
//
// A conversation is { system, messages: [{role, content}] }; `state` carries what a
// backend needs to continue it (the CLI session id).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STATE } from "./paths.ts";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number | null;
}

/** What the claude CLI backend needs to continue a conversation. */
export interface CliState {
  dir: string;
  sessionId: string | undefined;
}

export interface Turn {
  text: string;
  usage: Usage;
  costUsd: number;
  wallMs: number;
  ttftMs: number | null;
  stopReason: string;
  state?: CliState;
}

export interface Message {
  role: string;
  content: string;
}

export interface Convo {
  system: string;
  messages: Message[];
  state?: CliState;
}

/** USD per million tokens. A rate left out costs nothing (cache rates fall back to input). */
export interface Pricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  source?: string;
}

interface ModelBase {
  model: string;
  pricing: Pricing;
  default?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface AnthropicModelConfig extends ModelBase {
  provider: "anthropic";
  baseUrl: string;
  keyEnv: string;
}

export interface ClaudeCliModelConfig extends ModelBase {
  provider: "claude-cli";
  effort?: string;
  command?: string;
}

/** An entry of bench/models.json. */
export type ModelConfig = AnthropicModelConfig | ClaudeCliModelConfig;
/** A models.json entry with its id. */
export type Model = ModelConfig & { id: string };

/** Token counts as the Anthropic API and the claude CLI report them. */
interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

/** One server-sent event of a streamed Messages API response. */
interface StreamEvent {
  type: string;
  message?: { usage?: ApiUsage };
  delta?: { type?: string; text: string; stop_reason?: string | null };
  usage?: ApiUsage;
  error?: unknown;
}

/** The JSON `claude -p --output-format json` prints. */
interface ClaudeCliResult {
  is_error?: boolean;
  result?: string;
  usage?: ApiUsage;
  total_cost_usd?: number;
  stop_reason?: string;
  subtype?: string;
  session_id: string;
}

export function complete(model: Model, convo: Convo): Promise<Turn> {
  if (model.provider === "anthropic") return anthropic(model, convo);
  if (model.provider === "claude-cli") return claudeCli(model, convo);
  const unknown: { provider: string } = model;
  throw new Error(`unknown provider ${unknown.provider}`);
}

export function missingCredentials(model: ModelConfig): string | null {
  if (model.provider === "anthropic" && !process.env[model.keyEnv]) return `${model.keyEnv} is not set`;
  return null;
}

export function priceUsage(pricing: Pricing, u: Usage): number {
  const per = (n: number, rate: number | undefined) => (n * (rate ?? 0)) / 1e6;
  return per(u.input, pricing.input) + per(u.output, pricing.output) + per(u.cacheRead, pricing.cacheRead ?? pricing.input) + per(u.cacheWrite, pricing.cacheWrite ?? pricing.input);
}

async function anthropic(model: AnthropicModelConfig & { id: string }, convo: Convo): Promise<Turn> {
  const started = performance.now();
  let ttftMs: number | null = null;
  const body = {
    model: model.model,
    max_tokens: model.maxTokens ?? 32000,
    system: convo.system,
    messages: convo.messages,
    stream: true,
    ...(model.temperature != null ? { temperature: model.temperature } : {}),
  };
  const res = await fetchWithRetry(`${model.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": process.env[model.keyEnv] ?? "" },
    body: JSON.stringify(body),
  });
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: null };
  let text = "";
  let stopReason = "";
  const take = (u: ApiUsage | undefined) => {
    if (!u) return;
    if (u.input_tokens != null) usage.input = u.input_tokens;
    if (u.output_tokens != null) usage.output = u.output_tokens;
    if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
    if (u.output_tokens_details?.thinking_tokens != null) usage.thinking = u.output_tokens_details.thinking_tokens;
  };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body!) {
    buf += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      const msg: StreamEvent = JSON.parse(data);
      if (msg.type === "message_start") take(msg.message?.usage);
      else if (msg.type === "content_block_delta") {
        ttftMs ??= performance.now() - started;
        if (msg.delta?.type === "text_delta") text += msg.delta.text;
      } else if (msg.type === "message_delta") {
        take(msg.usage);
        stopReason = msg.delta?.stop_reason ?? stopReason;
      } else if (msg.type === "error") throw new Error(`${model.id}: ${JSON.stringify(msg.error)}`);
    }
  }
  return { text, usage, costUsd: priceUsage(model.pricing, usage), wallMs: performance.now() - started, ttftMs, stopReason };
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const detail = await res.text();
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 500)}`);
  }
}

// One `claude -p` call per turn. Later turns resume the CLI session, so the model
// sees the same conversation an API caller would send.
async function claudeCli(model: ClaudeCliModelConfig, convo: Convo): Promise<Turn> {
  const dir = convo.state?.dir ?? fs.mkdtempSync(path.join(STATE, "claude-"));
  const sysFile = path.join(dir, "system.md");
  if (!convo.state) fs.writeFileSync(sysFile, convo.system);
  const args = ["-p", "--model", model.model, "--system-prompt-file", sysFile, "--tools", "", "--setting-sources", "", "--output-format", "json"];
  if (model.effort) args.push("--effort", model.effort);
  if (convo.state?.sessionId) args.push("--resume", convo.state.sessionId);
  const prompt = convo.messages[convo.messages.length - 1].content;
  const started = performance.now();
  const out = await run(model.command ?? "claude", args, prompt, dir);
  const wallMs = performance.now() - started;
  const json: ClaudeCliResult = JSON.parse(out);
  if (json.is_error) throw new Error(`claude-cli: ${json.result}`);
  const u: ApiUsage = json.usage ?? {};
  return {
    text: json.result ?? "",
    usage: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      thinking: u.output_tokens_details?.thinking_tokens ?? null,
    },
    costUsd: json.total_cost_usd ?? 0,
    wallMs,
    ttftMs: null,
    stopReason: json.stop_reason ?? json.subtype ?? "",
    state: { dir, sessionId: json.session_id },
  };
}

function run(cmd: string, args: string[], stdin: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 || out.trim().startsWith("{") ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`))));
    child.stdin.end(stdin);
  });
}
