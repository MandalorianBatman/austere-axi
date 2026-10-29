// @ts-check
// Network binding. Loopback always; plus this machine's Tailscale IPv4 when
// Tailscale is up, so the review link opens on a phone on the same tailnet.
// Never 0.0.0.0: the server can read local files, so only trusted networks.
import { execFile } from "node:child_process";
import fs from "node:fs";

const CANDIDATES = [
  "tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

let cache = { at: 0, value: null };

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 2500, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** @returns {Promise<{ ip: string, dnsName: string|null } | null>} */
export async function detectTailscale({ fresh = false } = {}) {
  if (/^(1|true|yes)$/i.test(process.env.AUSTERE_AXI_NO_TAILSCALE || "")) return null;
  if (!fresh && Date.now() - cache.at < 30_000) return cache.value;
  let value = null;
  for (const bin of CANDIDATES) {
    if (bin.startsWith("/") && !fs.existsSync(bin)) continue;
    const out = await run(bin, ["status", "--json"]);
    if (!out) continue;
    try {
      const j = JSON.parse(out);
      if (j.BackendState && j.BackendState !== "Running") break;
      const ip = (j.Self?.TailscaleIPs || []).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
      if (ip) {
        const dns = String(j.Self?.DNSName || "").replace(/\.$/, "");
        value = { ip, dnsName: dns || null };
      }
    } catch {
      // not JSON: old CLI or not logged in
    }
    break;
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Hosts the server answers to (DNS-rebinding defense). */
export function allowedHosts(extra = []) {
  const set = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  for (const h of extra) if (h) set.add(h.toLowerCase());
  for (const h of String(process.env.AUSTERE_AXI_ALLOWED_HOSTS || "").split(/\s+/)) if (h) set.add(h.toLowerCase());
  return set;
}

export function hostOnly(hostHeader) {
  const h = String(hostHeader || "").toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

export function isLoopback(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
