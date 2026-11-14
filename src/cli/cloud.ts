// `publish`: hosted share links on austere-cloud (docs/hosted-share-links.md). The only module
// that talks to the service, and only `publish` calls it.
//
// A publish uploads the page HTML and its packs as SHA-256-addressed objects, then sends the
// `publish` mutation over the owner socket. Frames, mutations and rows come from the shared
// schema module (src/shared/sync.ts); nothing here redefines them.
//
// State: <state>/cloud.json (mode 0600)
//   { url, token, pages: { "<absolute path>": { id, auto } } }
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import WebSocket from "ws";
import { readArtifact, rewriteRuntime } from "./artifact.ts";
import { inlineImages } from "./export.ts";
import { VERSION, stateDir } from "./paths.ts";
import { bundledPacks, implicitPacks, pagePacks } from "./packs.ts";
import { SYNC_VERSION, mutation, parseServerFrame, syncProtocols } from "../shared/sync.ts";
import type { MutationArgs, MutationName, PackRef, PageRow, PullFrame, ReceivedFrame, SyncError } from "../shared/sync.ts";

export const DEFAULT_CLOUD_URL = "https://austere.kasat.xyz";

/** Page ids are 16 random bytes, base64url. */
export const PAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** How long one socket exchange (handshake to the answer) may take. */
const SOCKET_TIMEOUT_MS = 30_000;

export function cloudUrl(): string {
  return (process.env.AUSTERE_AXI_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/+$/, "");
}

export function cloudFile(): string {
  return path.join(stateDir(), "cloud.json");
}

export interface PageEntry {
  id: string;
  auto: boolean;
}

export interface CloudState {
  url: string;
  token: string;
  pages: Record<string, PageEntry>;
}

/** cloud.json as written by writeCloud; anything malformed is dropped rather than trusted. */
export function readCloud(): CloudState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(cloudFile(), "utf8"));
  } catch {
    // none yet, or unreadable: start empty
  }
  const state: CloudState = { url: "", token: "", pages: {} };
  if (!raw || typeof raw !== "object") return state;
  if ("url" in raw && typeof raw.url === "string") state.url = raw.url;
  if ("token" in raw && typeof raw.token === "string") state.token = raw.token;
  const pages = "pages" in raw && raw.pages && typeof raw.pages === "object" ? raw.pages : {};
  for (const [file, e] of Object.entries(pages)) {
    if (e && typeof e === "object" && "id" in e && typeof e.id === "string") state.pages[file] = { id: e.id, auto: "auto" in e && e.auto === true };
  }
  return state;
}

export function writeCloud(state: CloudState): void {
  const file = cloudFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class CloudError extends Error {
  status: number | undefined;
  code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The state for the current service URL. A token belongs to one service, so another URL is an error, not a silent mix. */
function stateFor(url: string): CloudState {
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

export interface UploadPack extends PackRef {
  code: string;
}

export interface Bundle {
  html: string;
  /** SHA-256 (hex) of the UTF-8 html: the object the `publish` mutation names. */
  sha256: string;
  title: string;
  packs: UploadPack[];
  images: number;
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * What `publish` uploads for a page: the runtime tag pointed at the service's pinned runtime,
 * bundled packs tagged from there too, installed packs as content-addressed objects, and relative
 * images inlined by the rules `export` uses. Everything else stays byte for byte.
 * @param abs absolute path of the page
 * @param version the CLI version the service serves the runtime for
 */
export function bundlePage(abs: string, html: string, version = VERSION): Bundle {
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

  // A hosted page has no folder to read images from: an image that cannot be inlined is an error.
  const skipped: string[] = [];
  const images = inlineImages(art.program, path.dirname(abs), (src, why) => skipped.push(`${src} (${why})`));
  if (skipped.length) throw new CloudError(`images the hosted page could not show: ${[...new Set(skipped)].join("; ")}`);
  const withImages = html.slice(0, art.programStart) + images.program + html.slice(art.programEnd);

  // The runtime, then packs: they register with it. Bundled packs need a tag because the
  // service allow-lists /rt/<v>/packs/<id>.js, not the runtime's own packs/<id>/pack.js.
  const rt = `/rt/${version}`;
  const srcs = [`${rt}/austere.js`, ...implicitPacks(art.program).map((p) => `${rt}/packs/${p.id}.js`)];
  const packs = pp.installed.map((p) => {
    const code = fs.readFileSync(path.join(p.dir, "pack.js"), "utf8");
    return { sha256: sha256Hex(code), name: p.name, version: p.version, code };
  });
  for (const p of packs) srcs.push(`/pk/${p.sha256}.js`);

  const out = rewriteRuntime(withImages, () => srcs.map((src) => `<script src="${src}"></script>`).join("\n"));
  return { html: out, sha256: sha256Hex(out), title: art.title || path.basename(abs), packs, images: images.inlined };
}

// ── HTTP ──

/** The service's message from an error body: `{ error: "…" }` (HTTP routes) or `{ error: { code, message } }` (handshakes). */
function errorOf(text: string, fallback: string): { message: string; code?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON: the text itself
  }
  const error = data && typeof data === "object" && "error" in data ? data.error : undefined;
  if (typeof error === "string") return { message: error };
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return { message: error.message, code: "code" in error && typeof error.code === "string" ? error.code : undefined };
  }
  return { message: text.trim().slice(0, 200) || fallback };
}

interface CallOptions {
  token?: string;
  json?: unknown;
  /** A raw body (an object upload), with its content type. */
  body?: { type: string; data: string };
}

async function call<T>(base: string, method: string, route: string, opts: CallOptions = {}): Promise<T | null> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": `austere-axi/${VERSION}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let payload: BodyInit | undefined;
  if (opts.json !== undefined) {
    payload = JSON.stringify(opts.json);
    headers["content-type"] = "application/json";
  } else if (opts.body) {
    payload = zlib.gzipSync(Buffer.from(opts.body.data, "utf8"));
    headers["content-type"] = opts.body.type;
    headers["content-encoding"] = "gzip";
  }
  let res: Response;
  try {
    res = await fetch(base + route, { method, headers, body: payload, redirect: "error" });
  } catch (caught) {
    const err = caught as { message?: string; cause?: { message?: string } };
    throw new CloudError(`could not reach ${base}: ${err.cause?.message || err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const e = errorOf(text, res.statusText);
    throw new CloudError(`${base} answered ${res.status}: ${e.message}`, res.status, e.code);
  }
  return text ? (JSON.parse(text) as T) : null;
}

/** The owner token, created on first use and saved before anything else can fail. */
async function ensureToken(state: CloudState): Promise<string> {
  if (state.token) return state.token;
  const data = await call<{ token?: unknown }>(state.url, "POST", "/api/owners");
  if (!data || typeof data.token !== "string") throw new CloudError(`${state.url} did not return an owner token`);
  state.token = data.token;
  writeCloud(state);
  return state.token;
}

// ── owner socket ──

/** A one-shot owner session: send one mutation, wait for its ack; optionally pull and return the page row. */
async function sendMutation<N extends MutationName>(
  base: string,
  token: string,
  id: string,
  name: N,
  args: MutationArgs[N],
  { pullPage = false } = {},
): Promise<PageRow | null> {
  const url = `${base.replace(/^http/, "ws")}/api/pages/${encodeURIComponent(id)}/sync?cli=${encodeURIComponent(VERSION)}`;
  // A one-shot command makes a fresh clientId per run (docs: Idempotency), so n is always 1.
  const key = { clientId: crypto.randomBytes(16).toString("base64url"), n: 1 };
  const frame = mutation(name, args, key);
  const { promise, resolve, reject } = Promise.withResolvers<PageRow | null>();
  const ws = new WebSocket(url, syncProtocols({ owner: token }), { headers: { "user-agent": `austere-axi/${VERSION}` }, followRedirects: false });
  let settled = false;
  let acked = false;
  let page: PageRow | null = null;
  const finish = (err: Error | null, value: PageRow | null = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ws.removeAllListeners("close");
    ws.on("error", () => {}); // a late error while closing is not ours to report
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    // After the ack the mutation is applied: a failure reading the page row back only loses the expiry,
    // and the caller must still record the page.
    if (err && !acked) reject(err);
    else resolve(value ?? page);
  };
  const timer = setTimeout(() => finish(new CloudError(`${base} did not answer ${name} within ${SOCKET_TIMEOUT_MS / 1000}s`)), SOCKET_TIMEOUT_MS);
  const failWith = (e: SyncError, where: string) => {
    const retry = e.retryAfter !== undefined ? ` (retry after ${e.retryAfter}s)` : "";
    finish(new CloudError(`${base} rejected ${where}: ${e.code}: ${e.message}${retry}`, undefined, e.code));
  };

  // A refused handshake is a plain HTTP response: its status and `{ error: { code, message } }`.
  ws.on("unexpected-response", (_req, res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => (text += c));
    res.on("end", () => {
      const e = errorOf(text, res.statusMessage || "");
      finish(new CloudError(`${base} answered ${res.statusCode}: ${e.message}`, res.statusCode, e.code));
    });
  });
  ws.on("error", (err) => finish(new CloudError(`could not reach ${base}: ${err.message}`)));
  ws.on("close", (code, reason) => {
    finish(new CloudError(`${base} closed the connection (${code}${reason.length ? `: ${reason.toString()}` : ""}) before answering ${name}`));
  });
  ws.on("open", () => ws.send(JSON.stringify(frame)));
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const parsed = parseServerFrame(data.toString());
    if (!parsed.ok) return failWith(parsed.error, "a frame from the service");
    const f: ReceivedFrame | null = parsed.value;
    if (!f) return; // a frame type this version does not know
    if (f.t === "error") return failWith(f, name);
    if (f.t === "ack") {
      if (f.clientId !== key.clientId || f.n !== key.n) return;
      if (f.error) return failWith(f.error, name);
      acked = true;
      if (!pullPage) return finish(null);
      // The ack only says applied; the page row (expiry) arrives in the change feed.
      const pull: PullFrame = { v: SYNC_VERSION, t: "pull", after: 0 };
      ws.send(JSON.stringify(pull));
      return;
    }
    if (f.t === "changes" && acked) {
      for (const row of f.rows) if (row.type === "page" && row.id === id) page = row;
      if (!f.more) finish(null, page);
    }
  });
  return promise;
}

// ── commands ──

export interface Published {
  updated: boolean;
  id: string;
  url: string;
  expiresAt: number | null;
  auto: boolean;
  packs: number;
  images: number;
}

/**
 * Upload (or republish) a page.
 * @param abs canonical absolute path
 * @param fresh a new link even when the file has one
 */
export async function publish(abs: string, { auto = false, fresh = false } = {}): Promise<Published> {
  const base = cloudUrl();
  const state = stateFor(base);
  // Everything that can fail locally fails before the first request.
  const bundle = bundlePage(abs, fs.readFileSync(abs, "utf8"));
  const token = await ensureToken(state);

  await call(base, "PUT", `/api/objects/${bundle.sha256}`, { token, body: { type: "text/html; charset=utf-8", data: bundle.html } });
  for (const p of bundle.packs) await call(base, "PUT", `/api/objects/${p.sha256}`, { token, body: { type: "text/javascript; charset=utf-8", data: p.code } });

  const prev = fresh ? undefined : state.pages[abs];
  let id = prev?.id;
  let url = id ? `${base}/p/${id}` : "";
  if (!id) {
    const created = await call<{ id?: unknown; url?: unknown }>(base, "POST", "/api/pages", { token });
    if (!created || typeof created.id !== "string" || !PAGE_ID_RE.test(created.id)) throw new CloudError(`${base} returned no page id`);
    id = created.id;
    url = typeof created.url === "string" ? created.url : `${base}/p/${id}`;
  }

  const args: MutationArgs["publish"] = {
    title: bundle.title,
    cliVersion: VERSION,
    html: bundle.sha256,
    packs: bundle.packs.map(({ sha256, name, version }) => ({ sha256, name, version })),
    auto,
    // Invite-only and presence-on are the defaults (Q16, Q17); their flags come with the access and presence tickets.
    unlisted: false,
    presence: true,
  };
  let row: PageRow | null;
  try {
    row = await sendMutation(base, token, id, "publish", args, { pullPage: true });
  } catch (err) {
    if (prev && err instanceof CloudError && err.status === 404) {
      throw new CloudError(`the hosted page for this file (${prev.id}) is gone from ${base}: it expired or was deleted. publish --new makes a new link.`, 404);
    }
    throw err;
  }
  state.pages[abs] = { id, auto };
  writeCloud(state);
  return { updated: !!prev, id, url, expiresAt: row ? row.expiresAt : null, auto, packs: bundle.packs.length, images: bundle.images };
}

export interface ListedPage {
  id: string;
  title: string;
  url: string;
  expiresAt: number;
  notes: number;
  file?: string;
}

/** The owner's live pages, with the local file each came from. Without a token there is nothing to ask for. */
export async function listPages(): Promise<ListedPage[]> {
  const base = cloudUrl();
  const state = stateFor(base);
  if (!state.token) return [];
  const data = await call<{ pages?: ListedPage[] }>(base, "GET", "/api/pages", { token: state.token });
  const fileOf = new Map(Object.entries(state.pages).map(([file, e]) => [e.id, file]));
  return (data?.pages || []).map((p) => ({ ...p, file: fileOf.get(p.id) }));
}

/**
 * Delete a hosted page now, with the `delete` mutation.
 * @param key a page id, or a published file's canonical path
 * @returns gone: the service no longer had it
 */
export async function removePage(key: string): Promise<{ id: string; file?: string; gone: boolean }> {
  const base = cloudUrl();
  const state = stateFor(base);
  let file = state.pages[key] ? key : undefined;
  const id = file ? state.pages[key].id : key;
  if (!file) file = Object.keys(state.pages).find((f) => state.pages[f].id === id);
  if (!file && !PAGE_ID_RE.test(id)) throw new CloudError(`${key} is not a published file or a page id (see austere-axi publish list)`);
  if (!state.token) throw new CloudError("nothing has been published from this machine");
  let gone = false;
  try {
    await sendMutation(base, state.token, id, "delete", {});
  } catch (err) {
    if (!(err instanceof CloudError && (err.status === 404 || err.status === 410))) throw err;
    gone = true;
  }
  if (file) {
    delete state.pages[file];
    writeCloud(state);
  }
  if (gone && !file) throw new CloudError(`no page ${id} of yours on ${base}`, 404);
  return { id, file, gone };
}
