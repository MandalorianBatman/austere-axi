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

/** This machine on the tailnet: its IPv4 and, when it has one, its MagicDNS name. */
export interface Tailnet {
  ip: string;
  dnsName: string | null;
}

let cache: { at: number; value: Tailnet | null } = { at: 0, value: null };

function run(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 2500, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function detectTailscale({ fresh = false }: { fresh?: boolean } = {}): Promise<Tailnet | null> {
  if (/^(1|true|yes)$/i.test(process.env.AUSTERE_AXI_NO_TAILSCALE || "")) return null;
  if (!fresh && Date.now() - cache.at < 30_000) return cache.value;
  let value: Tailnet | null = null;
  for (const bin of CANDIDATES) {
    if (bin.startsWith("/") && !fs.existsSync(bin)) continue;
    const out = await run(bin, ["status", "--json"]);
    if (!out) continue;
    try {
      const j = JSON.parse(out) as TailscaleStatus;
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

/** The parts of `tailscale status --json` read here. */
interface TailscaleStatus {
  BackendState?: string;
  Self?: { TailscaleIPs?: string[]; DNSName?: string };
}

/** Hosts the server answers to (DNS-rebinding defense). */
export function allowedHosts(extra: (string | null | undefined)[] = []): Set<string> {
  const set = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  for (const h of extra) if (h) set.add(h.toLowerCase());
  for (const h of String(process.env.AUSTERE_AXI_ALLOWED_HOSTS || "").split(/\s+/)) if (h) set.add(h.toLowerCase());
  return set;
}

/**
 * The variables that set the addresses a server answers to and prints. /api/health reports
 * them, so a CLI that replaces the server starts the new one with the same ones, not with
 * whatever its own caller's environment says (RLM-311).
 */
export const ADDRESS_ENV = { linkUrl: "AUSTERE_AXI_LINK_URL", linkHost: "AUSTERE_AXI_LINK_HOST", allowedHosts: "AUSTERE_AXI_ALLOWED_HOSTS" } as const;

/** The ADDRESS_ENV values a server runs with; a key is missing when its variable is unset. */
export type AddressSettings = { -readonly [K in keyof typeof ADDRESS_ENV]?: string };

export function addressSettings(env: NodeJS.ProcessEnv = process.env): AddressSettings {
  const out: AddressSettings = {};
  for (const [key, name] of Object.entries(ADDRESS_ENV) as [keyof AddressSettings, string][]) if (env[name]) out[key] = env[name];
  return out;
}

/** `env` with the ADDRESS_ENV variables set to `settings`: each one the settings lack is removed. */
export function withAddressSettings(env: NodeJS.ProcessEnv, settings: AddressSettings): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const [key, name] of Object.entries(ADDRESS_ENV) as [keyof AddressSettings, string][]) {
    const value = settings[key];
    if (value) out[name] = value;
    else delete out[name];
  }
  return out;
}

/**
 * AUSTERE_AXI_LINK_URL: the address a reviewer reaches this server at when something in front of it
 * (a reverse proxy with TLS, say) changes the scheme, host or port, e.g. `https://austere.example.com`.
 * Returns it without a trailing slash, or null when unset. Throws on a value that is not a plain http(s) origin
 * (the server answers at the root only, so a path prefix would give links that redirect to the wrong place).
 */
export function linkUrl(): { base: string; host: string } | null {
  return parseLinkUrl(String(process.env.AUSTERE_AXI_LINK_URL || ""));
}

/** linkUrl() for a value given some other way (`server install --link-url`). */
export function parseLinkUrl(value: string): { base: string; host: string } | null {
  const raw = value.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`AUSTERE_AXI_LINK_URL is not a URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`AUSTERE_AXI_LINK_URL must be http or https: ${raw}`);
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new Error(`AUSTERE_AXI_LINK_URL must be just scheme, host and optional port, like https://austere.example.com: ${raw}`);
  // A host name of letters, digits, dots, hyphens and underscores (an IDN is already punycode here),
  // or a bracketed IPv6 address. WHATWG URL keeps `$`, backticks, `&` and `;` in a host; the url goes
  // into a unit and into commands printed for the owner to paste, where a shell would run them.
  if (!/^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])$/i.test(u.hostname)) throw new Error(`AUSTERE_AXI_LINK_URL host may hold only letters, digits, dots, hyphens and underscores: ${raw}`);
  return { base: u.origin, host: u.hostname.toLowerCase() };
}

export function hostOnly(hostHeader: string | undefined): string {
  const h = String(hostHeader || "").toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

export function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
