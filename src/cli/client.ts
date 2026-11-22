// CLI side of the server: find or start it, then talk JSON over loopback.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CLI_ENTRY, VERSION, stateDir, versionGt } from "./paths.ts";
import { ownerKey } from "./invites.ts";
import { withAddressSettings } from "./net.ts";
import type { AddressSettings } from "./net.ts";
import type { HealthInfo, LoginResponse } from "./server.ts";
import {
  childEnv,
  installedServiceFor,
  lockedOutNote,
  restartHint,
  restartUnit,
  serverPort,
  serverUnit,
  serviceContext,
  startInstalledService,
  SYSTEMD_UNIT,
  UNKNOWN_LAUNCHD_LABEL,
} from "./service.ts";
import type { PortProbe, ServerUnit } from "./service.ts";

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

/** The port this command talks to: resolved once (serverPort reads server.lock, which may change under it). */
let pinnedPort: number | undefined;

/**
 * The server port for this command, resolved on first use and kept. A later read of server.lock
 * could name another port (the checked server exited), and the key must not follow it there.
 */
export function commandPort(): number {
  return (pinnedPort ??= serverPort());
}

/**
 * Call a control route. `auth` sends the owner key, which the server requires on every route but
 * health; only send it to a server health() has checked. The default port is commandPort(), the
 * one ensureServer and serverIfRunning checked.
 */
export function request<T extends object = ApiError>(
  method: string,
  route: string,
  body?: unknown,
  {
    timeoutMs = 0,
    port = commandPort(),
    auth = true,
  }: { timeoutMs?: number; port?: number; auth?: boolean } = {},
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
          // The CLI's version: the server's Settings → About says when the CLI is newer than the server.
          ...(auth ? { "x-austere-key": ownerKey(stateDir()), "x-austere-cli": VERSION } : {}),
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
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
      req.setTimeout(timeoutMs, () =>
        req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
      );
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
    r = await request<HealthInfo>("GET", `/api/health?nonce=${nonce}`, undefined, {
      timeoutMs: 1200,
      port,
      auth: false,
    });
  } catch {
    return null;
  }
  if (r.status !== 200 || !r.data || r.data.name !== "austere-axi") return { foreign: true };
  if (r.data.proof == null) return { ...r.data, legacy: true };
  const want = crypto
    .createHmac("sha256", ownerKey(stateDir()))
    .update(`${port}:${nonce}`)
    .digest();
  const got = Buffer.from(String(r.data.proof), "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { foreign: true };
  return r.data;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start a detached server. Returns a probe that tells whether the process has already exited.
 * `addresses` are the address variables of the server it replaces; without them (no server to
 * replace, or one from before 0.12) it runs with the caller's.
 */
function spawnServer(
  port: number,
  {
    alsoListen = [],
    persist = false,
    addresses,
  }: { alsoListen?: string[]; persist?: boolean; addresses?: AddressSettings } = {},
): () => number | "signal" | null {
  const log = fs.openSync(path.join(stateDir(), "server.log"), "a", 0o600);
  const args = [CLI_ENTRY, "server", "--port", String(port)];
  for (const h of alsoListen) args.push("--also-listen", h);
  if (persist) args.push("--persist");
  // The child may not claim a supervisor it does not have: a CLI hands over its environment.
  const env = addresses ? withAddressSettings(childEnv(), addresses) : childEnv();
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...env, OPENUI_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
  });
  let exited: number | "signal" | null = null;
  child.on("exit", (code) => (exited = code ?? "signal"));
  child.unref();
  return () => exited;
}

// A cold start can take many seconds on a busy Windows machine (antivirus scans every file Node loads).
const START_TIMEOUT_MS = 30_000;

/** A note the server left for the user, waiting to be printed with the command's own output. */
let pendingNote: string | undefined;

/** The note `ensureServer` left, and forgets it. */
export function takeServerNote(): string | undefined {
  const note = pendingNote;
  pendingNote = undefined;
  return note;
}

/** Leave `note` for the command's output, and say it on stderr now. */
function leaveNote(note: string): void {
  pendingNote = note;
  process.stderr.write(`[austere-axi] ${note}\n`);
}

/**
 * Make sure a compatible server is running; returns its health info. `restart` restarts the one
 * that runs: the unit that runs it restarts it (and a stopped service is started), and a server no
 * unit runs is replaced, as an older one is.
 */
export async function ensureServer({
  restart = false,
}: { restart?: boolean } = {}): Promise<ServerHealth> {
  const port = commandPort();
  let h = await health(port);
  let exited: () => number | "signal" | null = () => null;
  if (h?.foreign) {
    throw new Error(
      `port ${port} is in use by something that is not austere-axi; set AUSTERE_AXI_PORT to another port`,
    );
  }
  if (h && h.stateDir !== stateDir()) {
    throw new Error(
      `port ${port} is served by an austere-axi with another state dir (${h.stateDir}); set AUSTERE_AXI_PORT`,
    );
  }
  // Asked of the system at most once, and only when the answer matters.
  let found: ServerUnit | null | undefined;
  const unitOf = (s: ServerHealth): ServerUnit | null =>
    found === undefined ? (found = serverUnit(s.pid)) : found;
  const plan = h ? serverAction(h, VERSION, () => unitOf(h as ServerHealth), { restart }) : null;
  if (h && restart && plan?.action === "replace" && !h.legacy && versionGt(h.version, VERSION)) {
    // Restarting would put this older CLI's server in place of a newer one.
    throw new Error(
      `the server runs v${h.version}, newer than this CLI (v${VERSION}); restarting it from here would replace it with v${VERSION}. Run \`austere-axi server restart\` with the newer CLI that started it, or \`austere-axi stop\`.`,
    );
  }
  // The server a restart replaces: the new one must not be mistaken for it while it is still going.
  const old = h;
  if (h && restart && plan?.action === "restart-unit") {
    restartUnit(serviceContext(probePort), plan.unit);
    h = null;
  } else if (h && plan?.action === "restart-unit") {
    // A server a unit runs is never replaced: two would fight over the port and the state dir. It still serves.
    leaveNote(
      `The server runs v${h.version} under ${plan.unit.supervisor} and this CLI is v${VERSION}; it keeps serving. Restart it to update: ${restartHint(plan.unit)}`,
    );
  } else if (h && plan?.action === "replace") {
    // A newer CLI replaces an older server; sessions are on disk. The new one listens where the
    // old one did, keeps --persist and the old one's address variables (link url, allowed hosts).
    // The local-network address is Settings', which the new one reads itself: as --also-listen it would let the owner in there.
    const { tailnet, lan } = h;
    const keep = (h.listen || []).filter(
      (x) => x !== "127.0.0.1" && (!tailnet || x !== tailnet.ip) && x !== lan,
    );
    await shutdownServer(h, port);
    for (let i = 0; i < 40 && (await health(port)); i++) await sleep(100);
    exited = spawnServer(port, { alsoListen: keep, persist: !!h.persist, addresses: h.addresses });
    process.stderr.write(
      `[austere-axi] replaced server ${h.version} (pid ${h.pid}) with ${VERSION} from ${CLI_ENTRY}\n`,
    );
    h = null;
  } else if (!h) {
    // No server answers. If a service is installed for this state dir, start it: a CLI that
    // starts its own server instead takes the port and the state dir away from the unit,
    // and the unit could never come back (RLM-311). A restart restarts it: a unit that is
    // active while its server does not answer would ignore a start.
    const started = startInstalledService(serviceContext(probePort), stateDir(), port, { restart });
    if (!started) exited = spawnServer(port);
  }
  if (!h) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(100);
      h = await health(port);
      if (h && !h.foreign && !h.legacy && h.pid !== old?.pid) break;
      if (exited() != null) {
        // It may have lost the port to a server another command started at the same time.
        h = await health(port);
        break;
      }
    }
    if (!h || h.foreign || h.legacy || h.pid === old?.pid) {
      const why =
        plan?.action === "restart-unit" && plan.unit.supervisor === "systemd"
          ? `journalctl --user -u ${plan.unit.unit} -n 50`
          : path.join(stateDir(), "server.log");
      throw new Error(`server did not start on port ${port}; see ${why}`);
    }
    found = undefined; // another process now
  }
  // A server the installed service did not start holds its port: the unit fails (or loops)
  // until that server stops, and nothing else tells the owner.
  if (
    plan?.action !== "restart-unit" &&
    !h.supervised &&
    installedServiceFor(serviceContext(probePort), stateDir(), port) &&
    !unitOf(h)
  ) {
    leaveNote(lockedOutNote(h.pid, port));
  }
  return h;
}

/**
 * What a CLI of `version` does about the running server `h`: use it, replace it (it is older), or,
 * when a unit runs that older server, leave it running and tell the owner to restart the unit.
 * `restart` (`server restart`) restarts it whatever its version: through its unit, or by replacing it.
 * `unitOf` asks the system which unit runs it: a server from before 0.12 does not say it is
 * supervised, and is the unit's all the same.
 */
export function serverAction(
  h: ServerHealth,
  version: string,
  unitOf: () => ServerUnit | null,
  { restart = false }: { restart?: boolean } = {},
): { action: "use" } | { action: "replace" } | { action: "restart-unit"; unit: ServerUnit } {
  if (!restart && !h.legacy && !versionGt(version, h.version)) return { action: "use" };
  // The server says a supervisor runs it but the system would not say which unit: systemd's is the one
  // `server install` writes; a launchd agent may carry any label, so the hint does not guess one.
  const unit =
    unitOf() ??
    (!h.legacy && h.supervised
      ? {
          supervisor: h.supervised,
          unit: h.unit ?? (h.supervised === "systemd" ? SYSTEMD_UNIT : UNKNOWN_LAUNCHD_LABEL),
        }
      : null);
  return unit ? { action: "restart-unit", unit } : { action: "replace" };
}

/** What answers on a port, for the service commands: a server, a foreign listener, or nothing. */
export async function probePort(port: number): Promise<PortProbe | null> {
  const h = await health(port);
  if (!h) return null;
  if (h.foreign) return { foreign: true };
  return { stateDir: h.stateDir, supervised: h.supervised, pid: h.pid };
}

/**
 * The running server's health, or null. `legacy` also returns a server from before the health proof,
 * which is good for nothing but shutdownServer.
 */
export async function serverIfRunning({
  legacy = false,
}: { legacy?: boolean } = {}): Promise<ServerHealth | null> {
  const h = await health(commandPort());
  return h && !h.foreign && (legacy || !h.legacy) ? h : null;
}

/** Ask the server `h` to stop. A legacy server asks for no key; do not hand one to a listener that has not proven itself. */
export function shutdownServer(
  h: ServerHealth,
  port = commandPort(),
): Promise<ApiResult<ApiError> | void> {
  return request("POST", "/api/shutdown", {}, { timeoutMs: 2000, port, auth: !h.legacy }).catch(
    () => {},
  );
}

/**
 * `url` (a page on the local server) with a fresh single-use login code, which the server swaps for
 * the owner cookie. The code works once and only for `ttlMs`, so a copy seen later (in a process
 * list, a terminal, browser history) is no use; the key itself never leaves the CLI.
 */
export async function loginUrl(url: string): Promise<{ url: string; ttlMs: number }> {
  const r = await request<LoginResponse>("POST", "/api/login", {}, { timeoutMs: 5000 });
  if (r.status !== 200 || typeof r.data?.code !== "string")
    throw new Error(r.data?.error || `login failed (${r.status})`);
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
  return openUrl(target);
}

/** Open any `target` URL in the default browser; false when no browser could be started. */
export function openUrl(target: string): boolean {
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
