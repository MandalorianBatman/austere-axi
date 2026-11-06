// @ts-check
// CLI side of the server: find or start it, then talk JSON over loopback.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CLI_ENTRY, VERSION, port as configuredPort, stateDir, versionGt } from "./paths.js";
import { hubEnabled } from "./hub.js";
import { ownerKey } from "./invites.js";

/** Whether the server should run as the hub (`austere-axi hub on`). */
export function wantHub() {
  return hubEnabled();
}

/**
 * Call a control route. `auth` sends the owner key, which the server requires on every route but
 * health; only send it to a server health() has checked.
 */
export function request(method, route, body, { timeoutMs = 0, port = configuredPort(), auth = true } = {}) {
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
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = raw;
          try {
            data = JSON.parse(raw);
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode, data });
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
 * is an HMAC of a fresh nonce, so the key never goes to an unchecked listener. A server from before
 * the proof, older than this CLI, comes back with `legacy: true`: ensureServer replaces it.
 */
async function health(port) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  let r;
  try {
    r = await request("GET", `/api/health?nonce=${nonce}`, undefined, { timeoutMs: 1200, port, auth: false });
  } catch {
    return null;
  }
  if (r.status !== 200 || !r.data || r.data.name !== "austere-axi") return { foreign: true };
  if (r.data.proof == null && versionGt(VERSION, r.data.version)) return { ...r.data, legacy: true };
  const want = crypto.createHmac("sha256", ownerKey(stateDir())).update(nonce).digest();
  const got = Buffer.from(String(r.data.proof || ""), "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { foreign: true };
  return r.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a detached server. Returns a probe that tells whether the process has already exited. */
function spawnServer(port, alsoListen = []) {
  const log = fs.openSync(path.join(stateDir(), "server.log"), "a", 0o600);
  const args = [CLI_ENTRY, "server", "--port", String(port)];
  for (const h of alsoListen) args.push("--also-listen", h);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, OPENUI_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
  });
  let exited = null;
  child.on("exit", (code) => (exited = code ?? "signal"));
  child.unref();
  return () => exited;
}

// A cold start can take many seconds on a busy Windows machine (antivirus scans every file Node loads).
const START_TIMEOUT_MS = 30_000;

/** Make sure a compatible server is running; returns its health info. */
export async function ensureServer() {
  const port = configuredPort();
  let h = await health(port);
  let exited = () => null;
  if (h?.foreign) {
    throw new Error(`port ${port} is in use by something that is not austere-axi; set AUSTERE_AXI_PORT to another port`);
  }
  if (h && h.stateDir !== stateDir()) {
    throw new Error(`port ${port} is served by an austere-axi with another state dir (${h.stateDir}); set AUSTERE_AXI_PORT`);
  }
  if (h && (h.legacy || versionGt(VERSION, h.version) || (VERSION === h.version && Boolean(h.hubWanted ?? h.hub) !== hubEnabled()))) {
    // A newer CLI replaces an older server, and `hub on|off` switches its mode;
    // sessions persist on disk.
    const keep = (h.listen || []).filter((x) => x !== "127.0.0.1" && (!h.tailnet || x !== h.tailnet.ip));
    // A legacy server asks for no key; do not hand one to a listener that has not proven itself.
    await request("POST", "/api/shutdown", {}, { timeoutMs: 2000, port, auth: !h.legacy }).catch(() => {});
    for (let i = 0; i < 40 && (await health(port)); i++) await sleep(100);
    h = null;
    exited = spawnServer(port, keep);
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

export async function serverIfRunning() {
  const h = await health(configuredPort());
  return h && !h.foreign && !h.legacy ? h : null;
}

const LAUNCHER_TTL_MS = 10 * 60_000;

/**
 * A 0600 page in the state dir that sends the browser to `url` with the owner key, which the server
 * swaps for the owner cookie. The key stays off command lines, where other users could read it.
 */
export function launcherFile(url) {
  const target = new URL(url);
  target.searchParams.set("key", ownerKey(stateDir()));
  const dir = path.join(stateDir(), "launch");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > LAUNCHER_TTL_MS) fs.rmSync(p, { force: true });
    } catch {
      // gone already
    }
  }
  const file = path.join(dir, `${crypto.randomBytes(8).toString("hex")}.html`);
  const href = target.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><title>austere-axi</title>\n`, { mode: 0o600 });
  return file;
}

/** Open `url` (a page on the local server) in the browser, signed in as the owner. */
export function openBrowser(url) {
  let file;
  try {
    file = launcherFile(url);
  } catch {
    return false;
  }
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [file];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", file];
  } else {
    cmd = "xdg-open";
    args = [file];
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
