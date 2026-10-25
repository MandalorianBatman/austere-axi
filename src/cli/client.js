// CLI side of the server: find or start it, then talk JSON over loopback.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CLI_ENTRY, VERSION, port as configuredPort, stateDir, versionGt } from "./paths.js";

export function request(method, route, body, { timeoutMs = 0, port = configuredPort() } = {}) {
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

async function health(port) {
  try {
    const r = await request("GET", "/api/health", undefined, { timeoutMs: 1200, port });
    if (r.status === 200 && r.data && r.data.name === "austere-axi") return r.data;
    return { foreign: true };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnServer(port, alsoListen = []) {
  const log = fs.openSync(path.join(stateDir(), "server.log"), "a");
  const args = [CLI_ENTRY, "server", "--port", String(port)];
  for (const h of alsoListen) args.push("--also-listen", h);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, OPENUI_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
  });
  child.unref();
}

/** Make sure a compatible server is running; returns its health info. */
export async function ensureServer() {
  const port = configuredPort();
  let h = await health(port);
  if (h?.foreign) {
    throw new Error(`port ${port} is in use by something that is not austere-axi; set AUSTERE_AXI_PORT to another port`);
  }
  if (h && h.stateDir !== stateDir()) {
    throw new Error(`port ${port} is served by an austere-axi with another state dir (${h.stateDir}); set AUSTERE_AXI_PORT`);
  }
  if (h && versionGt(VERSION, h.version)) {
    // Newer CLI replaces an older server; sessions persist on disk.
    const keep = (h.listen || []).filter((x) => x !== "127.0.0.1" && (!h.tailnet || x !== h.tailnet.ip));
    await request("POST", "/api/shutdown", {}, { timeoutMs: 2000, port }).catch(() => {});
    for (let i = 0; i < 40 && (await health(port)); i++) await sleep(100);
    h = null;
    spawnServer(port, keep);
  } else if (!h) {
    spawnServer(port);
  }
  if (!h) {
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      h = await health(port);
      if (h && !h.foreign) return h;
    }
    throw new Error(`server did not start on port ${port}; see ${path.join(stateDir(), "server.log")}`);
  }
  return h;
}

export async function serverIfRunning() {
  const h = await health(configuredPort());
  return h && !h.foreign ? h : null;
}

export function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
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
