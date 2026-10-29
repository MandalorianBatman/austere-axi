// Local review server. One per machine (per port), shared by every session.
//   /api/*        control routes for the CLI (loopback only)
//   /s/:id        review page (chrome) for a session
//   /s/:id/a/...  the artifact and its sibling assets, runtime tag pointed here
//   /s/:id/events server-sent events for the chrome
//   /__austere/*  runtime, mermaid, bundled packs, chrome assets
//   /__austere/installed-packs/<name@version>/pack.js  packs from `components add`
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { readArtifact, rewriteRuntime, escapeHtml } from "./artifact.js";
import { exportHtml } from "./export.js";
import { allowedHosts, detectTailscale, hostOnly, isLoopback } from "./net.js";
import { ASSET_DIR, VERSION, msEnv, stateDir } from "./paths.js";
import { SessionStore, newId } from "./sessions.js";
import { installedPackFile, pagePacks, readLock } from "./packs.js";
import { Hub, hubEnabled, hubUnsupported } from "./hub.js";
import { hubPage, notesPage } from "./hub-page.js";
import { splitSpec } from "../shared/packs-meta.js";
import crypto from "node:crypto";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const SHORT_GRACE_MS = 10_000;

export async function runServer({ port, verbose = false, alsoListen = [] }) {
  const log = (...a) => {
    const line = `${new Date().toISOString()} ${a.join(" ")}`;
    if (verbose) process.stderr.write(line + "\n");
    try {
      fs.appendFileSync(path.join(stateDir(), "server.log"), line + "\n");
    } catch {
      // ignore
    }
  };

  // Hub mode (`austere-axi hub on`): mirror sessions into the index and stay up.
  let hub = null;
  // What this server was asked to be. The CLI compares it with the config, so a hub
  // that cannot open its index does not make every command restart the server.
  const hubWanted = hubEnabled();
  if (hubWanted) {
    const why = hubUnsupported();
    if (why) log("hub-unavailable", why);
    else {
      try {
        hub = await Hub.open();
      } catch (err) {
        log("hub-unavailable", String(err?.message || err));
      }
    }
  }
  const store = new SessionStore(stateDir(), { onFlush: hub ? (s) => hub.syncSession(s) : undefined });
  if (hub) {
    for (const s of store.list()) {
      try {
        hub.syncSession(s);
      } catch (err) {
        log("hub-sync", s.id, String(err?.message || err));
      }
    }
  }
  const clients = new Map(); // id -> Set<{res, id}>
  const polls = new Map(); // id -> poll
  const watchers = new Map(); // id -> { html, program, shell }
  const listeners = new Map(); // host -> http.Server
  const graceTimers = new Map(); // id -> timeout
  const byeAt = new Map(); // id -> ms of last explicit tab close
  const browserSeen = new Set();
  let tailnet = null;
  let lastActivity = Date.now();
  const longGraceMs = msEnv("AUSTERE_AXI_DISCONNECT_GRACE_MS", 5 * 60_000);
  const idleMs = hub ? 0 : msEnv("AUSTERE_AXI_IDLE_TIMEOUT_MS", 30 * 60_000);

  const activity = () => {
    lastActivity = Date.now();
  };

  // ── helpers ──

  function hostsAllowed() {
    const extra = [];
    if (tailnet) extra.push(tailnet.ip, tailnet.dnsName);
    for (const h of listeners.keys()) extra.push(h);
    return allowedHosts(extra);
  }

  function links(id) {
    const local = `http://127.0.0.1:${port}/s/${id}`;
    const out = { local };
    if (tailnet && listeners.has(tailnet.ip)) out.remote = `http://${tailnet.dnsName || tailnet.ip}:${port}/s/${id}`;
    const linkHost = process.env.AUSTERE_AXI_LINK_HOST;
    if (linkHost) out.remote = `http://${linkHost}:${port}/s/${id}`;
    return out;
  }

  function send(res, status, body, headers = {}) {
    const isText = typeof body === "string" || Buffer.isBuffer(body);
    const payload = isText ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": isText ? headers["content-type"] || "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(payload);
  }

  async function readBody(req, limit = 2 * 1024 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error("payload too large"), { status: 413 });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("invalid JSON"), { status: 400 });
    }
  }

  function presence(s) {
    if (polls.has(s.id)) return "listening";
    if (s.workingSince) return "working";
    return "idle";
  }

  function publicSession(s) {
    return { id: s.id, file: s.file, title: s.title, status: s.status, endedBy: s.endedBy };
  }

  function broadcast(id, event, data) {
    const set = clients.get(id);
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of set) c.res.write(msg);
  }

  function broadcastPresence(s) {
    broadcast(s.id, "presence", { presence: presence(s), status: s.status, endedBy: s.endedBy });
  }

  function broadcastTranscript(s, entries) {
    broadcast(s.id, "transcript", { entries });
  }

  // ── file watching ──

  function readFileSafe(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  function watch(s) {
    if (watchers.has(s.id)) return;
    const html = readFileSafe(s.file);
    const art = html == null ? null : readArtifact(html);
    const w = { html, program: art?.program ?? null, shell: art?.shell ?? null, timer: null };
    watchers.set(s.id, w);
    if (art?.title) s.title = art.title;
    fs.watchFile(s.file, { interval: 300 }, () => {
      clearTimeout(w.timer);
      w.timer = setTimeout(() => onFileChange(s, w), 120);
    });
  }

  function unwatch(id) {
    const s = store.get(id);
    if (s) fs.unwatchFile(s.file);
    watchers.delete(id);
  }

  function onFileChange(s, w) {
    const html = readFileSafe(s.file);
    if (html == null || html === w.html) return;
    const art = readArtifact(html);
    const shellChanged = art.shell !== w.shell;
    w.html = html;
    w.program = art.program;
    w.shell = art.shell;
    s.revision += 1;
    if (art.title) s.title = art.title;
    log("change", s.id, `rev=${s.revision}`, shellChanged ? "shell" : "program");
    // Receipts: work started on delivered-but-unanswered feedback.
    const now = Date.now();
    const touched = [];
    for (const e of s.transcript) {
      if (e.role === "user" && e.seenAt && !e.doneAt && !e.workAt) {
        e.workAt = now;
        touched.push(e);
      }
    }
    if (touched.length) {
      store.touch(s);
      broadcastTranscript(s, touched);
    }
    broadcast(s.id, "changed", {
      revision: s.revision,
      program: art.program,
      shellChanged,
      title: art.title,
      thirdPartyPacks: thirdPartyPacks(html),
    });
  }

  /** Packs on this page not published by austere-axi: the chrome warns that their code runs in it. */
  function thirdPartyPacks(html) {
    return html ? pagePacks(html).thirdParty.map((p) => `${p.name}@${p.version}`) : [];
  }

  // ── polling ──

  function deliver(s, poll) {
    const entries = store.pendingEntries(s);
    const items = [];
    let end = false;
    for (const e of entries) {
      for (const it of e.items || []) items.push(it);
      if (e.end) end = true;
    }
    const body = {
      status: "feedback",
      items,
      ended: end || s.status === "ended" || undefined,
      endedBy: end || s.status === "ended" ? s.endedBy || "user" : undefined,
    };
    finishPoll(s, poll, body, () => {
      store.markDelivered(s, entries);
      s.workingSince = Date.now();
      broadcastTranscript(s, entries);
      broadcastPresence(s);
    });
  }

  function finishPoll(s, poll, body, onDelivered) {
    if (poll.done) return;
    poll.done = true;
    clearTimeout(graceTimers.get(s.id));
    graceTimers.delete(s.id);
    if (polls.get(s.id) === poll) polls.delete(s.id);
    poll.res.on("finish", () => onDelivered?.());
    send(poll.res, 200, body);
    broadcastPresence(s);
  }

  function clientCount(id) {
    return clients.get(id)?.size || 0;
  }

  function armGrace(s) {
    clearTimeout(graceTimers.get(s.id));
    graceTimers.delete(s.id);
    const poll = polls.get(s.id);
    if (!poll || clientCount(s.id) > 0 || !browserSeen.has(s.id)) return;
    const closedOnPurpose = Date.now() - (byeAt.get(s.id) || 0) < 5_000;
    const ms = closedOnPurpose ? Math.min(SHORT_GRACE_MS, longGraceMs || SHORT_GRACE_MS) : longGraceMs;
    if (!ms) return;
    graceTimers.set(
      s.id,
      setTimeout(() => {
        if (clientCount(s.id) === 0 && polls.get(s.id) === poll) {
          log("poll", s.id, "browser_disconnected");
          finishPoll(s, poll, { status: "browser_disconnected" });
        }
      }, ms),
    );
  }

  // ── routes ──

  async function handleApi(req, res, url) {
    if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: "control routes are loopback-only" });
    // The CLI sends no Origin; a browser always does on POST. Any web page could
    // otherwise reach these routes on localhost.
    if (req.headers.origin || req.headers["sec-fetch-site"]) return send(res, 403, { error: "control routes are for the CLI" });
    activity();
    const route = url.pathname.slice(5);
    if (route === "health") {
      return send(res, 200, {
        name: "austere-axi",
        version: VERSION,
        pid: process.pid,
        port,
        stateDir: stateDir(),
        listen: Array.from(listeners.keys()),
        tailnet: tailnet || undefined,
        hub: Boolean(hub),
        hubWanted,
      });
    }
    if (route === "sessions") {
      return send(res, 200, {
        sessions: store.list().map((s) => ({
          ...publicSession(s),
          presence: presence(s),
          browsers: clientCount(s.id),
          pending: s.pending.length,
          links: links(s.id),
        })),
      });
    }
    if (route === "shutdown" && req.method === "POST") {
      send(res, 200, { ok: true });
      setTimeout(() => shutdown("requested"), 50);
      return;
    }
    if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
    const body = await readBody(req);
    const file = typeof body.file === "string" ? body.file : "";
    if (!file) return send(res, 400, { error: "file is required" });

    if (route === "open") {
      if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${file}` });
      await ensureTailnetListener();
      const s = store.ensure(file);
      if (s.status === "ended") {
        if (s.endedBy === "user" && !body.reopen) {
          return send(res, 200, { status: "refused", session: publicSession(s), links: links(s.id) });
        }
        store.reopen(s);
        broadcastPresence(s);
      }
      watch(s);
      store.touch(s);
      return send(res, 200, {
        status: "open",
        session: publicSession(s),
        links: links(s.id),
        browsers: clientCount(s.id),
        pending: s.pending.length,
      });
    }

    const s = store.byFile(file);
    if (!s) return send(res, 404, { error: "no session for this file; open it first" });

    if (route === "reply") {
      const text = String(body.text || "").trim();
      if (!text) return send(res, 400, { error: "reply text is empty" });
      const entry = store.addAgentReply(s, text);
      s.workingSince = null;
      broadcastTranscript(s, [entry, ...s.transcript.filter((e) => e.role === "user" && e.doneAt === entry.at)]);
      broadcastPresence(s);
      return send(res, 200, { ok: true });
    }

    if (route === "feedback") {
      // A later agent session catching up: what no agent has acted on yet.
      // Unless peeking, pending entries count as received, so a poll does not repeat them.
      const { entries, fresh } = store.feedback(s, { all: !!body.all, peek: !!body.peek });
      if (fresh.length) {
        broadcastTranscript(s, fresh);
        broadcastPresence(s);
      }
      return send(res, 200, { session: publicSession(s), entries });
    }

    if (route === "end") {
      store.end(s, "agent");
      s.workingSince = null;
      const poll = polls.get(s.id);
      if (poll) finishPoll(s, poll, { status: "ended", endedBy: "agent" });
      broadcast(s.id, "ended", { by: "agent" });
      broadcastPresence(s);
      return send(res, 200, { ok: true });
    }

    if (route === "poll") {
      if (body.agentReply) {
        const entry = store.addAgentReply(s, String(body.agentReply).trim());
        broadcastTranscript(s, [entry, ...s.transcript.filter((e) => e.role === "user" && e.doneAt === entry.at)]);
      }
      s.workingSince = null;
      const existing = polls.get(s.id);
      if (existing && !existing.done) {
        if (!body.takeover) {
          return send(res, 409, {
            status: "listener_active",
            owner: existing.owner,
            error: "another poll is already listening on this session; pass --takeover to replace it",
          });
        }
        finishPoll(s, existing, { status: "replaced" });
      }
      const poll = { res, owner: body.owner || null, startedAt: Date.now(), done: false };
      if (s.pending.length) return deliver(s, poll);
      if (s.status === "ended") return send(res, 200, { status: "ended", endedBy: s.endedBy });
      polls.set(s.id, poll);
      res.on("close", () => {
        if (!poll.done) {
          poll.done = true;
          if (polls.get(s.id) === poll) polls.delete(s.id);
          clearTimeout(graceTimers.get(s.id));
          broadcastPresence(s);
        }
      });
      const timeoutMs = Number(body.timeoutMs);
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (!poll.done) finishPoll(s, poll, { status: "timeout" });
        }, timeoutMs);
      }
      broadcastPresence(s);
      armGrace(s);
      return;
    }
    return send(res, 404, { error: `unknown route ${route}` });
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      return o.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
    } catch {
      return false;
    }
  }

  /** An installed pack's script, only at the version in the lockfile and only if its hash still matches. */
  function serveInstalledPack(res, rel, url) {
    const m = /^installed-packs\/([^/]+)\/pack\.js$/.exec(rel);
    if (!m) return send(res, 404, "not found");
    let spec;
    try {
      spec = splitSpec(decodeURIComponent(m[1]));
    } catch {
      return send(res, 400, "bad pack name");
    }
    const file = installedPackFile(spec.name, spec.version);
    if (!file) return send(res, 404, `pack ${spec.name}@${spec.version} is not installed (austere-axi components add ${spec.name}@${spec.version})`);
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, "not found");
      const actual = `sha384-${crypto.createHash("sha384").update(buf).digest("base64")}`;
      const locked = readLock().packs[spec.name]?.integrity;
      const wanted = url.searchParams.get("integrity");
      if (locked && locked !== actual) {
        log("pack-integrity", spec.name, spec.version, "file changed since install");
        return send(res, 409, `pack ${spec.name}@${spec.version} changed on disk since it was installed; add it again`);
      }
      if (wanted && wanted !== actual) {
        log("pack-integrity", spec.name, spec.version, "page pins another build");
        return send(res, 409, `the page pins another build of ${spec.name}@${spec.version}; \`austere-axi check --fix <file>\` updates it`);
      }
      res.writeHead(200, {
        "content-type": MIME[".js"],
        "content-length": buf.length,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      res.end(buf);
    });
  }

  function serveAsset(res, rel, url) {
    if (rel.startsWith("installed-packs/")) return serveInstalledPack(res, rel, url);
    const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = path.join(ASSET_DIR, clean);
    if (!file.startsWith(ASSET_DIR + path.sep)) return send(res, 404, "not found");
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, "not found");
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  function serveArtifact(req, res, s, rest) {
    const dir = path.dirname(s.file);
    const base = path.basename(s.file);
    if (rest === base || rest === "") {
      const html = readFileSafe(s.file);
      if (html == null) return send(res, 404, "artifact file is missing");
      const out = rewriteRuntime(html, `<script src="/__austere/austere.js?v=${VERSION}"></script>`);
      return send(res, 200, out, { "content-type": "text/html; charset=utf-8" });
    }
    let decoded;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      return send(res, 400, "bad path");
    }
    const file = path.resolve(dir, decoded);
    if (!file.startsWith(dir + path.sep) || decoded.split(/[/\\]/).some((p) => p.startsWith("."))) {
      return send(res, 404, "not found");
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile() || st.size > 64 * 1024 * 1024) return send(res, 404, "not found");
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  function chromePage(s) {
    const boot = {
      id: s.id,
      title: s.title,
      file: s.file,
      name: path.basename(s.file),
      artifactUrl: `/s/${s.id}/a/${encodeURIComponent(path.basename(s.file))}`,
      version: VERSION,
    };
    return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(s.title)} · austere</title>
<link rel="stylesheet" href="/__austere/chrome/chrome.css?v=${VERSION}">
<script>window.__AUSTERE__=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>
<script src="/__austere/chrome/chrome.js?v=${VERSION}" defer></script>
</head>
<body></body>
</html>`;
  }

  function hubHome(url) {
    store.flushAll(); // writes (and so indexes) sessions changed in the last moments
    const q = (url.searchParams.get("q") || "").slice(0, 200);
    const project = (url.searchParams.get("project") || "").slice(0, 1000);
    return hubPage(hub.list({ q, project }), { version: VERSION, q, project, stats: hub.stats() });
  }

  function hubNotes(url) {
    store.flushAll();
    const q = (url.searchParams.get("q") || "").slice(0, 200);
    const project = (url.searchParams.get("project") || "").slice(0, 1000);
    const st = url.searchParams.get("status");
    const status = st === "unanswered" || st === "answered" ? st : "all";
    return notesPage(hub.notes({ q, project, status: status === "all" ? "" : status }), { version: VERSION, q, project, status, stats: hub.stats() });
  }

  /** Open an indexed artifact for review (it may never have had a session) and go to it. */
  function hubOpen(res, id) {
    const a = /^[a-f0-9]{12}$/.test(id) ? hub.artifact(id) : null;
    if (!a) return send(res, 404, "not in the hub");
    if (!fs.existsSync(a.file)) return send(res, 410, `${a.file} no longer exists`);
    const existed = store.byFile(a.file);
    const s = store.ensure(a.file);
    if (!existed) store.touch(s);
    res.writeHead(302, { location: `/s/${s.id}` });
    res.end();
  }

  function homePage() {
    const rows = store
      .list()
      .map(
        (s) =>
          `<li><a href="/s/${s.id}">${escapeHtml(s.title)}</a><span>${escapeHtml(s.file)}</span><em>${s.status === "ended" ? "ended" : presence(s)}</em></li>`,
      )
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>austere-axi</title>
<style>body{margin:0;background:#0b0b0d;color:#e8e8ec;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:40px 20px}h1{font-size:18px;font-weight:600}ul{list-style:none;padding:0}li{display:grid;gap:2px;padding:12px 0;border-bottom:1px solid #222}a{color:#a9c1ff;text-decoration:none;font-weight:600}span{color:#8a8a94;font-size:12px;overflow-wrap:anywhere}em{color:#8a8a94;font-style:normal;font-size:12px}</style></head>
<body><main><h1>austere-axi <small style="color:#777;font-weight:400">${VERSION}</small></h1><ul>${rows || "<li>No sessions yet.</li>"}</ul></main></body></html>`;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const host = hostOnly(req.headers.host);
    if (!hostsAllowed().has(host) && process.env.AUSTERE_AXI_ALLOWED_HOSTS !== "*") {
      return send(res, 403, "host not allowed");
    }
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (url.pathname.startsWith("/__austere/")) return serveAsset(res, url.pathname.slice("/__austere/".length), url);
    if (url.pathname === "/") {
      return send(res, 200, hub ? hubHome(url) : homePage(), { "content-type": "text/html; charset=utf-8" });
    }
    if (hub && url.pathname === "/notes") return send(res, 200, hubNotes(url), { "content-type": "text/html; charset=utf-8" });
    if (hub && url.pathname.startsWith("/hub/open/")) return hubOpen(res, url.pathname.slice("/hub/open/".length));
    if (url.pathname === "/favicon.ico") return send(res, 204, "");

    const m = /^\/s\/([a-f0-9]{12})(\/.*)?$/.exec(url.pathname);
    if (!m) return send(res, 404, "not found");
    const s = store.get(m[1]);
    if (!s) return send(res, 404, "no such session");
    const sub = m[2] || "";
    activity();

    if (sub === "" || sub === "/") {
      watch(s);
      return send(res, 200, chromePage(s), { "content-type": "text/html; charset=utf-8" });
    }
    if (sub.startsWith("/a/")) return serveArtifact(req, res, s, sub.slice(3));

    if (sub === "/events") {
      watch(s);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 2000\n\n");
      const w = watchers.get(s.id);
      const snapshot = {
        session: publicSession(s),
        presence: presence(s),
        transcript: s.transcript.slice(-200),
        revision: s.revision,
        program: w?.program ?? null,
        thirdPartyPacks: thirdPartyPacks(w?.html),
        version: VERSION,
        links: links(s.id),
      };
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      const client = { res };
      if (!clients.has(s.id)) clients.set(s.id, new Set());
      clients.get(s.id).add(client);
      browserSeen.add(s.id);
      clearTimeout(graceTimers.get(s.id));
      graceTimers.delete(s.id);
      const hb = setInterval(() => res.write(": hb\n\n"), 20_000);
      res.on("close", () => {
        clearInterval(hb);
        clients.get(s.id)?.delete(client);
        armGrace(s);
      });
      return;
    }

    if (req.method === "POST" && !checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });

    if (sub === "/send" && req.method === "POST") {
      const body = await readBody(req, 4 * 1024 * 1024);
      const items = Array.isArray(body.items) ? body.items.filter((x) => x && typeof x === "object").slice(0, 200) : [];
      if (s.status === "ended") return send(res, 409, { error: "session has ended" });
      if (!items.length && !body.end) return send(res, 400, { error: "nothing to send" });
      for (const it of items) it.id = it.id || newId("i");
      let entry = null;
      if (items.length) entry = store.addUserBatch(s, items, { end: !!body.end });
      if (body.end) {
        store.end(s, "user");
        broadcast(s.id, "ended", { by: "user" });
      }
      if (entry) broadcastTranscript(s, [entry]);
      const poll = polls.get(s.id);
      if (poll && !poll.done) {
        if (s.pending.length) deliver(s, poll);
        else if (body.end) finishPoll(s, poll, { status: "ended", endedBy: "user" });
      }
      broadcastPresence(s);
      return send(res, 200, { ok: true, entry });
    }
    if (sub === "/end" && req.method === "POST") {
      if (s.status !== "ended") {
        store.end(s, "user");
        broadcast(s.id, "ended", { by: "user" });
        const poll = polls.get(s.id);
        if (poll && !poll.done) {
          if (s.pending.length) deliver(s, poll);
          else finishPoll(s, poll, { status: "ended", endedBy: "user" });
        }
        broadcastPresence(s);
      }
      return send(res, 200, { ok: true });
    }
    if (sub === "/bye" && req.method === "POST") {
      byeAt.set(s.id, Date.now());
      return send(res, 204, "");
    }
    if (sub === "/export") {
      const html = readFileSafe(s.file);
      if (html == null) return send(res, 404, "artifact file is missing");
      try {
        const out = exportHtml(html);
        const name = path.basename(s.file).replace(/\.html?$/i, "") + ".export.html";
        return send(res, 200, out.html, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
        });
      } catch (err) {
        return send(res, 500, String(err.message || err));
      }
    }
    return send(res, 404, "not found");
  }

  // ── listening ──

  function listen(host) {
    return new Promise((resolve) => {
      if (listeners.has(host)) return resolve(true);
      const server = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          log("error", req.method, req.url, String(err?.stack || err));
          if (!res.headersSent) send(res, err.status || 500, { error: String(err.message || err) });
          else res.end();
        });
      });
      server.keepAliveTimeout = 65_000;
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.once("error", (err) => {
        log("listen-failed", host, err.code || err.message);
        resolve(false);
      });
      server.listen(port, host, () => {
        listeners.set(host, server);
        log("listening", `${host}:${port}`);
        resolve(true);
      });
    });
  }

  async function ensureTailnetListener() {
    const explicit = process.env.AUSTERE_AXI_HOST;
    if (explicit && !/^(0\.0\.0\.0|::|\*)$/.test(explicit)) {
      await listen(explicit);
      return;
    }
    tailnet = await detectTailscale();
    if (tailnet && !listeners.has(tailnet.ip)) await listen(tailnet.ip);
  }

  const ok = await listen("127.0.0.1");
  if (!ok) throw new Error(`could not listen on 127.0.0.1:${port} (is another server using it? set AUSTERE_AXI_PORT)`);
  for (const h of alsoListen) await listen(h);
  await ensureTailnetListener();

  let stopping = false;
  function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    log("shutdown", reason);
    for (const [id, set] of clients) {
      for (const c of set) {
        c.res.write(`event: server\ndata: ${JSON.stringify({ state: "stopped", reason })}\n\n`);
        c.res.end();
      }
      clients.delete(id);
    }
    for (const [id, poll] of polls) {
      const s = store.get(id);
      if (s && !poll.done) finishPoll(s, poll, { status: "interrupted", reason });
    }
    for (const id of watchers.keys()) unwatch(id);
    store.flushAll();
    for (const server of listeners.values()) server.close();
    setTimeout(() => process.exit(0), 100).unref();
  }

  if (idleMs > 0) {
    setInterval(() => {
      const busy = polls.size > 0 || Array.from(clients.values()).some((set) => set.size > 0);
      if (busy) activity();
      else if (Date.now() - lastActivity > idleMs) shutdown("idle");
    }, Math.min(60_000, idleMs)).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  log("started", `v${VERSION}`, `pid=${process.pid}`);
  return { port, shutdown };
}
