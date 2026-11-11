// CLI side of the server: find or start it, then talk JSON over loopback.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CLI_ENTRY, VERSION, port as configuredPort, stateDir, versionGt } from "./paths.ts";
import { ownerKey } from "./invites.ts";
import type { HealthInfo, LoginResponse } from "./server.ts";

/** The `error` a control route answers with when it refuses. */
export interface ApiError {
  error?: string;
}

/**
 * A control route's answer. `data` is the parsed JSON body, typed as what the route sends (see the
 * response types in server.ts); a body that is not JSON stays its text.
 */
export interface ApiResult<T> {
  status: number | undefined;
  data: T & ApiError;
}

/** A server that proved it holds our owner key, or one from before the proof (`legacy`). */
export type ServerHealth = HealthInfo & { foreign?: undefined; legacy?: true };

/** health(): our server, or a listener that is not (`foreign`). */
export type Health = ServerHealth | { foreign: true; legacy?: undefined };

/**
 * Call a control route. `auth` sends the owner key, which the server requires on every route but
 * health; only send it to a server health() has checked.
 */
export function request<T extends object = ApiError>(
  method: string,
  route: string,
  body?: unknown,
  { timeoutMs = 0, port = configuredPort(), auth = true }: { timeoutMs?: number; port?: number; auth?: boolean } = {},
): Promise<ApiResult<T>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(auth ? { "x-austere-key": ownerKey(stateDir()) } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data: unknown = raw;
          try {
            data = JSON.parse(raw);
          } catch {
            // keep text
          }
          // The server's answer: trusted to have the shape the route sends.
          resolve({ status: res.statusCode, data: data as T & ApiError });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * The server's health, or `{ foreign: true }` when the listener cannot prove it holds our owner key
 * (another program, or another OS user squatting the port), or null when nothing listens. The proof
 * is an HMAC of the port and a fresh nonce, so the key never goes to an unchecked listener, and a
 * listener on another port cannot relay our server's answer. A server from before the proof comes
 * back with `legacy: true`: it is only ever asked to stop, without the key (shutdownServer).
 */
export async function health(port: number): Promise<Health | null> {
  const nonce = crypto.randomBytes(16).toString("base64url");
  let r: ApiResult<HealthInfo>;
  try {
    r = await request<HealthInfo>("GET", `/api/health?nonce=${nonce}`, undefined, { timeoutMs: 1200, port, auth: false });
  } catch {
    return null;
  }
  if (r.status !== 200 || !r.data || r.data.name !== "austere-axi") return { foreign: true };
  if (r.data.proof == null) return { ...r.data, legacy: true };
  const want = crypto.createHmac("sha256", ownerKey(stateDir())).update(`${port}:${nonce}`).digest();
  const got = Buffer.from(String(r.data.proof), "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { foreign: true };
  return r.data;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Start a detached server. Returns a probe that tells whether the process has already exited. */
function spawnServer(port: number, { alsoListen = [], persist = false }: { alsoListen?: string[]; persist?: boolean } = {}): () => number | "signal" | null {
  const log = fs.openSync(path.join(stateDir(), "server.log"), "a", 0o600);
  const args = [CLI_ENTRY, "server", "--port", String(port)];
  for (const h of alsoListen) args.push("--also-listen", h);
  if (persist) args.push("--persist");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, OPENUI_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
  });
  let exited: number | "signal" | null = null;
  child.on("exit", (code) => (exited = code ?? "signal"));
  child.unref();
  return () => exited;
}

// A cold start can take many seconds on a busy Windows machine (antivirus scans every file Node loads).
const START_TIMEOUT_MS = 30_000;

/** Make sure a compatible server is running; returns its health info. */
export async function ensureServer(): Promise<ServerHealth> {
  const port = configuredPort();
  let h = await health(port);
  let exited: () => number | "signal" | null = () => null;
  if (h?.foreign) {
    throw new Error(`port ${port} is in use by something that is not austere-axi; set AUSTERE_AXI_PORT to another port`);
  }
  if (h && h.stateDir !== stateDir()) {
    throw new Error(`port ${port} is served by an austere-axi with another state dir (${h.stateDir}); set AUSTERE_AXI_PORT`);
  }
  if (h && (h.legacy || versionGt(VERSION, h.version))) {
    // A newer CLI replaces an older server; sessions are on disk. The new one listens where the old one did and keeps --persist.
    const { tailnet } = h;
    const keep = (h.listen || []).filter((x) => x !== "127.0.0.1" && (!tailnet || x !== tailnet.ip));
    const persist = !!h.persist;
    await shutdownServer(h, port);
    for (let i = 0; i < 40 && (await health(port)); i++) await sleep(100);
    h = null;
    exited = spawnServer(port, { alsoListen: keep, persist });
  } else if (!h) {
    exited = spawnServer(port);
  }
  if (!h) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(100);
      h = await health(port);
      if (h && !h.foreign && !h.legacy) return h;
      if (exited() != null) {
        // It may have lost the port to a server another command started at the same time.
        h = await health(port);
        if (h && !h.foreign && !h.legacy) return h;
        break;
      }
    }
    throw new Error(`server did not start on port ${port}; see ${path.join(stateDir(), "server.log")}`);
  }
  return h;
}

/**
 * The running server's health, or null. `legacy` also returns a server from before the health proof,
 * which is good for nothing but shutdownServer.
 */
export async function serverIfRunning({ legacy = false }: { legacy?: boolean } = {}): Promise<ServerHealth | null> {
  const h = await health(configuredPort());
  return h && !h.foreign && (legacy || !h.legacy) ? h : null;
}

/** Ask the server `h` to stop. A legacy server asks for no key; do not hand one to a listener that has not proven itself. */
export function shutdownServer(h: ServerHealth, port = configuredPort()): Promise<ApiResult<ApiError> | void> {
  return request("POST", "/api/shutdown", {}, { timeoutMs: 2000, port, auth: !h.legacy }).catch(() => {});
}

/**
 * `url` (a page on the local server) with a fresh single-use login code, which the server swaps for
 * the owner cookie. The code works once and only for `ttlMs`, so a copy seen later (in a process
 * list, a terminal, browser history) is no use; the key itself never leaves the CLI.
 */
export async function loginUrl(url: string): Promise<{ url: string; ttlMs: number }> {
  const r = await request<LoginResponse>("POST", "/api/login", {}, { timeoutMs: 5000 });
  if (r.status !== 200 || typeof r.data?.code !== "string") throw new Error(r.data?.error || `login failed (${r.status})`);
  const u = new URL(url);
  u.searchParams.set("login", r.data.code);
  return { url: u.href, ttlMs: r.data.ttlMs };
}

/** Open `url` (a page on the local server) in the browser, signed in as the owner. */
export async function openBrowser(url: string): Promise<boolean> {
  let target: string;
  try {
    target = (await loginUrl(url)).url;
  } catch {
    return false;
  }
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [target];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", target];
  } else {
    cmd = "xdg-open";
    args = [target];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
