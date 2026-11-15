// `publish`: hosted share links on austere-cloud (docs/hosted-share-links.md). The only module
// that talks to the service, and only `publish` calls it.
//
// A publish uploads the page HTML and its packs as SHA-256-addressed objects, then sends the
// `publish` mutation over the owner socket. Frames, mutations and rows come from the shared
// schema module (src/shared/sync.ts); nothing here redefines them.
//
// State: <state>/cloud.json (mode 0600)
//   { url, token, pages: { "<absolute path>": { id, auto, unlisted, presence, invites: { "<name>": { token, expiresAt, grantedAt } } } } }
// Invite tokens are kept so a republish or `publish invites` can print the same links; the service
// only ever sees their SHA-256.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import WebSocket from "ws";
import { readArtifact, rewriteRuntime } from "./artifact.ts";
import { inlineImages } from "./export.ts";
import { VERSION, stateDir } from "./paths.ts";
import { bundledPacks, implicitPacks, pagePacks } from "./packs.ts";
import { LIMITS, SYNC_VERSION, mutation, parseServerFrame, syncProtocols } from "../shared/sync.ts";
import type { AclRow, MutationArgs, MutationName, PackRef, PageRow, PullFrame, ReceivedFrame, Row, SyncError } from "../shared/sync.ts";

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

export interface InviteEntry {
  token: string;
  expiresAt: number | null;
  /** The service's `grantedAt` for the grant this token was sent in; null until a pull confirmed it. */
  grantedAt: number | null;
}

export interface PageEntry {
  id: string;
  auto: boolean;
  unlisted: boolean;
  presence: boolean;
  invites: Record<string, InviteEntry>;
}

/** An invite name: 1–40 UTF-16 units after trimming, the shared schema's `LIMITS.nameChars`. */
const MAX_INVITE_NAME = LIMITS.nameChars;
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

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
    if (!e || typeof e !== "object" || !("id" in e) || typeof e.id !== "string") continue;
    // Names are user text ("__proto__" included): a dictionary without a prototype stores any of them.
    const invites: Record<string, InviteEntry> = Object.create(null);
    const raw = "invites" in e && e.invites && typeof e.invites === "object" ? e.invites : {};
    for (const [name, i] of Object.entries(raw)) {
      if (!i || typeof i !== "object" || !("token" in i) || typeof i.token !== "string" || !INVITE_TOKEN_RE.test(i.token)) continue;
      const expiresAt = "expiresAt" in i && typeof i.expiresAt === "number" ? i.expiresAt : null;
      const grantedAt = "grantedAt" in i && typeof i.grantedAt === "number" ? i.grantedAt : null;
      invites[name] = { token: i.token, expiresAt, grantedAt };
    }
    state.pages[file] = {
      id: e.id,
      auto: "auto" in e && e.auto === true,
      unlisted: "unlisted" in e && e.unlisted === true,
      presence: !("presence" in e && e.presence === false),
      invites,
    };
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
  /** How many of a session's mutations were acked (applied) before it failed. */
  applied = 0;
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

type Send = { [N in MutationName]: { name: N; args: MutationArgs[N] } }[MutationName];

/**
 * A one-shot owner session: send `mutations` in order (n = 1, 2, …), wait for every ack, then
 * optionally pull and return the rows. Resolves to the pulled rows (empty without `pull`).
 * Once every mutation is acked they are applied: a failure while pulling still resolves, with
 * whatever rows arrived.
 */
async function ownerSession(base: string, token: string, id: string, mutations: Send[], { pull = false } = {}): Promise<Row[]> {
  const url = `${base.replace(/^http/, "ws")}/api/pages/${encodeURIComponent(id)}/sync?cli=${encodeURIComponent(VERSION)}`;
  // A one-shot command makes a fresh clientId per run (docs: Idempotency), so n counts from 1.
  const clientId = crypto.randomBytes(16).toString("base64url");
  const frames = mutations.map((m, i) => mutation(m.name, m.args as never, { clientId, n: i + 1 }));
  const what = mutations.length ? mutations.map((m) => m.name).join(", ") : "pull";
  const { promise, resolve, reject } = Promise.withResolvers<Row[]>();
  const ws = new WebSocket(url, syncProtocols({ owner: token }), { headers: { "user-agent": `austere-axi/${VERSION}` }, followRedirects: false });
  let settled = false;
  let acked = 0;
  const rows: Row[] = [];
  const finish = (err: Error | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ws.removeAllListeners("close");
    ws.on("error", () => {}); // a late error while closing is not ours to report
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    if (err && !(acked === mutations.length && mutations.length)) {
      if (err instanceof CloudError) err.applied = acked;
      reject(err);
    } else resolve(rows);
  };
  const timer = setTimeout(() => finish(new CloudError(`${base} did not answer ${what} within ${SOCKET_TIMEOUT_MS / 1000}s`)), SOCKET_TIMEOUT_MS);
  const failWith = (e: SyncError, where: string) => {
    const retry = e.retryAfter !== undefined ? ` (retry after ${e.retryAfter}s)` : "";
    finish(new CloudError(`${base} rejected ${where}: ${e.code}: ${e.message}${retry}`, undefined, e.code));
  };
  const afterAcks = () => {
    if (!pull) return finish(null);
    // The ack only says applied; rows (the page's expiry, invites) arrive in the change feed.
    const frame: PullFrame = { v: SYNC_VERSION, t: "pull", after: 0 };
    ws.send(JSON.stringify(frame));
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
    finish(new CloudError(`${base} closed the connection (${code}${reason.length ? `: ${reason.toString()}` : ""}) before answering ${what}`));
  });
  ws.on("open", () => {
    for (const f of frames) ws.send(JSON.stringify(f));
    if (!frames.length) afterAcks();
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const parsed = parseServerFrame(data.toString());
    if (!parsed.ok) return failWith(parsed.error, "a frame from the service");
    const f: ReceivedFrame | null = parsed.value;
    if (!f) return; // a frame type this version does not know
    if (f.t === "error") return failWith(f, what);
    if (f.t === "ack") {
      if (f.clientId !== clientId || f.n !== acked + 1) return;
      const m = mutations[acked];
      if (f.error) return failWith(f.error, m.name === "grant" || m.name === "revoke" ? `${m.name} ${m.args.name}` : m.name);
      if (++acked === mutations.length) afterAcks();
      return;
    }
    if (f.t === "changes" && acked === mutations.length && pull) {
      rows.push(...f.rows);
      if (!f.more) finish(null);
    }
  });
  return promise;
}

/** The latest row of each (type, id) among `rows`. */
function latest(rows: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.type}\u0000${r.id}`;
    const prev = by.get(k);
    if (!prev || prev.seq < r.seq) by.set(k, r);
  }
  return [...by.values()];
}

// ── invites ──

/** `name` trimmed, or an error for one the service would refuse (the same UTF-16 length rule as the schema). */
export function inviteName(name: string): string {
  const n = name.trim();
  if (!n || n.length > MAX_INVITE_NAME) throw new CloudError(`invite name ${JSON.stringify(name)} must be 1-${MAX_INVITE_NAME} characters (emoji count as 2)`);
  return n;
}

/** `30m`, `12h`, `7d` or `2w` from now, in epoch ms. */
export function expiryOf(text: string, now = Date.now()): number {
  const m = /^(\d{1,4})([mhdw])$/.exec(text.trim());
  if (!m || Number(m[1]) === 0) throw new CloudError(`--expires ${JSON.stringify(text)}: use a duration like 30m, 12h, 7d or 2w`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"];
  return now + Number(m[1]) * unit;
}

/** The token's SHA-256 as base64url: what `grant` sends (docs: Access). */
function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("base64url");
}

/** An invite link: the token rides in the fragment, which browsers never send to the server. */
export function inviteLink(base: string, id: string, token: string): string {
  return `${base}/p/${id}#i=${token}`;
}

/** `grant`s for `names`, reusing each name's stored token so its link stays the same. */
function grants(entry: PageEntry, names: string[], expiresAt: number | null | undefined): Send[] {
  return names.map((name) => {
    const prev = entry.invites[name];
    const invite: InviteEntry = {
      token: prev?.token ?? crypto.randomBytes(32).toString("base64url"),
      expiresAt: expiresAt === undefined ? (prev?.expiresAt ?? null) : expiresAt,
      grantedAt: prev?.grantedAt ?? null,
    };
    entry.invites[name] = invite;
    return { name: "grant", args: { name, tokenHash: tokenHash(invite.token), expiresAt: invite.expiresAt } };
  });
}

/** An `acl` row that still lets its invitee in. */
function liveAcl(r: AclRow, now: number): boolean {
  return !r.revoked && (r.expiresAt === null || r.expiresAt > now);
}

// ── commands ──

export interface Published {
  updated: boolean;
  id: string;
  url: string;
  expiresAt: number | null;
  auto: boolean;
  unlisted: boolean;
  presence: boolean;
  /** The invites this publish granted, with their links. */
  invites: { name: string; link: string; expiresAt: number | null }[];
  /** Other live invites on the page (from its `acl` rows); null when the rows did not arrive. */
  otherInvites: number | null;
  packs: number;
  images: number;
}

export interface PublishOptions {
  auto?: boolean;
  /** A new link even when the file has one. */
  fresh?: boolean;
  /** The open link: anyone with the URL may review. */
  unlisted?: boolean;
  /** Viewers see each other on the page (Q17); false is `--no-presence`. */
  presence?: boolean;
  /** Names to invite (or re-send, with the same link). */
  invite?: string[];
  /** Expiry for the invites named here, epoch ms. */
  expiresAt?: number;
}

/**
 * Upload (or republish) a page, then grant the invites it names.
 * @param abs canonical absolute path
 */
export async function publish(abs: string, opts: PublishOptions = {}): Promise<Published> {
  const { auto = false, fresh = false, unlisted = false, presence = true } = opts;
  const names = [...new Set((opts.invite ?? []).map(inviteName))];
  if (opts.expiresAt !== undefined && !names.length) throw new CloudError("--expires applies to the invites of this publish: add --invite <name>");
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
    // Invite-only unless --unlisted (Q16); presence on unless --no-presence (Q17).
    unlisted,
    presence,
  };
  const entry: PageEntry = { id, auto, unlisted, presence, invites: Object.assign(Object.create(null), prev?.invites) };
  const sends = [{ name: "publish", args } as Send, ...grants(entry, names, opts.expiresAt)];
  let rows: Row[];
  try {
    rows = await ownerSession(base, token, id, sends, { pull: true });
  } catch (err) {
    if (prev && err instanceof CloudError && err.status === 404) {
      throw new CloudError(`the hosted page for this file (${prev.id}) is gone from ${base}: it expired or was deleted. publish --new makes a new link.`, 404);
    }
    // The page was published but an invite failed: keep the link, so a retry updates it.
    if (err instanceof CloudError && err.applied > 0) {
      state.pages[abs] = entry;
      writeCloud(state);
    }
    throw err;
  }
  const latestRows = latest(rows);
  const acl = latestRows.filter((r): r is AclRow => r.type === "acl");
  // Tie each token to the grant the service recorded, so `publish invites` knows a later re-grant elsewhere replaced it.
  // Rows lost after the acks keep what was confirmed before (the service keeps grantedAt for the same token).
  for (const name of names) entry.invites[name].grantedAt = acl.find((r) => r.name === name)?.grantedAt ?? entry.invites[name].grantedAt;
  state.pages[abs] = entry;
  writeCloud(state);
  const row = latestRows.find((r): r is PageRow => r.type === "page" && r.id === id);
  const now = Date.now();
  return {
    updated: !!prev,
    id,
    url,
    expiresAt: row ? row.expiresAt : null,
    auto,
    unlisted,
    presence,
    invites: names.map((name) => ({ name, link: inviteLink(base, id, entry.invites[name].token), expiresAt: entry.invites[name].expiresAt })),
    otherInvites: row ? acl.filter((r) => !names.includes(r.name) && liveAcl(r, now)).length : null,
    packs: bundle.packs.length,
    images: bundle.images,
  };
}

export interface InviteInfo {
  name: string;
  /** The link, when this machine made the invite and it is live. */
  link?: string;
  /** Live, and this machine holds a token for the name whose grant it never saw confirmed: re-send it to get the link. */
  unconfirmed?: boolean;
  grantedAt: number;
  expiresAt: number | null;
  status: "live" | "expired" | "revoked";
}

/** The page entry of a published file, or an error naming what to do. */
function entryOf(state: CloudState, abs: string): PageEntry {
  const entry = state.pages[abs];
  if (!entry) throw new CloudError(`${abs} has not been published from this machine (see austere-axi publish list)`);
  if (!state.token) throw new CloudError("nothing has been published from this machine");
  return entry;
}

/** The page's invites, as the service has them (`acl` rows), with this machine's links. */
export async function listInvites(abs: string): Promise<{ id: string; unlisted: boolean; auto: boolean; presence: boolean; invites: InviteInfo[] }> {
  const base = cloudUrl();
  const state = stateFor(base);
  const entry = entryOf(state, abs);
  const rows = latest(await ownerSession(base, state.token, entry.id, [], { pull: true }));
  const page = rows.find((r): r is PageRow => r.type === "page");
  const now = Date.now();
  const invites = rows
    .filter((r): r is AclRow => r.type === "acl")
    .sort((a, b) => a.grantedAt - b.grantedAt)
    .map((r): InviteInfo => {
      const status = r.revoked ? "revoked" : liveAcl(r, now) ? "live" : "expired";
      // Only this machine's token for this very grant: a re-grant elsewhere gave the name another token.
      const local = entry.invites[r.name];
      const mine = status === "live" && local !== undefined && local.grantedAt === r.grantedAt;
      const unconfirmed = status === "live" && local !== undefined && local.grantedAt === null ? true : undefined;
      return { name: r.name, link: mine ? inviteLink(base, entry.id, local.token) : undefined, unconfirmed, grantedAt: r.grantedAt, expiresAt: r.expiresAt, status };
    });
  // `auto`, `unlisted` and `presence` as the page has them now, so a suggested re-publish keeps them.
  return { id: entry.id, unlisted: page?.unlisted ?? entry.unlisted, auto: page?.auto ?? entry.auto, presence: page?.presence ?? entry.presence, invites };
}

/** Revoke invite `name`: its link stops working and its open pages are disconnected at once. */
export async function revokeInvite(abs: string, name: string): Promise<{ id: string; name: string }> {
  const base = cloudUrl();
  const state = stateFor(base);
  const entry = entryOf(state, abs);
  const n = inviteName(name);
  await ownerSession(base, state.token, entry.id, [{ name: "revoke", args: { name: n } }]);
  delete entry.invites[n];
  writeCloud(state);
  return { id: entry.id, name: n };
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
    await ownerSession(base, state.token, id, [{ name: "delete", args: {} }]);
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
