// Team review: invite links, reviewer identity, the hold queue, auto mode, revoke.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { InviteStore, cleanName, inviteId, tokenFromCookie } from "../src/cli/invites.js";
import { SessionStore } from "../src/cli/sessions.js";
import { Hub, hubUnsupported } from "../src/cli/hub.js";

const skipHub = hubUnsupported() || false;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── invites ──

test("an invite token maps to its reviewer, and revoking removes it", () => {
  const dir = tmp("austere-inv-");
  try {
    const store = new InviteStore(dir);
    const ana = store.add({ name: "  Ana ", sessionId: "aaaaaaaaaaaa", file: "/p/plan.html" });
    const bo = store.add({ name: "Bo", sessionId: "aaaaaaaaaaaa", file: "/p/plan.html", auto: true });
    assert.ok(Buffer.from(ana.token, "base64url").length >= 16, "at least 128 bits");
    assert.notEqual(ana.token, bo.token);
    assert.equal(store.find(ana.token)?.name, "Ana");
    assert.equal(store.find(bo.token)?.auto, true);
    assert.equal(store.find(ana.token + "x"), null);
    assert.equal(store.find(""), null);
    assert.equal(store.find(undefined), null);

    // Invites survive a restart.
    assert.equal(new InviteStore(dir).find(ana.token)?.name, "Ana");

    assert.throws(() => store.add({ name: "ana", sessionId: "aaaaaaaaaaaa", file: "/p/plan.html" }), /already shared/);
    assert.throws(() => store.add({ name: "Owner", sessionId: "bbbbbbbbbbbb", file: "/p/x.html" }), /reserved/);
    assert.throws(() => cleanName(""), /name is required/);
    assert.equal(cleanName("A\u0000\nB"), "A B");

    assert.deepEqual(store.revoke("nobody"), []);
    assert.equal(store.revoke(inviteId(ana)).length, 1, "by short id");
    assert.equal(store.find(ana.token), null, "revoked token no longer matches");
    assert.equal(new InviteStore(dir).find(ana.token), null, "and stays revoked after a restart");
    assert.equal(store.revoke("BO")[0].name, "Bo", "by name, any case");
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the cookie header yields the token", () => {
  assert.equal(tokenFromCookie("a=1; austere_rv=abc_-9; b=2"), "abc_-9");
  assert.equal(tokenFromCookie("other=1"), null);
  assert.equal(tokenFromCookie(undefined), null);
});

// ── the hold queue ──

test("held notes stay out of pending, poll and feedback until the owner sends them", () => {
  const dir = tmp("austere-hold-");
  try {
    const store = new SessionStore(dir);
    const s = store.ensure(path.join(dir, "plan.html"));
    const note = (text) => [{ kind: "message", text, id: text }];
    const mine = store.addUserBatch(s, note("owner note"));
    const held = store.addUserBatch(s, note("held note"), { author: "Ana", hold: true });
    const auto = store.addUserBatch(s, note("auto note"), { author: "Bo" });

    assert.deepEqual(s.pending, [mine.id, auto.id], "the held entry is not pending");
    assert.deepEqual(store.pendingEntries(s).map((e) => e.id), [mine.id, auto.id], "so a poll does not deliver it");
    assert.deepEqual(store.heldEntries(s).map((e) => e.id), [held.id]);

    const peek = store.feedback(s, { peek: true });
    assert.deepEqual(peek.entries.map((e) => e.id), [mine.id, auto.id], "feedback skips it");
    assert.equal(peek.entries[1].author, "Bo");
    assert.equal(peek.entries[0].author, undefined, "the owner has no author");

    const out = store.release(s, [held.id]);
    assert.equal(out.length, 1);
    assert.equal(held.held, false);
    assert.ok(s.pending.includes(held.id), "released notes are pending");
    assert.deepEqual(store.release(s, [held.id]), [], "releasing twice does nothing");

    const dropped = store.addUserBatch(s, note("drop me"), { author: "Ana", hold: true });
    store.discard(s, [dropped.id]);
    assert.equal(dropped.discarded, true);
    assert.ok(!s.pending.includes(dropped.id));
    assert.ok(!store.feedback(s, { all: true, peek: true }).entries.some((e) => e.id === dropped.id), "discarded notes never come back");

    // A restart keeps held notes held.
    const again = store.addUserBatch(s, note("still held"), { author: "Ana", hold: true });
    store.flush(s);
    const reloaded = new SessionStore(dir).get(s.id);
    assert.equal(reloaded.transcript.find((e) => e.id === again.id).held, true);
    assert.ok(!reloaded.pending.includes(again.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the hub ──

test("the hub records the author and held status, and filters on the author", { skip: skipHub }, async () => {
  const dir = tmp("austere-hubauthor-");
  const hub = await Hub.open(path.join(dir, "hub.db"));
  try {
    const store = new SessionStore(dir);
    const s = store.ensure(path.join(dir, "plan.html"));
    store.addUserBatch(s, [{ kind: "message", text: "from the owner", id: "i1" }]);
    const held = store.addUserBatch(s, [{ kind: "message", text: "from Ana, held", id: "i2" }], { author: "Ana", hold: true });
    store.addUserBatch(s, [{ kind: "annotation", target: "intro", note: "from Bo", id: "i3" }], { author: "Bo" });
    const dropped = store.addUserBatch(s, [{ kind: "message", text: "from Ana, dropped", id: "i4" }], { author: "Ana", hold: true });
    store.discard(s, [dropped.id]);
    hub.syncSession(s);

    const all = hub.notes();
    assert.deepEqual(all.map((n) => n.id).sort(), ["i1", "i2", "i3"], "discarded notes are left out");
    assert.equal(all.find((n) => n.id === "i2").author, "Ana");
    assert.equal(all.find((n) => n.id === "i2").status, "held");
    assert.deepEqual(hub.notes({ author: "Ana" }).map((n) => n.id), ["i2"]);
    assert.deepEqual(hub.notes({ author: "owner" }).map((n) => n.id), ["i1"]);
    assert.deepEqual(hub.authors(), ["Ana", "Bo"]);
    assert.equal(hub.list()[0].held, 1);
    assert.equal(hub.stats().unanswered, 3, "held notes count as unanswered");

    store.release(s, [held.id]);
    hub.syncSession(s);
    assert.equal(hub.notes({ author: "Ana" })[0].status, "open", "sent on, now open");
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an index made before team review gains the author column", { skip: skipHub }, async () => {
  const dir = tmp("austere-hubmigrate-");
  const file = path.join(dir, "hub.db");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, file TEXT NOT NULL UNIQUE, project TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0, status TEXT, ended_by TEXT);
      CREATE TABLE items (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, entry_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT, text TEXT, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE replies (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
      INSERT INTO artifacts VALUES ('aaaaaaaaaaaa', '/p/plan.html', '/p', 'Plan', 1, 1, 1, 'open', NULL);
      INSERT INTO items VALUES ('old1', 'aaaaaaaaaaaa', 'u1', 5, 'message', NULL, 'an old note', 'open', '{}');`);
    old.close();
    const hub = await Hub.open(file);
    try {
      assert.equal(hub.notes()[0].id, "old1");
      assert.equal(hub.notes()[0].author, "", "old notes read as the owner's");
      assert.deepEqual(hub.notes({ author: "owner" }).map((n) => n.id), ["old1"]);
    } finally {
      hub.close();
    }
    (await Hub.open(file)).close(); // opening again does not fail
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the server ──

function startServer(extraEnv) {
  const port = 49000 + Math.floor(Math.random() * 900);
  const state = tmp("austere-team-state-");
  const child = spawn(process.execPath, ["src/cli/main.js", "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1", ...extraEnv },
    stdio: "ignore",
  });
  return { port, state, child };
}

/** `remote`: send from 127.0.0.2, which the server does not count as loopback, like a tailnet peer. */
function request(port, method, route, { body, headers = {}, remote = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method, path: route, ...(remote ? { localAddress: "127.0.0.2" } : {}), headers: { host: `127.0.0.1:${port}`, ...(payload ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Open an event stream and collect what arrives. */
function stream(port, route, headers = {}) {
  const events = [];
  let ended = false;
  const r = http.request({ host: "127.0.0.1", port, path: route, headers: { host: `127.0.0.1:${port}`, ...headers } });
  const done = new Promise((resolve) => {
    r.on("response", (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) events.push({ name, data: data ? JSON.parse(data) : null });
        }
      });
      res.on("end", () => {
        ended = true;
        resolve();
      });
      res.on("error", () => resolve());
    });
    r.on("error", () => resolve());
  });
  r.end();
  return { events, done, isEnded: () => ended, close: () => r.destroy() };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

async function up(port) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await request(port, "GET", "/api/health")).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

async function stop(s) {
  if (s.child.exitCode === null) {
    const exited = new Promise((r) => s.child.once("exit", r));
    s.child.kill();
    await exited;
  }
  fs.rmSync(s.state, { recursive: true, force: true });
}

const WORK = tmp("austere-team-work-");
const FILE = path.join(WORK, "plan.html");
let srv;
let id;

before(async () => {
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
  srv = startServer({ AUSTERE_AXI_LINK_HOST: "127.0.0.1" });
  await up(srv.port);
  id = (await request(srv.port, "POST", "/api/open", { body: { file: FILE } })).data.session.id;
});

after(async () => {
  await stop(srv);
  fs.rmSync(WORK, { recursive: true, force: true });
});

const share = (name, auto = false) => request(srv.port, "POST", "/api/share", { body: { file: FILE, name, auto } });

/** Follow an invite link: the cookie the server sets, as a browser would send it back. */
async function accept(link) {
  const u = new URL(link);
  const r = await request(srv.port, "GET", u.pathname + u.search);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/s/${id}`, "the token is gone from the URL");
  const set = [].concat(r.headers["set-cookie"])[0];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/, "Lax, so the cookie comes back after a click in chat or email");
  assert.match(set, new RegExp(`Path=/s/${id}`));
  return { cookie: set.split(";")[0] };
}

const sendNote = (as, text, extra = {}) =>
  request(srv.port, "POST", `/s/${id}/send`, {
    body: { items: [{ kind: "message", text }], ...extra },
    headers: { origin: `http://127.0.0.1:${srv.port}`, ...(as ? { cookie: as.cookie } : {}) },
  });

test("sharing prints a tailnet link with a long random token", async () => {
  const r = await share("Ana");
  assert.equal(r.status, 200);
  assert.match(r.data.link, new RegExp(`^http://127\\.0\\.0\\.1:${srv.port}/s/${id}\\?invite=[A-Za-z0-9_-]{32,}$`));
  const dup = await share("ana");
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /already shared/);
  assert.equal((await request(srv.port, "POST", "/api/share", { body: { file: FILE, name: "" } })).status, 400);
  const listed = await request(srv.port, "GET", "/api/share/list");
  assert.equal(listed.data.invites[0].link, undefined, "list hides links unless asked");
  const withLinks = await request(srv.port, "GET", "/api/share/list?links=1");
  assert.equal(withLinks.data.invites[0].link, r.data.link);
  assert.equal((await request(srv.port, "POST", "/api/share/revoke", { body: { key: "Ana" } })).status, 200);
});

test("sharing fails clearly when no tailnet address is up", async () => {
  const other = startServer({});
  const file = path.join(WORK, "other.html");
  fs.writeFileSync(file, fs.readFileSync(FILE));
  try {
    await up(other.port);
    const r = await request(other.port, "POST", "/api/share", { body: { file, name: "Ana" } });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Tailscale/);
    assert.match(r.data.error, /AUSTERE_AXI_HOST/);
  } finally {
    await stop(other);
  }
});

test("an invalid or missing token is refused; a cookie for a revoked invite is not the owner", async () => {
  assert.equal((await request(srv.port, "GET", `/s/${id}?invite=nope`)).status, 403);
  assert.equal((await request(srv.port, "GET", `/s/${id}`)).status, 200, "no invite: the owner, as before");
  const bad = await request(srv.port, "GET", `/s/${id}`, { headers: { cookie: "austere_rv=forged" } });
  assert.equal(bad.status, 403, "a forged cookie does not fall back to the owner");
  assert.match([].concat(bad.headers["set-cookie"])[0], /Max-Age=0/);
});

test("a held note waits: poll and feedback skip it until the owner sends it", async () => {
  const link = (await share("Ana")).data.link;
  const ana = await accept(link);

  // The reviewer's page names them and hides owner controls.
  const page = await request(srv.port, "GET", `/s/${id}`, { headers: { cookie: ana.cookie } });
  assert.equal(page.status, 200);
  assert.match(page.data, /"viewer":\{"role":"reviewer","name":"Ana"/);
  assert.ok(!page.data.includes(path.basename(WORK)), "the owner's path is not in the reviewer's page");

  const sent = await sendNote(ana, "please shorten this");
  assert.equal(sent.status, 200);
  assert.equal(sent.data.entry.author, "Ana");
  assert.equal(sent.data.entry.held, true);

  // Nothing for the agent.
  const poll = await request(srv.port, "POST", "/api/poll", { body: { file: FILE, timeoutMs: 300 } });
  assert.equal(poll.data.status, "timeout", "poll does not return held notes");
  const fb = await request(srv.port, "POST", "/api/feedback", { body: { file: FILE, all: true } });
  assert.deepEqual(fb.data.entries, []);
  const open = await request(srv.port, "POST", "/api/open", { body: { file: FILE } });
  assert.equal(open.data.pending, 0);
  assert.equal(open.data.held, 1);

  // A listening poll wakes when the owner sends the note on.
  const waiting = request(srv.port, "POST", "/api/poll", { body: { file: FILE } });
  await new Promise((r) => setTimeout(r, 100));
  const entryId = sent.data.entry.id;
  const released = await request(srv.port, "POST", `/s/${id}/release`, { body: { ids: [entryId] }, headers: { origin: `http://127.0.0.1:${srv.port}` } });
  assert.equal(released.data.count, 1);
  const delivered = await waiting;
  assert.equal(delivered.data.status, "feedback");
  assert.equal(delivered.data.items[0].text, "please shorten this");
  assert.equal(delivered.data.items[0].author, "Ana", "the agent can tell who wrote it");
  await request(srv.port, "POST", "/api/reply", { body: { file: FILE, text: "done" } });
  await request(srv.port, "POST", "/api/share/revoke", { body: { key: "Ana" } });
});

test("auto mode goes straight to the agent; discard keeps a note from it", async () => {
  const bo = await accept((await share("Bo", true)).data.link);
  const waiting = request(srv.port, "POST", "/api/poll", { body: { file: FILE, takeover: true } });
  await new Promise((r) => setTimeout(r, 100));
  const sent = await sendNote(bo, "straight through");
  assert.equal(sent.data.entry.held, undefined);
  const got = await waiting;
  assert.equal(got.data.status, "feedback");
  assert.equal(got.data.items[0].author, "Bo");
  await request(srv.port, "POST", "/api/reply", { body: { file: FILE, text: "ok" } });

  const cy = await accept((await share("Cy")).data.link);
  const held = (await sendNote(cy, "not for the agent")).data.entry;
  const origin = { origin: `http://127.0.0.1:${srv.port}` };
  const dropped = await request(srv.port, "POST", `/s/${id}/discard`, { body: { all: true }, headers: origin });
  assert.equal(dropped.data.count, 1);
  const poll = await request(srv.port, "POST", "/api/poll", { body: { file: FILE, timeoutMs: 200 } });
  assert.equal(poll.data.status, "timeout");
  assert.ok(held.id);
  for (const name of ["Bo", "Cy"]) await request(srv.port, "POST", "/api/share/revoke", { body: { key: name } });
});

test("reviewers add notes and nothing else", async () => {
  const dee = await accept((await share("Dee")).data.link);
  const h = { cookie: dee.cookie, origin: `http://127.0.0.1:${srv.port}` };
  assert.equal((await request(srv.port, "POST", `/s/${id}/end`, { body: {}, headers: h })).status, 403, "cannot end the review");
  assert.equal((await request(srv.port, "GET", `/s/${id}/export`, { headers: { cookie: dee.cookie } })).status, 403, "cannot export");
  assert.equal((await request(srv.port, "POST", `/s/${id}/release`, { body: { all: true }, headers: h })).status, 403, "cannot send held notes on");
  assert.equal((await request(srv.port, "POST", `/s/${id}/discard`, { body: { all: true }, headers: h })).status, 403);
  assert.equal((await request(srv.port, "GET", `/s/${id}/a/plan.html`, { headers: { cookie: dee.cookie } })).status, 200, "can read the page");

  // `end` in a send is ignored, and only notes get through.
  const r = await request(srv.port, "POST", `/s/${id}/send`, {
    body: {
      end: true,
      items: [
        { kind: "action", message: "run this" },
        { kind: "render-error", message: "x" },
        { kind: "message", text: "kept", author: "Owner", id: "taken" },
      ],
    },
    headers: h,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.entry.items.length, 1);
  assert.equal(r.data.entry.items[0].text, "kept");
  assert.notEqual(r.data.entry.items[0].id, "taken", "the server picks the id");
  assert.equal(r.data.entry.author, "Dee", "the author comes from the invite, not the request");
  const sessions = await request(srv.port, "GET", "/api/sessions");
  assert.equal(sessions.data.sessions.find((s) => s.id === id).status, "open");

  // A cross-origin post is still refused.
  const cross = await request(srv.port, "POST", `/s/${id}/send`, { body: { items: [{ kind: "message", text: "x" }] }, headers: { cookie: dee.cookie, origin: "http://evil.example" } });
  assert.equal(cross.status, 403);
  await request(srv.port, "POST", "/api/share/revoke", { body: { key: "Dee" } });
  await request(srv.port, "POST", `/s/${id}/discard`, { body: { all: true }, headers: { origin: `http://127.0.0.1:${srv.port}` } });
});

test("reviewers see their own held notes but not another reviewer's", async () => {
  const eve = await accept((await share("Eve")).data.link);
  const fay = await accept((await share("Fay")).data.link);
  const origin = `http://127.0.0.1:${srv.port}`;
  const evesStream = stream(srv.port, `/s/${id}/events`, { cookie: eve.cookie });
  const owner = stream(srv.port, `/s/${id}/events`);
  const fays = stream(srv.port, `/s/${id}/events`, { cookie: fay.cookie });
  try {
    assert.ok(await until(() => evesStream.events.some((e) => e.name === "snapshot") && fays.events.some((e) => e.name === "snapshot")));
    const sent = (await sendNote(eve, "eve's held note")).data.entry;
    assert.ok(await until(() => owner.events.some((e) => e.name === "transcript" && e.data.entries.some((x) => x.id === sent.id && x.held))), "the owner sees it held");
    assert.ok(await until(() => evesStream.events.some((e) => e.name === "transcript")), "its author sees it");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!fays.events.some((e) => e.name === "transcript"), "another reviewer does not");
    const fayPage = await request(srv.port, "GET", `/s/${id}`, { headers: { cookie: fay.cookie } });
    assert.equal(fayPage.status, 200);

    await request(srv.port, "POST", `/s/${id}/release`, { body: { all: true }, headers: { origin } });
    assert.ok(await until(() => fays.events.some((e) => e.name === "transcript" && e.data.entries.some((x) => x.id === sent.id && !x.held))), "once sent on, everyone sees it");
  } finally {
    evesStream.close();
    owner.close();
    fays.close();
    for (const name of ["Eve", "Fay"]) await request(srv.port, "POST", "/api/share/revoke", { body: { key: name } });
  }
});

test("revoking cuts access at once, including open event streams", async () => {
  const link = (await share("Gus", true)).data.link;
  const gus = await accept(link);
  const live = stream(srv.port, `/s/${id}/events`, { cookie: gus.cookie });
  try {
    assert.ok(await until(() => live.events.some((e) => e.name === "snapshot")));
    assert.equal((await sendNote(gus, "before")).status, 200);

    const r = await request(srv.port, "POST", "/api/share/revoke", { body: { key: "Gus" } });
    assert.equal(r.status, 200);
    assert.equal(r.data.revoked[0].name, "Gus");

    assert.ok(await until(() => live.isEnded()), "the open stream is closed");
    assert.ok(live.events.some((e) => e.name === "server" && e.data.state === "revoked"));
    assert.equal((await sendNote(gus, "after")).status, 403, "the cookie no longer works");
    assert.equal((await request(srv.port, "GET", `/s/${id}`, { headers: { cookie: gus.cookie } })).status, 403);
    const again = new URL(link);
    assert.equal((await request(srv.port, "GET", again.pathname + again.search)).status, 403, "the link is dead too");
    assert.equal((await request(srv.port, "POST", "/api/share/revoke", { body: { key: "Gus" } })).status, 404);
  } finally {
    live.close();
    await request(srv.port, "POST", `/s/${id}/discard`, { body: { all: true }, headers: { origin: `http://127.0.0.1:${srv.port}` } });
  }
});

test("the server log never holds a token", async () => {
  const r = await share("Hal");
  const token = new URL(r.data.link).searchParams.get("invite");
  await accept(r.data.link);
  await request(srv.port, "POST", "/api/share/revoke", { body: { key: "Hal" } });
  const log = fs.readFileSync(path.join(srv.state, "server.log"), "utf8");
  assert.ok(log.includes("share Hal"), "shares are logged by name");
  assert.ok(!log.includes(token));
});

// Off loopback (a tailnet peer), nobody is the owner without the owner key. Otherwise a reviewer
// could open the page URL from their invite without the cookie and skip the hold queue.
const canBindRemote = process.platform !== "darwin";

test("off loopback, the hub and pages need the owner key or an invite", { skip: !canBindRemote }, async () => {
  for (const p of ["/", "/notes", `/s/${id}`, `/s/${id}/events`]) {
    assert.equal((await request(srv.port, "GET", p, { remote: true })).status, 403, `${p} is refused without a key`);
  }
  assert.equal((await request(srv.port, "GET", `/s/${id}?key=wrong`, { remote: true })).status, 403);

  const remote = (await request(srv.port, "POST", "/api/open", { body: { file: FILE } })).data.links.remote;
  const u = new URL(remote);
  assert.match(u.search, /^\?key=[A-Za-z0-9_-]{32,}$/, "the owner's remote link carries the key");
  const r = await request(srv.port, "GET", u.pathname + u.search, { remote: true });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/s/${id}`, "the key is gone from the URL");
  const set = [].concat(r.headers["set-cookie"])[0];
  assert.match(set, /^austere_owner=.*HttpOnly; SameSite=Lax/);
  const owner = { cookie: set.split(";")[0] };
  assert.equal((await request(srv.port, "GET", `/s/${id}`, { remote: true, headers: owner })).status, 200);
  assert.equal((await request(srv.port, "GET", "/", { remote: true, headers: owner })).status, 200);

  const ana = await accept((await share("Ana")).data.link);
  try {
    assert.equal((await request(srv.port, "GET", `/s/${id}`, { remote: true, headers: ana })).status, 200, "the reviewer gets in");
    assert.equal((await request(srv.port, "GET", "/", { remote: true, headers: ana })).status, 403, "but not to the hub");
    const held = await request(srv.port, "POST", `/s/${id}/release`, { remote: true, body: { all: true }, headers: { origin: `http://127.0.0.1:${srv.port}` } });
    assert.equal(held.status, 403, "dropping the cookie does not make a reviewer the owner");
  } finally {
    await request(srv.port, "POST", "/api/share/revoke", { body: { key: "Ana" } });
  }
});
