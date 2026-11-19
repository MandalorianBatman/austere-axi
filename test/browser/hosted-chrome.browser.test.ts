// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH):
// the review chrome in hosted mode, against a tiny stub of the austere-cloud
// reviewer routes (docs/hosted-share-links.md, "Sync, access and presence"),
// served with the service's CSP: the shell, the asset-token trade, the token-scoped
// frame, the reviewer socket (pull, changes, addNote acks, revocation) and the report.
import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { SUBPROTOCOL, SYNC_VERSION, parseClientFrame, readProtocols } from "../../src/shared/sync.ts";
import type { Mutation, NoteRow, PageRow, ReplyRow, Row, ServerFrame } from "../../src/shared/sync.ts";
import { packedScripts } from "../../src/cli/export.ts";
import { hasInlineRuntime } from "../../src/cli/artifact.ts";

const ID = "pg_test";
const BASE = `/p/${ID}`;
const ANA = "ana-invite-token-0123456789";
const BO = "bo-invite-token-0123456789";
const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'none'";

interface Socket {
  ws: WebSocket;
  invite: string | undefined;
  /** Let in on the owner's sign-in cookie. */
  owner?: boolean;
}

// What the stub service has seen and holds.
const svc = {
  requests: [] as string[],
  /** The X-Austere-Invite header of each asset-token request ("" when absent). */
  inviteHeaders: [] as string[],
  assetTokens: new Set<string>(),
  invites: new Map<string, string>(),
  unlisted: false,
  rows: [] as Row[],
  seq: 0,
  pulls: [] as number[],
  mutations: [] as Mutation[],
  /** (clientId, n) already applied: a repeat gets the same ack and changes nothing. */
  applied: new Set<string>(),
  holdAcks: false,
  upgrades: 0,
  sockets: new Set<Socket>(),
  reports: [] as { body: unknown; invite: string }[],
  /** Called on each mutation the stub receives (mutationsReceived). */
  onMutation: null as (() => void) | null,
  /** Refuse every socket handshake (403), and leave asset-token requests unanswered. */
  refuseUpgrades: false,
  stallAssetToken: false,
  /** Answer this many coming addNotes with `rate_limited` (`retryAfter` seconds), unapplied and unstored. */
  rateLimit: 0,
  retryAfter: 1,
  /** When each mutation arrived (epoch ms), in step with `mutations`. */
  mutationTimes: [] as number[],
  /** The single-use code `publish login` printed, until used; then the owner cookie's session. */
  loginCode: null as string | null,
  ownerSession: null as string | null,
  /** The shell's `hosted.signIn`, as austere-cloud sets it when accounts are on; null: accounts off. */
  signIn: null as string | null,
};
let stub: http.Server | undefined;
let origin: string;
let browser: Browser;
let skipReason: string | undefined;
const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });

function pageRow(publishedAt: number, deleted = false): PageRow {
  return { v: 1, type: "page", id: ID, seq: 0, title: "Plan", cliVersion: "0.8.1", html: "a".repeat(64), packs: [], auto: false, unlisted: svc.unlisted, presence: true, publishedAt, expiresAt: publishedAt + 1e9, deleted };
}

/** Gives the row the next seq and sends it to every open socket. */
function put(row: Row) {
  row.seq = ++svc.seq;
  svc.rows = [...svc.rows.filter((r) => !(r.type === row.type && r.id === row.id)), row];
  for (const s of svc.sockets) send(s.ws, { v: SYNC_VERSION, t: "changes", rows: [row], cursor: svc.seq });
}

function send(ws: WebSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame));
}

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function refuse(socket: Duplex, status: number, code: string) {
  const text = JSON.stringify({ error: { code, message: code } });
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
}

function shell() {
  // As austere-cloud: the shell names no page; the title comes with the asset-token answer.
  const hosted = { base: BASE, report: `${BASE}/report`, publishedAt: 1_000, ...(svc.signIn ? { signIn: svc.signIn } : {}) };
  const boot = { id: ID, title: "Shared page", name: "Shared page", artifactUrl: `${BASE}/a/`, version: "0.8.1", viewer: { role: "reviewer", name: "" }, hosted };
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Shared page · austere</title>
<link rel="stylesheet" href="/rt/chrome/chrome.css">
<script type="application/json" id="austere-boot">${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>
<script src="/rt/chrome/chrome.js" defer></script>
</head><body></body></html>`;
}

const ARTIFACT = `<!doctype html><html><head><title>Plan</title><script src="/rt/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`;

/** The request carries the live owner session cookie. */
const isOwner = (req: IncomingMessage) => svc.ownerSession !== null && /(?:^|;\s*)austere_owner=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] === svc.ownerSession;

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", origin);
  const invite = String(req.headers["x-austere-invite"] ?? "");
  svc.requests.push(`${req.method} ${url.pathname}${url.search}`);
  if (req.method === "POST" && req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: { code: "forbidden", message: "foreign origin" } });
  if (url.pathname === BASE && url.searchParams.has("login")) {
    // The single-use sign-in link: swap the code for the page-scoped owner cookie, then drop it from the URL.
    if (svc.loginCode === null || url.searchParams.get("login") !== svc.loginCode) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("This sign-in link was used already or has expired.");
    }
    svc.loginCode = null;
    svc.ownerSession = `session${Math.random().toString(36).slice(2)}`;
    res.writeHead(303, { location: BASE, "set-cookie": `austere_owner=${svc.ownerSession}; Path=${BASE}; HttpOnly; SameSite=Lax` });
    return res.end();
  }
  if (url.pathname === BASE) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": SHELL_CSP });
    return res.end(shell());
  }
  const framed = /^\/p\/pg_test\/a\/([^/]+)\/$/.exec(url.pathname);
  if (framed && svc.assetTokens.has(framed[1])) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": FRAME_CSP });
    return res.end(ARTIFACT);
  }
  const asset = ({ "/rt/chrome/chrome.js": "dist/chrome/chrome.js", "/rt/chrome/chrome.css": "dist/chrome/chrome.css", "/rt/austere.js": "dist/austere.js" } as Record<string, string | undefined>)[url.pathname];
  if (asset) {
    res.writeHead(200, { "content-type": asset.endsWith(".css") ? "text/css" : "text/javascript" });
    return res.end(fs.readFileSync(asset));
  }
  if (url.pathname === `${BASE}/asset-token` && req.method === "POST") {
    if (svc.stallAssetToken) return; // never answered
    svc.inviteHeaders.push(invite);
    const owner = isOwner(req);
    const name = owner ? "Owner" : svc.invites.get(invite);
    if (!name && !svc.unlisted) return json(res, 403, { error: { code: "forbidden", message: "invite required" } });
    const token = `at${svc.assetTokens.size}x${Math.random().toString(36).slice(2)}`;
    svc.assetTokens.add(token);
    return json(res, 200, { token, expiresAt: Date.now() + 600_000, name: name ?? null, title: "Plan", owner });
  }
  if (url.pathname === `${BASE}/report` && req.method === "POST") {
    svc.reports.push({ body: await body(req), invite });
    return json(res, 200, { ok: true });
  }
  res.writeHead(404).end("not found");
}

/** The reviewer socket: pull answered from the rows, addNote applied once per (clientId, n) and acked. */
function reviewerSocket(s: Socket) {
  svc.sockets.add(s);
  s.ws.on("close", () => svc.sockets.delete(s));
  s.ws.on("message", (data) => {
    const parsed = parseClientFrame(String(data));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const frame = parsed.value;
    if (frame.t === "pull") {
      svc.pulls.push(frame.after);
      send(s.ws, { v: SYNC_VERSION, t: "changes", rows: svc.rows.filter((r) => r.seq > frame.after), cursor: svc.seq });
    } else if (frame.t === "mutation" && frame.name === "addNote") {
      svc.mutations.push(frame);
      svc.mutationTimes.push(Date.now());
      svc.onMutation?.();
      if (svc.holdAcks) return;
      if (svc.rateLimit > 0) {
        svc.rateLimit--;
        return send(s.ws, { v: SYNC_VERSION, t: "ack", clientId: frame.clientId, n: frame.n, error: { code: "rate_limited", message: "slow down", retryAfter: svc.retryAfter } });
      }
      const key = `${frame.clientId}:${frame.n}`;
      if (!svc.applied.has(key)) {
        svc.applied.add(key);
        const author = s.owner ? "Owner" : (s.invite && svc.invites.get(s.invite)) || frame.args.name || "Reviewer";
        put({ v: 1, type: "note", id: `n${svc.seq + 1}`, seq: 0, author, items: frame.args.items, at: Date.now(), state: "held" } satisfies NoteRow);
      }
      send(s.ws, { v: SYNC_VERSION, t: "ack", clientId: frame.clientId, n: frame.n });
    }
  });
}

/** Resolves once the stub has received `count` mutations in all. */
function mutationsReceived(count: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  svc.onMutation = () => {
    if (svc.mutations.length < count) return;
    svc.onMutation = null;
    resolve();
  };
  svc.onMutation();
  return promise;
}

/** Revokes an invite: its sockets get `error` `forbidden`, then close 1008. */
function revoke(token: string) {
  svc.invites.delete(token);
  for (const s of svc.sockets) {
    if (s.invite !== token) continue;
    send(s.ws, { v: SYNC_VERSION, t: "error", code: "forbidden", message: "invite revoked" });
    s.ws.close(1008, "forbidden");
  }
}

/** The owner's sign-in session ends: its sockets get `error` `forbidden`, then close 1008. */
function signOut() {
  svc.ownerSession = null;
  for (const s of svc.sockets) {
    if (!s.owner) continue;
    send(s.ws, { v: SYNC_VERSION, t: "error", code: "forbidden", message: "sign-in expired" });
    s.ws.close(1008, "forbidden");
  }
}

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js", "chrome/chrome.css"]) {
    if (!fs.existsSync(path.join("dist", f))) {
      skipReason = `dist/${f} missing; run npm run test:browser (it builds first)`;
      return;
    }
  }
  const launched = await launchBrowser();
  if (!launched.browser) {
    skipReason = launched.reason;
    return;
  }
  browser = launched.browser;
  const server = http.createServer((req, res) => handle(req, res).catch((err) => json(res, 500, { error: String(err) })));
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", origin);
    const creds = readProtocols(req.headers["sec-websocket-protocol"]);
    svc.upgrades++;
    if (url.pathname !== `${BASE}/sync`) return refuse(socket, 404, "invalid");
    if (!creds.sync) return refuse(socket, 426, "upgrade_required");
    if (svc.refuseUpgrades) return refuse(socket, 403, "forbidden");
    if (req.headers.origin !== origin) return refuse(socket, 403, "forbidden");
    const owner = isOwner(req);
    if (!owner && (creds.invite ? !svc.invites.has(creds.invite) : !svc.unlisted)) return refuse(socket, 403, "forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => reviewerSocket({ ws, invite: creds.invite, owner }));
  });
  stub = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of svc.sockets) s.ws.terminate();
  await browser?.close();
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
});

beforeEach(() => {
  for (const s of svc.sockets) s.ws.terminate();
  Object.assign(svc, { requests: [], inviteHeaders: [], rows: [], seq: 0, pulls: [], mutations: [], holdAcks: false, upgrades: 0, reports: [], unlisted: false, rateLimit: 0, retryAfter: 1, mutationTimes: [], loginCode: null, ownerSession: null, signIn: null });
  svc.invites = new Map([[ANA, "Ana"]]);
  put(pageRow(1_000));
});

/** Collects CSP violations and page errors: the hosted shell allows no inline script and no eval. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

test("hosted chrome: invite link, asset-token frame, synced rows, addNote as the invite, reconnect, revoke", async (t) => {
  if (skipReason) return t.skip(skipReason);
  put({ v: 1, type: "note", id: "n-bo", seq: 0, author: "Bo", items: [{ kind: "message", text: "from Bo" }], at: Date.now(), state: "released" } satisfies NoteRow);
  put({ v: 1, type: "note", id: "n-gone", seq: 0, author: "Cy", items: [{ kind: "message", text: "discarded note" }], at: Date.now(), state: "discarded" } satisfies NoteRow);
  put({ v: 1, type: "reply", id: "r1", seq: 0, text: "Welcome, **Ana**.", at: Date.now() } satisfies ReplyRow);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${origin}${BASE}?x=1#i=${ANA}`);
    await page.waitForSelector(".presence.hosted");

    // The fragment is stored for this page and taken out of the address bar.
    assert.equal(page.url(), `${origin}${BASE}?x=1`);
    assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`austere:invite:${id}`) as string), ID), ANA);
    assert.deepEqual(svc.inviteHeaders, [ANA]);

    // The frame loads from the artifact prefix plus the traded asset token, and renders.
    assert.equal(await page.locator(".frame").getAttribute("src"), `${BASE}/a/${[...svc.assetTokens].at(-1)}/`);
    await page.frameLocator(".frame").locator("text=hello").waitFor();

    // Owner and local-only controls are gone; the footer is there.
    for (const sel of ['[data-cmd="end"]', '[data-cmd="copy-agent-prompt"]', '[data-cmd="copy-path"]', ".send-end", ".held-bar"]) {
      assert.equal(await page.locator(sel).count(), 0, `${sel} hidden`);
    }
    assert.equal(await page.locator(".hosted-foot a").innerText(), "Made with austere-axi");

    // The pull from 0 brings the rows: notes and replies render, discarded notes stay hidden.
    assert.deepEqual(svc.pulls, [0]);
    await page.waitForSelector("text=from Bo");
    assert.match(await page.locator(".msg.agent .md").innerText(), /Welcome, Ana\./);
    assert.equal(await page.locator("text=discarded note").count(), 0);

    // An invited reviewer is named by the invite: no prompt, and addNote carries no name.
    assert.match(await page.locator(".composer-hint").innerText(), /Posting as Ana/);
    await page.fill(".composer textarea", "tighten the intro");
    await page.click(".composer .send");
    await mutationsReceived(1);
    await page.waitForSelector(".msg.user .receipt em:text('Sent to the page owner')");
    assert.ok(await page.locator(".name-ask").isHidden());
    assert.equal(svc.mutations.length, 1);
    const [m] = svc.mutations;
    assert.equal(m.name, "addNote");
    assert.match(m.clientId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(m.n, 1);
    assert.deepEqual(m.args, { items: [{ kind: "message", text: "tighten the intro" }] });
    assert.match(await page.locator(".msg.user:has-text('tighten the intro') .who").innerText(), /^You/);

    // A dropped connection reconnects, pulls after its cursor, and re-sends the unacked note once.
    svc.holdAcks = true;
    await page.fill(".composer textarea", "and the outro");
    await page.click(".composer .send");
    await page.waitForSelector(".msg.user .receipt em:text('Sending…')");
    await mutationsReceived(2);
    svc.holdAcks = false;
    const cursor = svc.seq;
    for (const s of svc.sockets) s.ws.terminate();
    await page.waitForFunction(() => [...document.querySelectorAll(".msg.user .receipt em")].filter((em) => em.textContent === "Sent to the page owner").length === 2);
    assert.equal(await page.locator(".receipt em:text('Sending…')").count(), 0);
    assert.equal(svc.pulls.at(-1), cursor);
    const outro = svc.mutations.filter((x) => x.n === 2);
    assert.equal(outro.length, 2, "re-sent after the reconnect");
    assert.equal(svc.rows.filter((r) => r.type === "note" && r.items.some((i) => i.kind === "message" && i.text === "and the outro")).length, 1);

    // A republish arrives live: offer a reload.
    assert.ok(await page.locator(".banner").isHidden());
    put(pageRow(2_000));
    await page.waitForSelector(".banner:not([hidden])");
    assert.match(await page.locator(".banner").innerText(), /New version, reload/);

    // Report posts to BOOT.hosted.report with the invite header.
    await page.click(".hosted-foot .report-open");
    await page.fill(".report-box textarea", "phishing page");
    await page.click(".report-box >> text=Send report");
    await page.waitForSelector(".hosted-foot .report-done");
    assert.deepEqual(svc.reports, [{ body: { reason: "phishing page" }, invite: ANA }]);

    // The invite is revoked: say so, lock the composer, and do not reconnect.
    const upgrades = svc.upgrades;
    revoke(ANA);
    await page.waitForSelector(".presence.ended");
    assert.match(await page.locator(".presence").innerText(), /Invite no longer valid/);
    assert.match(await page.locator(".banner").innerText(), /no longer valid/);
    assert.ok(await page.locator(".composer textarea").isDisabled());
    assert.ok(await page.locator(".composer .send").isDisabled());
    // The absence of a reconnect has no event to await: wait past the first backoff (1 s) in real time.
    await page.waitForTimeout(1500);
    assert.equal(svc.upgrades, upgrades, "no reconnect after a revoked invite");

    // No local-server traffic and no old hosted routes.
    assert.ok(!svc.requests.some((r) => /\/events|\/bye|\/s\/|\/conversation|\/send/.test(r)), svc.requests.join("\n"));
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: the shell names no page until access is granted; the owner signs in with a single-use link", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);

    // No invite: the page stays nameless and says it is invite-only.
    await page.goto(`${origin}${BASE}`);
    await page.waitForSelector(".presence.ended");
    assert.match(await page.locator(".presence").innerText(), /Invite required/);
    assert.equal(await page.title(), "Shared page · austere");
    assert.equal(await page.locator(".title").innerText(), "Shared page");

    // The owner's link: the code is traded for the cookie and taken out of the address bar.
    const code = "c0de0123456789abcdef0123456789abcdef01234ab";
    svc.loginCode = code;
    await page.goto(`${origin}${BASE}?login=${code}`);
    await page.frameLocator(".frame").locator("text=hello").waitFor();
    assert.equal(page.url(), `${origin}${BASE}`);
    assert.equal(await page.title(), "Plan · austere");
    assert.equal(await page.locator(".title").innerText(), "Plan");
    assert.equal(svc.inviteHeaders.at(-1), "", "no invite is offered");
    assert.match(await page.locator(".composer-hint").innerText(), /Posting as Owner/);
    await page.fill(".composer textarea", "owner note");
    await page.click(".composer .send");
    await mutationsReceived(1);
    await page.waitForSelector(".msg.user .receipt em:text('Sent to the page owner')");
    assert.ok(svc.rows.some((r) => r.type === "note" && r.author === "Owner"));

    // The same link again is refused: it was single-use.
    const again = await ctx.newPage();
    assert.equal((await again.goto(`${origin}${BASE}?login=${code}`))?.status(), 403);
    await again.close();

    // The sign-in expires: the socket is closed, and the page says how to sign in again.
    signOut();
    await page.waitForSelector(".presence.ended");
    assert.match(await page.locator(".presence").innerText(), /Signed out/);
    assert.match(await page.locator(".banner").innerText(), /publish login/);
    assert.ok(await page.locator(".composer textarea").isDisabled());
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: the ⋯ menu downloads a standalone copy; sharing follows the page's unlisted flag", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.frameLocator(".frame").locator("text=hello").waitFor();

    // Invite-only: each link names one reviewer, so no page link to pass on; the menu says how the owner shares.
    await page.waitForSelector("[data-share-note]:not([hidden])", { state: "attached" });
    await page.click(".menu-btn");
    assert.ok(await page.locator('[data-cmd="copy-link"]').isHidden(), "no page link on an invite-only page");
    assert.match(await page.locator("[data-share-note]").innerText(), /publish <file> --invite "Name"/);

    // While the copy is built the menu stays open and says so; it closes once the file is saved.
    const { promise: slow, resolve: release } = Promise.withResolvers<void>();
    await page.route("**/rt/austere.js", async (route) => {
      await slow;
      await route.continue();
    });
    const downloading = page.waitForEvent("download");
    await page.click('[data-cmd="export"]');
    await page.waitForSelector('.menu-pop:not([hidden]) [data-cmd="export"]:disabled:text("Preparing download…")');
    release();
    const download = await downloading;
    await page.waitForSelector(".menu-pop", { state: "hidden" });
    await page.unroute("**/rt/austere.js");
    assert.equal(await page.locator('[data-cmd="export"]').innerText(), "Download standalone HTML");
    assert.equal(download.suggestedFilename(), "Plan.html");
    const html = fs.readFileSync(await download.path(), "utf8");
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/, "no script left to fetch");
    const packed = packedScripts(html);
    assert.deepEqual(packed.map((x) => x.name), ["/rt/austere.js"]);
    assert.equal(packed[0].code, fs.readFileSync("dist/austere.js", "utf8"), "unpacks to the runtime as served");
    assert.match(html, /intro = TextContent\("hello"\)/, "the program is kept");
    assert.ok(hasInlineRuntime(html), "check sees an exported copy");
    assert.equal(await page.locator(".banner").isHidden(), true);

    // The copy opens on its own: the loader unpacks the runtime and it renders, with no request.
    const offline = await ctx.newPage();
    const requests: string[] = [];
    offline.on("request", (r) => r.url().startsWith("http") && requests.push(r.url()));
    await offline.setContent(html);
    await offline.waitForSelector("text=hello");
    assert.deepEqual(requests, []);

    // Unlisted, opened with an invite: the plain URL lets anyone in, so the invited reviewer may share it too.
    svc.unlisted = true;
    put(pageRow(1_000));
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector('[data-cmd="copy-link"]:not([hidden])', { state: "attached" });
    assert.match(await page.locator(".composer-hint").innerText(), /Posting as Ana/, "still the invite's reviewer");
    assert.ok(await page.locator("[data-share-note]").isHidden(), "no owner-only note on an unlisted page");
    await page.click(".menu-btn");
    await page.click('[data-cmd="copy-link"]');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}${BASE}`, "no invite token in the copied link");

    // Unlisted, without an invite: the same page link.
    await page.evaluate((id) => localStorage.removeItem(`austere:invite:${id}`), ID);
    await page.goto(`${origin}${BASE}`);
    await page.waitForSelector('[data-cmd="copy-link"]:not([hidden])', { state: "attached" });
    assert.ok(await page.locator("[data-share-note]").isHidden());
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.click(".menu-btn");
    await page.click('[data-cmd="copy-link"]');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}${BASE}`);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: with localStorage writes failing, the link's invite is still used", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.localStorage) throw new DOMException("quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    assert.equal(page.url(), `${origin}${BASE}`, "the fragment is still stripped");
    assert.deepEqual(svc.inviteHeaders, [ANA]);
    await page.frameLocator(".frame").locator("text=hello").waitFor();
    assert.equal(await page.locator(".presence.ended").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: with sessionStorage writes failing, each note gets its own n and both are saved", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Quota exceeded or blocked storage: every sessionStorage write throws; localStorage still works.
  await ctx.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException("quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector(".presence.hosted");
    await page.waitForSelector("text=Posting as Ana");
    // Unacked and unsaved: the composer says a reload would lose it, until the ack comes.
    svc.holdAcks = true;
    await page.fill(".composer textarea", "held note");
    await page.click(".composer .send");
    await mutationsReceived(1);
    await page.waitForSelector("text=could not keep a copy of your note");
    svc.holdAcks = false;
    for (const s of svc.sockets) s.ws.terminate(); // the reconnect re-sends it, and it is acked
    await page.waitForFunction(() => !document.body.innerText.includes("could not keep a copy"), null, { timeout: 8000 });
    svc.mutations.length = 0;
    for (const [i, text] of ["first note", "second note"].entries()) {
      await page.fill(".composer textarea", text);
      await page.click(".composer .send");
      await mutationsReceived(i + 1);
    }
    await page.waitForFunction(() => [...document.querySelectorAll(".msg.user .receipt em")].filter((em) => em.textContent === "Sent to the page owner").length === 3);
    assert.equal(await page.locator(".receipt em:text('Sending…')").count(), 0, "both left the outbox");
    assert.deepEqual(
      svc.mutations.map((m) => m.n),
      [2, 3],
    );
    const saved = svc.rows.filter((r): r is NoteRow => r.type === "note").map((r) => r.items.map((x) => (x.kind === "message" ? x.text : "")).join());
    assert.deepEqual(saved, ["held note", "first note", "second note"]);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: a held note survives a reload under its key; a duplicated tab numbers its own notes", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    svc.holdAcks = true; // offline in effect: the note stays in the outbox
    await page.fill(".composer textarea", "before reload");
    await page.click(".composer .send");
    await mutationsReceived(1);
    const [held] = svc.mutations;
    svc.holdAcks = false;

    await page.reload();
    await page.waitForSelector("text=Posting as Ana");
    // Re-sent under its original key after the reload, applied once, and out of the outbox.
    await page.waitForFunction(() => document.querySelectorAll(".msg.user .receipt em").length === 1 && document.querySelector(".msg.user .receipt em")?.textContent === "Sent to the page owner");
    assert.equal(svc.mutations.filter((m) => m.clientId === held.clientId && m.n === held.n).length, 2, "first send, then the re-send after the reload");

    // A duplicated tab starts with a copy of this tab's sessionStorage.
    const copied: Record<string, string> = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
    const twin = await ctx.newPage();
    await twin.addInitScript((entries: Record<string, string>) => {
      if (window === window.top) for (const [k, v] of Object.entries(entries)) sessionStorage.setItem(k, v);
    }, copied);
    await twin.goto(`${origin}${BASE}`);
    await twin.waitForSelector("text=Posting as Ana");
    for (const [p, text] of [
      [page, "from the first tab"],
      [twin, "from the copy"],
    ] as const) {
      const sent = svc.mutations.length;
      await p.fill(".composer textarea", text);
      await p.click(".composer .send");
      await mutationsReceived(sent + 1);
    }
    const [a, b] = svc.mutations.slice(-2);
    assert.notDeepEqual([a.clientId, a.n], [b.clientId, b.n], "two notes, two keys");
    assert.notEqual(b.clientId, held.clientId);
    await twin.waitForFunction(() => [...document.querySelectorAll(".msg.user .receipt em")].some((em) => em.textContent === "Sent to the page owner"));
    const saved = svc.rows.filter((r): r is NoteRow => r.type === "note").map((r) => r.items.map((x) => (x.kind === "message" ? x.text : "")).join());
    assert.deepEqual(saved, ["before reload", "from the first tab", "from the copy"]);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: a held note is never sent under another invite opened in the same tab", async (t) => {
  if (skipReason) return t.skip(skipReason);
  svc.invites.set(BO, "Bo");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    svc.holdAcks = true; // offline in effect: Ana's note stays in the outbox
    await page.fill(".composer textarea", "Ana's note");
    await page.click(".composer .send");
    await mutationsReceived(1);
    svc.holdAcks = false;

    // Bo's link in the same tab (a full load): the outbox carries over in sessionStorage, but not to Bo.
    await page.goto("about:blank");
    await page.goto(`${origin}${BASE}#i=${BO}`);
    await page.waitForSelector("text=Posting as Bo");
    await page.waitForFunction(() => document.querySelector(".presence")?.className.includes("hosted"));
    const sent = svc.mutations.length;
    await page.fill(".composer textarea", "Bo's note");
    await page.click(".composer .send");
    await mutationsReceived(sent + 1);
    await page.waitForSelector(".msg.user .receipt em:text('Sent to the page owner')");
    assert.equal(await page.locator("text=Ana's note").count(), 0, "Ana's pending note is not shown as Bo's");
    const authors = svc.rows.filter((r): r is NoteRow => r.type === "note").map((r) => [r.author, r.items.map((x) => (x.kind === "message" ? x.text : "")).join()]);
    assert.deepEqual(authors, [["Bo", "Bo's note"]], "nothing of Ana's went out on Bo's socket");

    // Back as Ana by opening her link in the open page (only the fragment changes): her note goes out, under her invite.
    await page.evaluate((hash) => (location.hash = hash), `i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    await page.waitForFunction(() => [...document.querySelectorAll(".msg.user")].some((m) => m.textContent?.includes("Ana's note") && m.textContent.includes("Sent to the page owner")));
    const all = svc.rows.filter((r): r is NoteRow => r.type === "note").map((r) => [r.author, r.items.map((x) => (x.kind === "message" ? x.text : "")).join()]);
    assert.deepEqual(all, [
      ["Bo", "Bo's note"],
      ["Ana", "Ana's note"],
    ]);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: a rate-limited note stays queued and goes again by itself after Retry-After", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    svc.rateLimit = 1;
    await page.fill(".composer textarea", "patience");
    await page.click(".composer .send");
    await page.waitForSelector("text=sending again in 1 s");
    assert.equal(await page.locator(".receipt em:text('Sending…')").count(), 1, "still in the outbox");
    // The retry after Retry-After (1 s) uses the same key; no resend from the reviewer.
    await page.waitForSelector(".msg.user .receipt em:text('Sent to the page owner')");
    const keys = svc.mutations.map((m) => `${m.clientId}:${m.n}`);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], "the same mutation, re-sent");
    assert.equal(svc.rows.filter((r) => r.type === "note").length, 1);
    assert.equal(await page.locator(".composer textarea").inputValue(), "", "nothing went back to the composer");
    // The row can arrive before its ack, which is what clears the notice: wait for it, bounded.
    await page.locator(".composer-error").waitFor({ state: "hidden", timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: a reconnect during Retry-After does not send the note early, and it goes once when due", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    svc.rateLimit = 1;
    svc.retryAfter = 3;
    await page.fill(".composer textarea", "wait for it");
    await page.click(".composer .send");
    await page.waitForSelector("text=sending again in 3 s");
    const refusedAt = svc.mutationTimes[0];
    const upgrades = svc.upgrades;
    for (const s of svc.sockets) s.ws.terminate(); // reconnects after ~1 s, inside the wait
    await page.waitForSelector(".msg.user .receipt em:text('Sent to the page owner')", { timeout: 10_000 });
    assert.ok(svc.upgrades > upgrades, "it reconnected during the wait");
    assert.equal(svc.mutations.length, 2, "one refused send, then exactly one re-send");
    assert.ok(svc.mutationTimes[1] - refusedAt >= 2900, `re-sent ${svc.mutationTimes[1] - refusedAt} ms after the refusal, not before Retry-After`);
    assert.equal(svc.rows.filter((r) => r.type === "note").length, 1);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: the unsaved-copy warning stays while a note waits out Retry-After", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException("quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  try {
    const page = await ctx.newPage();
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    svc.rateLimit = 1;
    svc.retryAfter = 2;
    await page.fill(".composer textarea", "fragile");
    await page.click(".composer .send");
    await page.waitForSelector("text=sending again in 2 s");
    const notice = await page.locator(".composer-error").innerText();
    assert.match(notice, /could not keep a copy of your note/, notice);
    await page.waitForSelector(".msg.user .receipt em:text('Sent to the page owner')");
    // The row can arrive before its ack, which is what clears the notices: wait for it, bounded.
    await page.locator(".composer-error").waitFor({ state: "hidden", timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: a stalled asset-token check does not hold up the reconnect", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`${origin}${BASE}#i=${ANA}`);
    await page.waitForSelector("text=Posting as Ana");
    // Handshakes fail and the check behind them never answers.
    svc.refuseUpgrades = true;
    svc.stallAssetToken = true;
    const before = svc.upgrades;
    for (const s of svc.sockets) s.ws.terminate();
    // Real time: the 5 s check timeout runs in the page, which the test cannot fast-forward.
    const deadline = Date.now() + 12_000;
    while (svc.upgrades < before + 2 && Date.now() < deadline) await page.waitForTimeout(250);
    assert.ok(svc.upgrades >= before + 2, `retried past the stalled check (${svc.upgrades - before} attempts)`);
  } finally {
    svc.refuseUpgrades = false;
    svc.stallAssetToken = false;
    await ctx.close();
  }
});

test("hosted chrome: invite-only without an invite, then unlisted with the name prompt, then removed", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);

    // Invite-only and no invite: the asset-token trade is refused, no socket is tried.
    await page.goto(`${origin}${BASE}`);
    await page.waitForSelector(".presence.ended");
    assert.match(await page.locator(".presence").innerText(), /Invite required/);
    assert.deepEqual(svc.inviteHeaders, [""]);
    assert.equal(svc.upgrades, 0);

    // Unlisted: anyone with the URL gets in, and names themself once before the first note.
    svc.unlisted = true;
    put(pageRow(1_000));
    await page.reload();
    await page.waitForSelector(".presence.hosted");
    await page.frameLocator(".frame").locator("text=hello").waitFor();
    await page.fill(".composer textarea", "tighten the intro");
    await page.click(".composer .send");
    await page.waitForSelector(".name-ask:not([hidden])");
    assert.equal(svc.mutations.length, 0, "nothing sent before a name is given");
    await page.fill(".name-ask input", "  Cy  ");
    await page.press(".name-ask input", "Enter");
    await page.waitForSelector(".msg.user >> text=tighten the intro");
    assert.deepEqual(
      svc.mutations.map((x) => x.args),
      [{ items: [{ kind: "message", text: "tighten the intro" }], name: "Cy" }],
    );
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("austere:name") as string)), "Cy");
    assert.match(await page.locator(".composer-hint").innerText(), /Posting as Cy/);
    assert.ok(await page.locator(".name-ask").isHidden());

    // The page is deleted: its row comes with deleted: true, then close 1000. No reconnect.
    const upgrades = svc.upgrades;
    put(pageRow(1_000, true));
    for (const s of svc.sockets) s.ws.close(1000);
    await page.waitForSelector(".presence.ended");
    assert.match(await page.locator(".presence").innerText(), /Page removed/);
    assert.ok(await page.locator(".composer .send").isDisabled());
    await page.waitForTimeout(1500); // past the first reconnect backoff, as above
    assert.equal(svc.upgrades, upgrades);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test("hosted chrome: a refused viewer gets Sign in when the service has accounts, and none without", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${origin}${BASE}`);
    await page.waitForSelector(".presence.ended");
    assert.equal(await page.locator(".banner a", { hasText: "Sign in" }).count(), 0, "no sign-in without accounts");

    svc.signIn = `/auth/login?return_to=${encodeURIComponent(BASE)}`;
    await page.reload();
    await page.waitForSelector(".presence.ended");
    assert.match(await page.locator(".presence").innerText(), /Invite required/);
    const link = page.locator(".banner a", { hasText: "Sign in" });
    assert.equal(await link.getAttribute("href"), svc.signIn);
    assert.match(await page.locator(".banner").innerText(), /sign in with the account the owner shared it with/);
    await link.click();
    await page.waitForURL(/\/auth\/login\?return_to=/);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});
