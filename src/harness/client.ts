// The wake client a harness extension runs inside an agent session (RLM-447): `omp.ts` (omp / Pi)
// and `copilot.ts` (Copilot CLI) only adapt their harness to `WakeHost`. Loaded into every session,
// it stays inert until the austere-axi server reports a role for the session's id: one check when
// the session starts (and again after a turn that ran austere-axi), and nothing else. With a role,
// while the session is idle it long-polls the server's wake-poll route; when the owner sends notes
// on one of its pages, it starts a turn with the server's prompt (a pointer to the pages, never the
// notes' text) and acknowledges it. It never folds into a running turn: a session that is busy
// releases the claim, and the notes come again once the turn ends.
//
// It talks to the server as the CLI does (src/cli/client.ts): the port from server.lock, the owner
// key from owner.key, and only after the server proved it holds that key. It only reads the state
// dir: it never starts a server, writes a key or registers the session.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** What the client needs of its harness's session. */
export interface WakeHost {
  /** The harness name the server knows sessions under (caller.ts). */
  harness: "omp" | "copilot";
  /** The session's id, as the harness's environment names it to austere-axi commands. */
  sessionId(): string;
  /** Not in a turn, and nothing queued to start one. */
  idle(): boolean;
  /** Starts a turn with `prompt`; called only while `idle()`. A rejection gives the notes back. */
  send(prompt: string): unknown;
}

/** The server's answer to wake-poll (src/cli/wake.ts, WakePollResponse). */
type PollAnswer =
  | { status: "no_role" | "idle" | "timeout" | "interrupted" }
  | { status: "wake"; claim: string; prompt: string };

interface Link {
  port: number;
  key: string;
}

const TICK_MS = 1000;
/** Idle for this many ticks in a row before a poll: a turn that ends and starts again at once is not idle. */
const IDLE_TICKS = 2;
/** A wait, under the server's cap (WAKE_POLL_MAX_MS). */
const POLL_MS = 50_000;
const BACKOFF_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
/** Failed polls in a row (the server stopped) before the client goes inert until the next austere-axi command. */
const MAX_FAILURES = 6;
// As lock.ts: a lock older than this is a dead holder's.
const LOCK_FRESH_MS = 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running server's port and the owner key, from local files only; null when no server runs. */
export function findServer(env: NodeJS.ProcessEnv = process.env): Link | null {
  // The state dir as paths.ts names it; read only.
  const dir = env.AUSTERE_AXI_STATE_DIR
    ? path.resolve(env.AUSTERE_AXI_STATE_DIR)
    : path.join(os.homedir(), ".austere-axi");
  let key: string;
  try {
    key = fs.readFileSync(path.join(dir, "owner.key"), "utf8").trim();
  } catch {
    return null;
  }
  if (key.length < 22) return null;
  const fixed = Number(env.AUSTERE_AXI_PORT);
  if (Number.isInteger(fixed) && fixed > 0 && fixed < 65536) return { port: fixed, key };
  let lock: { pid?: unknown; port?: unknown; at?: unknown };
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dir, "server.lock"), "utf8")) as typeof lock;
  } catch {
    return null;
  }
  const { pid, port, at } = lock ?? {};
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port >= 65536)
    return null;
  if (!(Date.now() - Number(at) < LOCK_FRESH_MS)) return null;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && alive(pid)
    ? { port, key }
    : null;
}

function call<T>(
  link: Link,
  method: string,
  route: string,
  body?: unknown,
  {
    auth = true,
    signal,
    timeoutMs = 0,
  }: { auth?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: number; data: T }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; data: T }>();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request(
    {
      host: "127.0.0.1",
      port: link.port,
      method,
      path: route,
      signal,
      headers: {
        host: `127.0.0.1:${link.port}`,
        ...(auth ? { "x-austere-key": link.key } : {}),
        ...(payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {}),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
          });
        } catch (err) {
          reject(err as Error);
        }
      });
      res.on("error", reject);
    },
  );
  req.on("error", reject);
  if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  req.end(payload);
  return promise;
}

/** Whether the listener on `link.port` is our server: it proves it holds the key without being sent it (client.ts, health). */
async function proven(link: Link): Promise<boolean> {
  const nonce = crypto.randomBytes(16).toString("base64url");
  try {
    const r = await call<{ name?: string; proof?: string }>(
      link,
      "GET",
      `/api/health?nonce=${nonce}`,
      undefined,
      { auth: false, timeoutMs: 1200 },
    );
    if (r.status !== 200 || r.data.name !== "austere-axi" || typeof r.data.proof !== "string")
      return false;
    const want = crypto.createHmac("sha256", link.key).update(`${link.port}:${nonce}`).digest();
    const got = Buffer.from(r.data.proof, "base64url");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Whether a tool call ran austere-axi (the CLI, or the MCP server's tools): the session may have a page now. */
function ranAustere(toolName: unknown, input: unknown): boolean {
  if (typeof toolName === "string" && toolName.includes("austere")) return true;
  try {
    return JSON.stringify(input ?? "").includes("austere-axi");
  } catch {
    return false;
  }
}

/** One session's wake client. `env` is for tests. */
export class WakeClient {
  private host: WakeHost;
  private env: NodeJS.ProcessEnv;
  /** This process, as the server tells two processes on one session apart. */
  readonly client = crypto.randomBytes(12).toString("base64url");
  private link: Link | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: AbortController | null = null;
  private checking = false;
  private recheck = false;
  private idleTicks = 0;
  private failures = 0;
  private retryAt = 0;

  constructor(host: WakeHost, env: NodeJS.ProcessEnv = process.env) {
    this.host = host;
    this.env = env;
  }

  /** Whether the session has a role and the client polls while it is idle. */
  get active(): boolean {
    return this.timer !== null;
  }

  private route(op: string): string {
    const key = `${this.host.harness}:${this.host.sessionId()}`;
    return `/api/sessions/${encodeURIComponent(key)}/${op}`;
  }

  /** A server proven to be ours, or null when none runs. Local files, then one health request. */
  private async connect(): Promise<Link | null> {
    if (this.link) return this.link;
    const link = findServer(this.env);
    if (!link || !(await proven(link))) return null;
    return (this.link = link);
  }

  /** The one cheap check: is there a server, and does it know this session on a page? */
  async check(): Promise<void> {
    if (this.checking || this.active || !this.host.sessionId()) return;
    this.checking = true;
    try {
      const link = await this.connect();
      if (!link) return;
      const r = await call<PollAnswer>(link, "POST", this.route("wake-poll"), {
        client: this.client,
        timeoutMs: 0,
      });
      if (r.status !== 200 || r.data.status === "no_role") return;
      this.start();
      if (r.data.status === "wake") await this.deliver(link, r.data);
    } catch {
      this.link = null;
    } finally {
      this.checking = false;
    }
  }

  private start(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** Inert again: no timer, no request. */
  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    this.inflight?.abort();
    this.inflight = null;
    this.idleTicks = 0;
  }

  /** A tool call ran: one that ran austere-axi makes the next turn end check again. */
  toolRan(toolName: unknown, input: unknown): void {
    if (!this.active && ranAustere(toolName, input)) this.recheck = true;
  }

  /** A turn ended. */
  turnEnd(): void {
    if (!this.recheck) return;
    this.recheck = false;
    void this.check();
  }

  /** Each second while active: poll while idle, drop the poll when a turn starts. */
  tick(): void {
    if (!this.host.idle()) {
      this.idleTicks = 0;
      this.inflight?.abort();
      return;
    }
    if (++this.idleTicks < IDLE_TICKS || this.inflight || Date.now() < this.retryAt) return;
    void this.poll();
  }

  private async poll(): Promise<void> {
    const ac = new AbortController();
    this.inflight = ac;
    try {
      const link = await this.connect();
      if (!link) throw new Error("no server");
      const r = await call<PollAnswer>(
        link,
        "POST",
        this.route("wake-poll"),
        { client: this.client, timeoutMs: POLL_MS },
        { signal: ac.signal },
      );
      if (r.status !== 200) throw new Error(`wake-poll answered ${r.status}`);
      this.failures = 0;
      if (r.data.status === "no_role") this.stop();
      else if (r.data.status === "wake") await this.deliver(link, r.data);
    } catch {
      if (ac.signal.aborted) return;
      this.link = null;
      // The server stopped: give up after a while, until the session runs austere-axi again.
      if (++this.failures >= MAX_FAILURES) return this.stop();
      this.retryAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.failures - 1));
    } finally {
      if (this.inflight === ac) this.inflight = null;
    }
  }

  /** Start the turn while the session is still idle, then say so; a busy session, or a send the harness refused, hands the claim back. */
  private async deliver(link: Link, wake: { claim: string; prompt: string }): Promise<void> {
    let delivered = this.host.idle();
    if (delivered) {
      try {
        await this.host.send(wake.prompt);
      } catch {
        delivered = false;
      }
    }
    const ack = {
      client: this.client,
      claim: wake.claim,
      outcome: delivered ? "delivered" : "released",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await call(link, "POST", this.route("wake-ack"), ack, { timeoutMs: 5000 });
        return;
      } catch {
        // once more; then the claim expires on the server
      }
    }
  }
}
