// Durable notes: hub.db is the record, poll is a cursor read with at-least-once
// delivery, ending a review stops the agent but not the reviewer, and only the
// owner's close locks the review.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingHttpHeaders } from "node:http";
import { SessionStore, sessionId } from "../src/cli/sessions.ts";
import type { Session } from "../src/cli/sessions.ts";
import { Hub } from "../src/cli/hub.ts";
import { freePort } from "./port.ts";
import { ownerKey } from "../src/cli/invites.ts";
import { ownerHeaders } from "./owner.ts";

interface Note {
  id: string;
  text: string;
  author?: string;
  held?: boolean;
}

interface SessionRow {
  id: string;
  status: string;
  pending: number;
}

/** Every response body field these tests read; each route fills in its own. */
interface Body {
  status: string;
  closed: boolean;
  ended: boolean;
  cursor: number;
  items: Note[];
  entry: Note;
  session: { id: string };
  sessions: SessionRow[];
  link: string;
  pid: number;
  version: string;
  persist: boolean;
}

interface Res {
  status: number | undefined;
  data: Body;
  headers: IncomingHttpHeaders;
}

interface ServerProc {
  child: ChildProcessWithoutNullStreams;
  out: string;
  exited: Promise<number | null>;
}

interface Ctx {
  port: number;
  state: string;
  id: string;
  proc: ServerProc;
}

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const WORK = tmp("austere-durable-work-");
const FILE = path.join(WORK, "plan.html");
const BASE_ENV = { ...process.env, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1", OPENUI_TELEMETRY_DISABLED: "1" };

// The state dir of the server on each port: requests go as its owner, unless they bring a reviewer's cookie.
const stateOf = new Map<number, string>();

function request(port: number, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const owner = stateOf.has(port) ? ownerHeaders(stateOf.get(port) as string) : {};
    const r = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { host: `127.0.0.1:${port}`, ...(payload ? { "content-type": "application/json" } : {}), ...owner, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: unknown = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, data: parsed as Body, headers: res.headers });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Run the server in the foreground; `out` collects what it prints. */
function startServer(port: number, state: string, extraEnv: Record<string, string> = {}): ServerProc {
  stateOf.set(port, state);
  const child = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: state, ...extraEnv },
  });
  const proc: ServerProc = { child, out: "", exited: new Promise<number | null>((r) => child.once("exit", r)) };
  child.stdout.on("data", (c) => (proc.out += c));
  child.stderr.on("data", (c) => (proc.out += c));
  return proc;
}

async function up(port: number) {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await request(port, "GET", "/api/health")).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

async function kill(proc: ServerProc, signal: NodeJS.Signals = "SIGTERM") {
  if (proc.child.exitCode === null && proc.child.signalCode === null) {
    proc.child.kill(signal);
    await proc.exited;
  }
}

function cli(port: number, state: string, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.ts", ...args], {
      env: { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const page = (port: number) => ({ origin: `http://127.0.0.1:${port}` });
const message = (text: string) => ({ items: [{ kind: "message", text }] });

/** Share the plan with a reviewer and join as them, through the invite form; returns their cookie header. */
async function invite(port: number, id: string, name: string): Promise<string> {
  const share = await request(port, "POST", "/api/share", { file: FILE, name });
  assert.equal(share.status, 200, JSON.stringify(share.data));
  const token = new URL(share.data.link).searchParams.get("invite");
  const set = await new Promise<string[] | undefined>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method: "POST", path: `/s/${id}/join`, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers["set-cookie"]));
      },
    );
    r.on("error", reject);
    r.end(new URLSearchParams({ invite: token as string }).toString());
  });
  return ([] as string[]).concat(set ?? [])[0].split(";")[0];
}

before(() => {
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
});

after(() => fs.rmSync(WORK, { recursive: true, force: true }));

/** A server of its own for one test, with the plan open. */
async function withServer(fn: (ctx: Ctx) => Promise<void>, extraEnv?: Record<string, string>) {
  const port = await freePort();
  const state = tmp("austere-durable-state-");
  const proc = startServer(port, state, extraEnv);
  try {
    await up(port);
    const id = (await request(port, "POST", "/api/open", { file: FILE })).data.session.id;
    await fn({ port, state, id, proc });
  } finally {
    await kill(proc);
    fs.rmSync(state, { recursive: true, force: true });
  }
}

test("a note sent after the agent ended is kept, and the next poll returns it and reopens the review", () =>
  withServer(async ({ port, id }) => {
    assert.equal((await request(port, "POST", "/api/end", { file: FILE })).status, 200);
    const sent = await request(port, "POST", `/s/${id}/send`, message("one more thing"), page(port));
    assert.equal(sent.status, 200, "an ended review still takes notes");
    const sessions = (await request(port, "GET", "/api/sessions")).data.sessions;
    assert.equal(sessions.find((s) => s.id === id)?.pending, 1, "waiting for the agent");

    const poll = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(poll.data.status, "feedback");
    assert.equal(poll.data.items[0].text, "one more thing");
    assert.equal(poll.data.ended, undefined, "not handed over as a final batch");
    assert.equal((await request(port, "GET", "/api/sessions")).data.sessions.find((s) => s.id === id)?.status, "open");

    // A batch sent with end stays final: delivered with ended, and the review stays ended.
    await request(port, "POST", `/s/${id}/send`, { ...message("last words"), end: true }, page(port));
    const last = await request(port, "POST", "/api/poll", { file: FILE, cursor: poll.data.cursor });
    assert.equal(last.data.status, "feedback");
    assert.equal(last.data.ended, true);
    const after = await request(port, "POST", "/api/poll", { file: FILE, cursor: last.data.cursor });
    assert.equal(after.data.status, "ended");
  }));

test("a note survives the server being killed between send and poll", async () => {
  const port = await freePort();
  const state = tmp("austere-durable-crash-");
  let proc = startServer(port, state);
  try {
    await up(port);
    const id = (await request(port, "POST", "/api/open", { file: FILE })).data.session.id;
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("do not lose me"), page(port))).status, 200);
    await kill(proc, "SIGKILL"); // no shutdown handler runs
    proc = startServer(port, state); // the dead server's lock is stale
    await up(port);
    const poll = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(poll.data.status, "feedback");
    assert.equal(poll.data.items[0].text, "do not lose me");
  } finally {
    await kill(proc);
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("feedback is unread until acknowledged: a poll without a cursor gets it again, a cursor or a reply acknowledges it", () =>
  withServer(async ({ port, state, id }) => {
    await request(port, "POST", `/s/${id}/send`, message("first"), page(port));
    let r = await cli(port, state, "poll", FILE);
    assert.match(r.out, /status: feedback/);
    const cursor = Number((/cursor: (\d+)/.exec(r.out) as RegExpExecArray)[1]);
    assert.match(r.out, new RegExp(`poll \\S+ --cursor ${cursor} --agent-reply`), "the next hint carries the cursor");

    // The agent lost that answer (crashed, or its tool call timed out): it comes back.
    r = await cli(port, state, "poll", FILE);
    assert.match(r.out, /message: first/);
    assert.match(r.out, new RegExp(`cursor: ${cursor}\\b`));

    // Acknowledged with the cursor: gone, and the page shows it seen.
    const ack = await request(port, "POST", "/api/poll", { file: FILE, cursor, timeoutMs: 200 });
    assert.equal(ack.data.status, "timeout");
    assert.equal((await request(port, "GET", "/api/sessions")).data.sessions.find((s) => s.id === id)?.pending, 0);

    // --after replays what was acknowledged.
    const replay = await request(port, "POST", "/api/poll", { file: FILE, after: cursor - 1 });
    assert.equal(replay.data.items[0].text, "first");

    // A reply without a cursor acknowledges what the last poll handed over.
    await request(port, "POST", `/s/${id}/send`, message("second"), page(port));
    const second = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(second.data.items[0].text, "second");
    assert.equal((await request(port, "POST", "/api/reply", { file: FILE, text: "done" })).status, 200);
    assert.equal((await request(port, "POST", "/api/poll", { file: FILE, timeoutMs: 200 })).data.status, "timeout");

    assert.equal((await request(port, "POST", "/api/poll", { file: FILE, cursor: "x" })).status, 400);
  }));

test("a held note released after the cursor moved past its time still reaches the agent", () =>
  withServer(async ({ port, id }) => {
    const invited = await invite(port, id, "Ana");
    const held = await request(port, "POST", `/s/${id}/send`, message("held by the owner"), { ...page(port), cookie: invited });
    assert.equal(held.data.entry.held, true);

    // Later notes go through and are acknowledged.
    await request(port, "POST", `/s/${id}/send`, message("later, from the owner"), page(port));
    const got = await request(port, "POST", "/api/poll", { file: FILE });
    assert.deepEqual(got.data.items.map((i) => i.text), ["later, from the owner"]);
    await request(port, "POST", "/api/reply", { file: FILE, text: "ok", cursor: got.data.cursor });

    // Released now: it gets a new seq after the cursor.
    await request(port, "POST", `/s/${id}/release`, { ids: [held.data.entry.id] }, page(port));
    const released = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(released.data.status, "feedback");
    assert.equal(released.data.items[0].text, "held by the owner");
    assert.equal(released.data.items[0].author, "Ana");
    assert.ok(released.data.cursor > got.data.cursor);
  }, { AUSTERE_AXI_LINK_HOST: "127.0.0.1" }));

test("unread notes reopen an ended review even when they are older than the end: held and released after it", () =>
  withServer(async ({ port, id }) => {
    const invited = await invite(port, id, "Ana");
    const session = async () => (await request(port, "GET", "/api/sessions")).data.sessions.find((s) => s.id === id);

    // The agent ends, then the owner releases a note held from before.
    const first = await request(port, "POST", `/s/${id}/send`, message("held before the agent ended"), { ...page(port), cookie: invited });
    await request(port, "POST", "/api/end", { file: FILE });
    await request(port, "POST", `/s/${id}/release`, { ids: [first.data.entry.id] }, page(port));
    const poll = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(poll.data.status, "feedback");
    assert.equal(poll.data.items[0].text, "held before the agent ended");
    assert.equal(poll.data.ended, undefined);
    assert.equal((await session())?.status, "open");

    // The same when the reviewer ended it from the page.
    const second = await request(port, "POST", `/s/${id}/send`, message("held before the reviewer ended"), { ...page(port), cookie: invited });
    await request(port, "POST", `/s/${id}/end`, {}, page(port));
    await request(port, "POST", `/s/${id}/release`, { ids: [second.data.entry.id] }, page(port));
    const again = await request(port, "POST", "/api/poll", { file: FILE, cursor: poll.data.cursor });
    assert.equal(again.data.items[0].text, "held before the reviewer ended");
    assert.equal(again.data.ended, undefined);
    assert.equal((await session())?.status, "open");

    // A replay of acknowledged notes does not reopen an ended review.
    await request(port, "POST", "/api/end", { file: FILE });
    const replay = await request(port, "POST", "/api/poll", { file: FILE, cursor: again.data.cursor, after: 0 });
    assert.equal(replay.data.status, "feedback");
    assert.equal((await session())?.status, "ended");
  }, { AUSTERE_AXI_LINK_HOST: "127.0.0.1" }));

test("ending keeps the composer open; only the owner's close refuses notes, until reopen", () =>
  withServer(async ({ port, id }) => {
    // Closing ends a listening poll.
    const listening = request(port, "POST", "/api/poll", { file: FILE });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await request(port, "POST", "/api/close", { file: FILE })).status, 200);
    const closed = await listening;
    assert.equal(closed.data.status, "ended");
    assert.equal(closed.data.closed, true);
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("after close"), page(port))).status, 409);
    assert.equal((await request(port, "POST", "/api/open", { file: FILE })).data.status, "refused");
    assert.equal((await request(port, "POST", "/api/reopen", { file: FILE })).status, 200);

    // Ending does not refuse notes.
    await request(port, "POST", `/s/${id}/end`, {}, page(port));
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("after end"), page(port))).status, 200);
    await request(port, "POST", `/s/${id}/close`, {}, page(port));
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("after close"), page(port))).status, 409);

    // A note sent before the close still reaches the agent, as the last of the review.
    const poll = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(poll.data.items[0].text, "after end");
    assert.equal(poll.data.ended, true);
    const next = await request(port, "POST", "/api/poll", { file: FILE, cursor: poll.data.cursor });
    assert.deepEqual([next.data.status, next.data.closed], ["ended", true]);

    assert.equal((await request(port, "POST", `/s/${id}/reopen`, {}, page(port))).status, 200);
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("after reopen"), page(port))).status, 200);
  }));

test("a second server on the same state dir refuses to start", () =>
  withServer(async ({ port, state }) => {
    const other = startServer(await freePort(), state);
    const code = await other.exited;
    assert.notEqual(code, 0);
    assert.match(other.out, new RegExp(`another austere-axi server \\(pid \\d+, port ${port}\\) is using`));
  }));

test("a lock left by a dead server does not block a start when its pid now belongs to another process", async () => {
  const port = await freePort();
  const state = tmp("austere-durable-lock-");
  // This test's own pid is alive but serves nothing on the port the lock names.
  fs.writeFileSync(path.join(state, "server.lock"), JSON.stringify({ pid: process.pid, port: await freePort(), at: Date.now() - 10 * 60_000 }));
  const proc = startServer(port, state);
  try {
    await up(port);
    const lock = JSON.parse(fs.readFileSync(path.join(state, "server.lock"), "utf8"));
    assert.deepEqual([lock.pid, lock.port], [(await request(port, "GET", "/api/health")).data.pid, port]);
  } finally {
    await kill(proc);
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a newer CLI that replaces an older server keeps --persist", async () => {
  const port = await freePort();
  const state = tmp("austere-durable-replace-");
  // An older server that runs with --persist and proves it holds the owner key; it exits when asked to.
  const old = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname === "/api/health") {
      const proof = crypto.createHmac("sha256", ownerKey(state)).update(`${port}:${url.searchParams.get("nonce")}`).digest("base64url");
      return res.end(JSON.stringify({ name: "austere-axi", version: "0.0.1", pid: 1, port, stateDir: state, proof, listen: ["127.0.0.1"], persist: true }));
    }
    if (url.pathname === "/api/shutdown") {
      res.on("finish", () => {
        old.close();
        old.closeAllConnections();
      });
    }
    res.end("{}");
  });
  await new Promise<void>((r) => old.listen(port, "127.0.0.1", r));
  stateOf.set(port, state);
  try {
    const r = await cli(port, state, FILE, "--no-open");
    assert.match(r.out, /status: open/);
    const h = (await request(port, "GET", "/api/health")).data;
    assert.notEqual(h.version, "0.0.1", "replaced");
    assert.equal(h.persist, true);
  } finally {
    old.close();
    await cli(port, state, "stop");
    // The stopped server may still hold hub.db for a moment; Windows refuses to remove it until it exits.
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("session files from before the database are imported once, every state intact", async () => {
  const dir = tmp("austere-import-");
  const file = path.join(dir, "plan.html");
  const id = sessionId(file);
  const items = (text: string) => [{ kind: "message", text, id: `${text}-item` }];
  const legacy = {
    id,
    file,
    title: "Plan",
    createdAt: 1,
    updatedAt: 9,
    status: "ended",
    endedBy: "agent",
    endedAt: 8,
    pending: ["u-pending"],
    transcript: [
      { id: "u-done", role: "user", at: 2, items: items("addressed"), seenAt: 3, doneAt: 4 },
      { id: "a-1", role: "agent", at: 4, text: "did it" },
      { id: "u-seen", role: "user", at: 5, items: items("received"), seenAt: 6, doneAt: null },
      { id: "u-pending", role: "user", at: 6, items: items("open"), seenAt: null, doneAt: null },
      { id: "u-held", role: "user", at: 7, items: items("held"), author: "Ana", held: true },
      { id: "u-gone", role: "user", at: 7, items: items("discarded"), author: "Ana", held: false, discarded: true },
    ],
  };
  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify(legacy));
  try {
    const check = (store: SessionStore, status = "ended") => {
      const s = store.get(id) as Session;
      assert.equal(s.status, status);
      assert.equal(s.endedBy, status === "ended" ? "agent" : null);
      assert.deepEqual(store.unread(s).map((e) => e.id), ["u-pending"]);
      assert.deepEqual(store.heldEntries(s).map((e) => e.id), ["u-held"]);
      assert.deepEqual(
        store.feedback(s, { all: true, peek: true }).entries.map((e) => [e.id, e.status]),
        [["u-done", "addressed"], ["u-seen", "received"], ["u-pending", "open"]],
      );
      assert.deepEqual(s.transcript.map((e) => e.id), ["u-done", "a-1", "u-seen", "u-pending", "u-held", "u-gone"]);
      const hub = new Hub(store.db);
      assert.deepEqual(
        Object.fromEntries(hub.db.prepare("SELECT entry_id, status FROM items").all().map((r) => [r.entry_id, r.status])),
        { "u-done": "addressed", "u-seen": "received", "u-pending": "open", "u-held": "held", "u-gone": "discarded" },
      );
    };
    let store = await SessionStore.open(dir);
    check(store);
    // The server reopens the review after the import.
    store.reopen(store.get(id) as Session);
    store.close();
    assert.deepEqual(fs.readdirSync(sessions), [`${id}.json.imported`]);

    // A rename that did not happen: importing again changes nothing, not even the status.
    fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify(legacy));
    store = await SessionStore.open(dir);
    check(store, "open");
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
