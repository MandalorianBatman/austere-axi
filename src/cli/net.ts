// Network binding. Loopback always; plus this machine's Tailscale IPv4 when
// Tailscale is up, so the review link opens on a phone on the same tailnet.
// Never 0.0.0.0: the server can read local files, so only trusted networks.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

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
/** The `tailscale` CLI that answered the last status check: whois asks the same one, never another on the list. */
let tailscaleBin: string | null = null;

function tailscaleOff(): boolean {
  return /^(1|true|yes)$/i.test(process.env.AUSTERE_AXI_NO_TAILSCALE || "");
}

function run(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 2500, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

export async function detectTailscale({
  fresh = false,
}: { fresh?: boolean } = {}): Promise<Tailnet | null> {
  if (tailscaleOff()) return null;
  if (!fresh && Date.now() - cache.at < 30_000) return cache.value;
  let value: Tailnet | null = null;
  let found: string | null = null;
  for (const bin of CANDIDATES) {
    if (bin.startsWith("/") && !fs.existsSync(bin)) continue;
    const out = await run(bin, ["status", "--json"]);
    if (!out) continue;
    found = bin;
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
  tailscaleBin = value ? found : null;
  return value;
}

/** The parts of `tailscale status --json` read here. */
interface TailscaleStatus {
  BackendState?: string;
  Self?: { TailscaleIPs?: string[]; DNSName?: string };
}

/** A person Tailscale vouches for: the login, display name and device behind a tailnet address. */
export interface TailscalePerson {
  login: string;
  name: string;
  /** The device's name on the tailnet ("" when Tailscale gives none). */
  device: string;
}

/** The parts of `tailscale whois --json <ip>` read here. */
interface TailscaleWhois {
  Node?: {
    Name?: string;
    ComputedName?: string;
    Tags?: string[] | null;
    Hostinfo?: { Hostname?: string };
  };
  UserProfile?: { LoginName?: string; DisplayName?: string };
}

/**
 * The person `tailscale whois --json` names, or null: no answer, not JSON, or a tagged device
 * (a server or a CI runner: tagged devices belong to no person, and Tailscale calls their
 * user "tagged-devices").
 */
export function parseWhois(out: string | null): TailscalePerson | null {
  if (!out) return null;
  let j: TailscaleWhois;
  try {
    j = JSON.parse(out) as TailscaleWhois;
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || j.Node?.Tags?.length) return null;
  const login = String(j.UserProfile?.LoginName || "")
    .trim()
    .slice(0, 200);
  if (!login || login === "tagged-devices") return null;
  const name =
    String(j.UserProfile?.DisplayName || "")
      .trim()
      .slice(0, 200) || login;
  const device = String(
    j.Node?.ComputedName ||
      j.Node?.Hostinfo?.Hostname ||
      String(j.Node?.Name || "").split(".")[0] ||
      "",
  )
    .trim()
    .slice(0, 200);
  return { login, name, device };
}

/** How long one address's whois answer is kept, a failure included. */
export const WHOIS_TTL_MS = 60_000;
const whoisCache = new Map<string, { at: number; value: Promise<TailscalePerson | null> }>();

/**
 * Who Tailscale says is behind tailnet address `addr`: ask only with the address of a socket
 * accepted on the tailnet listener, never one a header names. Null when Tailscale is off for this
 * server, not running, missing, failing, or the device is tagged: the caller is then unknown,
 * which is not an error. Each address is asked at most once a minute.
 */
export function whoIs(addr: string | undefined): Promise<TailscalePerson | null> {
  const ip = String(addr || "").replace(/^::ffff:/, "");
  const bin = tailscaleBin;
  if (tailscaleOff() || !bin || !net.isIP(ip)) return Promise.resolve(null);
  const now = Date.now();
  const hit = whoisCache.get(ip);
  if (hit && now - hit.at < WHOIS_TTL_MS) return hit.value;
  const value = run(bin, ["whois", "--json", ip]).then(parseWhois);
  whoisCache.delete(ip);
  whoisCache.set(ip, { at: now, value });
  // A tailnet has a bounded number of peers; keep the newest answers only.
  if (whoisCache.size > 512) whoisCache.delete(whoisCache.keys().next().value as string);
  return value;
}

/** An address in Tailscale's ranges: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(addr: string): boolean {
  const ip = addr.replace(/^::ffff:/, "").toLowerCase();
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return /^fd7a:115c:a1e0:/.test(ip);
}

/** An address of this machine on a local network, for Settings → Network → Local network. */
export interface LanAddress {
  address: string;
  /** The network interface it is on, e.g. `en0`, `wlan0`. */
  iface: string;
}

/**
 * The addresses this machine has on local networks: not loopback, not Tailscale's, not
 * link-local IPv6 (which needs a zone to be reached). The local-network listener binds to one of these only.
 */
export function lanAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, list] of Object.entries(interfaces)) {
    if (/^tailscale/i.test(iface)) continue;
    for (const a of list ?? []) {
      if (a.internal || isTailscaleAddress(a.address)) continue;
      if (a.family === "IPv6" && /^fe80:/i.test(a.address)) continue;
      out.push({ address: a.address, iface });
    }
  }
  return out;
}

/** Hosts the server answers to (DNS-rebinding defense). */
export function allowedHosts(extra: (string | null | undefined)[] = []): Set<string> {
  const set = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  for (const h of extra) if (h) set.add(h.toLowerCase());
  for (const h of String(process.env.AUSTERE_AXI_ALLOWED_HOSTS || "").split(/\s+/))
    if (h) set.add(h.toLowerCase());
  return set;
}

/**
 * The variables that set the addresses a server answers to and prints. /api/health reports
 * them, so a CLI that replaces the server starts the new one with the same ones, not with
 * whatever its own caller's environment says (RLM-311).
 */
export const ADDRESS_ENV = {
  linkUrl: "AUSTERE_AXI_LINK_URL",
  linkHost: "AUSTERE_AXI_LINK_HOST",
  allowedHosts: "AUSTERE_AXI_ALLOWED_HOSTS",
} as const;

/** The ADDRESS_ENV values a server runs with; a key is missing when its variable is unset. */
export type AddressSettings = { -readonly [K in keyof typeof ADDRESS_ENV]?: string };

export function addressSettings(env: NodeJS.ProcessEnv = process.env): AddressSettings {
  const out: AddressSettings = {};
  for (const [key, name] of Object.entries(ADDRESS_ENV) as [keyof AddressSettings, string][])
    if (env[name]) out[key] = env[name];
  return out;
}

/** `env` with the ADDRESS_ENV variables set to `settings`: each one the settings lack is removed. */
export function withAddressSettings(
  env: NodeJS.ProcessEnv,
  settings: AddressSettings,
): NodeJS.ProcessEnv {
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
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`AUSTERE_AXI_LINK_URL must be http or https: ${raw}`);
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    throw new Error(
      `AUSTERE_AXI_LINK_URL must be just scheme, host and optional port, like https://austere.example.com: ${raw}`,
    );
  // A host name of letters, digits, dots, hyphens and underscores (an IDN is already punycode here),
  // or a bracketed IPv6 address. WHATWG URL keeps `$`, backticks, `&` and `;` in a host; the url goes
  // into a unit and into commands printed for the owner to paste, where a shell would run them.
  if (!/^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])$/i.test(u.hostname))
    throw new Error(
      `AUSTERE_AXI_LINK_URL host may hold only letters, digits, dots, hyphens and underscores: ${raw}`,
    );
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
