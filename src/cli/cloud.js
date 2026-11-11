// @ts-check
// `publish`: hosted share links on austere-cloud (docs/hosted-share-links.md).
// This is the only module that talks to the service, and only `publish` imports it.
//
// State: <state>/cloud.json (mode 0600)
//   { url, token, pages: { "<absolute path>": { id, auto, cursor } } }
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { readArtifact, rewriteRuntime } from "./artifact.js";
import { VERSION, stateDir } from "./paths.js";
import { bundledPacks, implicitPacks, pagePacks } from "./packs.js";

export const DEFAULT_CLOUD_URL = "https://austere.kasat.xyz";

/** Page ids are 16 random bytes, base64url. */
export const PAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function cloudUrl() {
  return (process.env.AUSTERE_AXI_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/+$/, "");
}

export function cloudFile() {
  return path.join(stateDir(), "cloud.json");
}

/** @typedef {{ id: string, auto: boolean, cursor: number }} PageEntry */
/** @typedef {{ url: string, token: string, pages: Record<string, PageEntry> }} CloudState */

/** @returns {CloudState} */
export function readCloud() {
  try {
    const raw = JSON.parse(fs.readFileSync(cloudFile(), "utf8"));
    return {
      url: typeof raw.url === "string" ? raw.url : "",
      token: typeof raw.token === "string" ? raw.token : "",
      pages: raw.pages && typeof raw.pages === "object" && !Array.isArray(raw.pages) ? raw.pages : {},
    };
  } catch {
    return { url: "", token: "", pages: {} };
  }
}

/** @param {CloudState} state */
export function writeCloud(state) {
  const file = cloudFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class CloudError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The state for the current service URL. A token belongs to one service, so another URL is an error, not a silent mix. */
function stateFor(url) {
  const state = readCloud();
  if (state.token && state.url && state.url !== url) {
    throw new CloudError(
      `${cloudFile()} holds an owner token for ${state.url}, not ${url}. Set AUSTERE_AXI_CLOUD_URL=${state.url}, or use another AUSTERE_AXI_STATE_DIR for ${url}.`,
    );
  }
  state.url = url;
  return state;
}

// ── bundling ──

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

// A relative image path inside a string or a Markdown link: "a/b.png", 'x.svg', ](shot.jpg).
// No scheme (http:, data:), no leading / or #, no quotes, parentheses or whitespace.
const REL_IMAGE_RE = /(?<=["'(])(?![A-Za-z][A-Za-z0-9+.-]*:|[/#\\])[^"'()\s]+?\.(?:png|jpe?g|gif|webp|svg|avif)(?=["')])/gi;

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The data: URL for an image beside the page, held to the rule the local server serves by: the page's own directory, no dotfiles. */
function imageDataUrl(dir, rel) {
  const target = path.resolve(dir, rel);
  const inside = path.relative(dir, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || inside.split(/[\\/]/).some((seg) => seg.startsWith("."))) {
    throw new CloudError(`image ${rel} is outside the page's folder (or a dotfile); publish inlines only images beside the page`);
  }
  let data;
  try {
    data = fs.readFileSync(target);
  } catch {
    throw new CloudError(`image ${rel} not found next to the page (${target})`);
  }
  return `data:${IMAGE_TYPES[path.extname(target).toLowerCase()]};base64,${data.toString("base64")}`;
}

/**
 * What `publish` uploads for a page: runtime tags rewritten to the service's
 * pinned runtime, installed packs as content-addressed blobs, relative images
 * inlined. Everything else stays byte for byte.
 * @param {string} abs absolute path of the page
 * @param {string} html its contents
 * @param {string} [version] the CLI version the service serves the runtime for
 * @returns {{ html: string, title: string, packs: { sha256: string, name: string, version: string, code: string }[], images: number }}
 */
export function bundlePage(abs, html, version = VERSION) {
  const art = readArtifact(html);
  if (art.program == null) throw new CloudError('no <script type="text/openui"> block');

  const bundledNames = new Set(bundledPacks().map((p) => p.name));
  const pp = pagePacks(html);
  const problems = [
    ...pp.missing.filter((p) => !bundledNames.has(p.name)).map((p) => `${p.name}@${p.version} is not installed (austere-axi components add ${p.name}@${p.version})`),
    ...pp.mismatched.map((p) => `${p.name}@${p.version} is declared, but ${p.installedVersion} is installed (austere-axi check --fix)`),
    ...pp.stale.map((p) => `${p.name}@${p.version}: the installed build does not match the page's hash (austere-axi check --fix)`),
  ];
  if (problems.length) throw new CloudError(`the hosted page cannot load its packs from a CDN: ${problems.join("; ")}`);

  // Images first: only inside the program, so offsets are the ones readArtifact found.
  const dir = path.dirname(abs);
  const urls = new Map();
  const program = art.program.replace(REL_IMAGE_RE, (rel) => {
    if (!urls.has(rel)) urls.set(rel, imageDataUrl(dir, rel));
    return urls.get(rel);
  });
  const withImages = html.slice(0, art.programStart) + program + html.slice(art.programEnd);

  // Same order as export: Mermaid, the runtime, then packs (they register with the runtime).
  const rt = `/rt/${version}`;
  const tags = [];
  if (/\bMermaid\s*\(/.test(art.program)) tags.push(`${rt}/mermaid.min.js`);
  tags.push(`${rt}/austere.js`);
  for (const p of implicitPacks(art.program)) tags.push(`${rt}/packs/${p.id}.js`);
  const packs = pp.installed.map((p) => {
    const code = fs.readFileSync(path.join(p.dir, "pack.js"), "utf8");
    return { sha256: sha256(code), name: p.name, version: p.version, code };
  });
  for (const p of packs) tags.push(`/pk/${p.sha256}.js`);

  const out = rewriteRuntime(
    withImages,
    tags.map((src) => `<script src="${src}"></script>`).join("\n"),
  );
  return { html: out, title: art.title || path.basename(abs), packs, images: urls.size };
}

// ── HTTP ──

/**
 * @param {string} base service URL
 * @param {string} method
 * @param {string} route
 * @param {{ token?: string, body?: any }} [opts]
 * @returns {Promise<any>} the JSON body, or null for 204
 */
async function call(base, method, route, { token, body } = {}) {
  /** @type {Record<string, string>} */
  const headers = { accept: "application/json", "user-agent": `austere-axi/${VERSION}` };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = zlib.gzipSync(JSON.stringify(body));
    headers["content-type"] = "application/json";
    headers["content-encoding"] = "gzip";
  }
  let res;
  try {
    res = await fetch(base + route, { method, headers, body: payload, redirect: "error" });
  } catch (err) {
    throw new CloudError(`could not reach ${base}: ${err?.cause?.message || err?.message || err}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = data && typeof data.error === "string" ? data.error : text.trim().slice(0, 200) || res.statusText;
    throw new CloudError(`${base} answered ${res.status}: ${msg}`, res.status);
  }
  return data;
}

/** The owner token, created on first use and saved before anything else can fail. */
async function ensureToken(state) {
  if (state.token) return state.token;
  const data = await call(state.url, "POST", "/api/owners");
  if (!data || typeof data.token !== "string") throw new CloudError(`${state.url} did not return an owner token`);
  state.token = data.token;
  writeCloud(state);
  return state.token;
}

// ── commands ──

/**
 * Upload (or republish) a page.
 * @param {string} abs canonical absolute path
 * @param {{ auto?: boolean, fresh?: boolean }} opts fresh: a new link even when the file has one
 */
export async function publish(abs, { auto = false, fresh = false } = {}) {
  const url = cloudUrl();
  const state = stateFor(url);
  const bundle = bundlePage(abs, fs.readFileSync(abs, "utf8"));
  const token = await ensureToken(state);
  const body = { cliVersion: VERSION, title: bundle.title, html: bundle.html, packs: bundle.packs, auto };
  const prev = fresh ? null : state.pages[abs];
  let data;
  if (prev) {
    try {
      data = await call(url, "PUT", `/api/pages/${encodeURIComponent(prev.id)}`, { token, body });
    } catch (err) {
      if (err instanceof CloudError && err.status === 404) {
        throw new CloudError(`the hosted page for this file (${prev.id}) is gone from ${url}: it expired or was deleted. publish --new makes a new link.`, 404);
      }
      throw err;
    }
  } else {
    data = await call(url, "POST", "/api/pages", { token, body });
  }
  if (!data || typeof data.id !== "string" || typeof data.url !== "string") throw new CloudError(`${url} returned no page id`);
  const sameId = prev && prev.id === data.id;
  state.pages[abs] = { id: data.id, auto, cursor: sameId ? prev.cursor || 0 : 0 };
  writeCloud(state);
  return { updated: Boolean(sameId), id: data.id, url: data.url, expiresAt: data.expiresAt, auto, packs: bundle.packs.length, images: bundle.images };
}

/** The owner's live pages, with the local file each came from. Without a token there is nothing to ask for. */
export async function listPages() {
  const url = cloudUrl();
  const state = stateFor(url);
  if (!state.token) return [];
  const data = await call(url, "GET", "/api/pages", { token: state.token });
  const fileOf = new Map(Object.entries(state.pages).map(([file, e]) => [e.id, file]));
  return (data?.pages || []).map((p) => ({ ...p, file: fileOf.get(p.id) }));
}

/**
 * Delete a hosted page now.
 * @param {string} key a page id, or a published file's canonical path
 * @returns {Promise<{ id: string, file?: string, gone: boolean }>} gone: the service no longer had it
 */
export async function removePage(key) {
  const url = cloudUrl();
  const state = stateFor(url);
  let file = state.pages[key] ? key : undefined;
  const id = file ? state.pages[file].id : key;
  if (!file) file = Object.keys(state.pages).find((f) => state.pages[f].id === id);
  if (!file && !PAGE_ID_RE.test(id)) throw new CloudError(`${key} is not a published file or a page id (see austere-axi publish list)`);
  if (!state.token) throw new CloudError("nothing has been published from this machine");
  let gone = false;
  try {
    await call(url, "DELETE", `/api/pages/${encodeURIComponent(id)}`, { token: state.token });
  } catch (err) {
    if (!(err instanceof CloudError && err.status === 404)) throw err;
    gone = true;
  }
  if (file) {
    delete state.pages[file];
    writeCloud(state);
  }
  if (gone && !file) throw new CloudError(`no page ${id} of yours on ${url}`, 404);
  return { id, file, gone };
}
