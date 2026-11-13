// Private registries for npm scopes, <state>/registries.json: packs under a
// mapped scope ("@acme") are searched for, read and installed from that
// registry, with a bearer token read from an environment variable the file
// names. The file never holds a token. Only this user-level file is read,
// never one in a project. Mapping a scope grants no trust: its packs stay
// third-party unless the trust list names them on this registry.
import fs from "node:fs";
import path from "node:path";
import { TRUSTED_SCOPE, writeJsonAtomic } from "./packs.ts";
import { stateDir } from "./paths.ts";
import { isScope } from "./trust.ts";

/** Where a pack's registry requests go: a mapped scope's registry, or the default one (scope null). */
export interface Registry {
  scope: string | null;
  /** Ends with "/". */
  url: string;
  /** The environment variable holding a bearer token for this registry. */
  tokenEnv?: string;
}

/** registries.json: each mapped scope's registry, by scope. */
export type Registries = Map<string, Registry & { scope: string }>;

const FORMAT = 1;
const TOKEN_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function registriesFile(): string {
  return path.join(stateDir(), "registries.json");
}

/** AUSTERE_AXI_NPM_REGISTRY, else npm's configured registry, else npmjs. */
export function defaultRegistry(): Registry {
  const r = process.env.AUSTERE_AXI_NPM_REGISTRY || process.env.npm_config_registry || "https://registry.npmjs.org/";
  return { scope: null, url: r.endsWith("/") ? r : r + "/" };
}

/**
 * A scope's registry entry, checked; throws why it cannot be one. The URL is https (http only on
 * loopback) with no credentials, query or fragment, and gets a trailing slash. Messages never echo
 * the URL or the token variable, either of which may hold a token typed in the wrong place.
 */
export function registryEntry(scope: string, url: string, tokenEnv?: string): Registry & { scope: string } {
  if (!isScope(scope)) throw new Error(`${JSON.stringify(scope)} is not an npm scope like @acme`);
  if (`${scope}/` === TRUSTED_SCOPE) throw new Error(`${scope} is first-party: its packs always come from the default registry`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`the registry for ${scope} is not a URL`);
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new Error(`the registry URL for ${scope} must not carry credentials, a query or a fragment; name an environment variable that holds the token with --token-env`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error(`the registry for ${scope} must be https (http only on localhost)`);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  if (tokenEnv !== undefined && !TOKEN_ENV_RE.test(tokenEnv)) throw new Error(`the token variable for ${scope} must be the name of an environment variable, like ACME_NPM_TOKEN, not the token`);
  return tokenEnv === undefined ? { scope, url: u.href } : { scope, url: u.href, tokenEnv };
}

/** The mapped scopes; none when the file does not exist. A malformed file throws, naming it. */
export function readRegistries(): Registries {
  const file = registriesFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const bad = (why: string) => new Error(`${file} is malformed (${why}); ask the user to fix it`);
  let data: { format?: unknown; scopes?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("not an object");
  if (data.format !== FORMAT) throw bad(`format ${JSON.stringify(data.format)}; this austere-axi reads ${FORMAT}`);
  const { scopes = {} } = data;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) throw bad("scopes is not an object");
  const regs: Registries = new Map();
  for (const [scope, entry] of Object.entries(scopes)) {
    const { url, tokenEnv } = (entry || {}) as { url?: unknown; tokenEnv?: unknown };
    if (typeof url !== "string" || (tokenEnv !== undefined && typeof tokenEnv !== "string")) throw bad(`${scope} needs a url and, optionally, a tokenEnv name`);
    try {
      regs.set(scope, registryEntry(scope, url, tokenEnv));
    } catch (err) {
      throw bad((err as Error).message);
    }
  }
  return regs;
}

export function writeRegistries(regs: Registries): void {
  writeJsonAtomic(registriesFile(), { format: FORMAT, scopes: Object.fromEntries([...regs.values()].map(({ scope, url, tokenEnv }) => [scope, { url, tokenEnv }])) });
}

/** The registry a pack (or a bare "@scope") comes from: its scope's mapped registry, else the default one. */
export function registryFor(regs: Registries, name: string): Registry {
  return (name.startsWith("@") && regs.get(name.split("/")[0])) || defaultRegistry();
}

/** The Authorization header for a request to `url`: only to the registry's own origin, and only when its token variable is set. */
export function authHeaders(registry: Registry, url: string): Record<string, string> {
  const token = registry.tokenEnv && process.env[registry.tokenEnv];
  return token && new URL(url).origin === new URL(registry.url).origin ? { authorization: `Bearer ${token}` } : {};
}

/** The npm command that shows a pack's repository, pointed at a mapped registry. */
export function npmView(name: string, registry: Registry): string {
  return `npm view ${name} repository${registry.scope ? ` --registry ${registry.url}` : ""}`;
}
