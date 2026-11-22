// Team review devices (RLM-397): a link claimed once, expiry, scope, revoke, and invites.json from 0.12.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DeviceStore, LINK_TTL_MS, covers, hashSecret } from "../src/cli/devices.ts";
import { openDatabase } from "../src/cli/hub.ts";
import { sessionId } from "../src/cli/sessions.ts";
import { claimLink, ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const PAGE = "aaaaaaaaaaaa";

test("a link is claimed once, its cookie secret is fresh and stored hashed, and an unclaimed link expires", async () => {
  const db = await openDatabase(":memory:");
  let now = 1_000_000;
  const store = new DeviceStore(db, () => now);
  try {
    const { row, token } = store.createLink({
      name: " Ana ",
      scope: { kind: "page", id: PAGE },
      page: PAGE,
    });
    assert.equal(row.name, "Ana");
    assert.equal(row.link_expires_at, now + LINK_TTL_MS, "7 days by default");
    assert.ok(Buffer.from(token, "base64url").length >= 24, "192 bits");
    assert.throws(
      () => store.createLink({ name: "ana", scope: { kind: "page", id: PAGE }, page: PAGE }),
      /already has access/,
    );
    assert.doesNotThrow(
      () => store.createLink({ name: "ana", scope: { kind: "all", id: null }, page: PAGE }),
      "another scope is another grant",
    );
    assert.equal(store.findLink(token + "x"), null);

    const link = store.findLink(token);
    assert.ok(link);
    const first = store.claim(link);
    assert.ok(first);
    assert.notEqual(first.secret, token, "the cookie is never the link token");
    assert.equal(first.device.secret_hash, hashSecret(first.secret), "only the hash is stored");
    assert.equal(first.device.link_token, null);
    assert.equal(store.claim(link), null, "a second browser cannot claim it");
    assert.equal(store.linkState(store.findLink(token)!), "claimed");
    assert.equal(store.bySecret(first.secret)?.id, row.id);
    assert.equal(store.bySecret(token), null, "the link token is no cookie");

    const late = store.createLink({
      name: "Bo",
      scope: { kind: "page", id: PAGE },
      page: PAGE,
      expiresAt: now + 1000,
    });
    now += 1000;
    assert.equal(store.linkState(late.row), "expired");
    assert.equal(store.claim(late.row), null, "an expired link cannot be claimed");
    assert.throws(
      () =>
        store.createLink({
          name: "Cy",
          scope: { kind: "page", id: PAGE },
          page: PAGE,
          expiresAt: now,
        }),
      /expire/,
    );

    assert.equal(store.revoke("ANA").length, 2, "by name, any case: both of Ana's grants");
    assert.equal(store.bySecret(first.secret), null, "a revoked device's secret no longer matches");
    assert.equal(store.revoke("nobody").length, 0);

    // Names match ignoring case beyond ASCII (SQLite's lower() would not).
    store.createLink({ name: "Éva", scope: { kind: "page", id: PAGE }, page: PAGE });
    assert.throws(
      () => store.createLink({ name: "éva", scope: { kind: "page", id: PAGE }, page: PAGE }),
      /already has access/,
    );
    assert.deepEqual(
      store.revoke("éva").map((r) => r.name),
      ["Éva"],
    );
  } finally {
    db.close();
  }
});

test("scope reaches one page, one project, or every page; auto names follow it", async () => {
  assert.equal(covers({ scope_kind: "page", scope_id: PAGE }, PAGE, "p1"), true);
  assert.equal(covers({ scope_kind: "page", scope_id: PAGE }, "bbbbbbbbbbbb", "p1"), false);
  assert.equal(covers({ scope_kind: "project", scope_id: "p1" }, "bbbbbbbbbbbb", "p1"), true);
  assert.equal(covers({ scope_kind: "project", scope_id: "p1" }, "bbbbbbbbbbbb", "p2"), false);
  assert.equal(covers({ scope_kind: "project", scope_id: "p1" }, "bbbbbbbbbbbb", null), false);
  assert.equal(covers({ scope_kind: "all", scope_id: null }, "cccccccccccc", null), true);
  const db = await openDatabase(":memory:");
  try {
    const store = new DeviceStore(db);
    store.createLink({ name: "Dee", scope: { kind: "project", id: "p1" }, page: PAGE, auto: true });
    store.createLink({ name: "Eli", scope: { kind: "page", id: PAGE }, page: PAGE });
    assert.deepEqual(store.autoNames("bbbbbbbbbbbb", "p1"), ["Dee"]);
    assert.deepEqual(store.autoNames("bbbbbbbbbbbb", "p2"), []);
  } finally {
    db.close();
  }
});

/** invites.json as 0.12 wrote it. */
function legacyInvites(
  dir: string,
  invites: { token: string; name: string; sessionId: string; file: string; auto: boolean }[],
): void {
  fs.writeFileSync(
    path.join(dir, "invites.json"),
    JSON.stringify(
      { invites: invites.map((i) => ({ ...i, createdAt: 1_700_000_000_000 })) },
      null,
      2,
    ) + "\n",
  );
}

test("a 0.12 invites.json becomes old-style links: reusable, no expiry, old cookies still work until made single-use", async () => {
  const dir = tmp("austere-devices-migrate-");
  const token = crypto.randomBytes(24).toString("base64url");
  try {
    legacyInvites(dir, [
      { token, name: "Ana", sessionId: PAGE, file: "/p/plan.html", auto: true },
      { token: "short", name: "Bad", sessionId: PAGE, file: "/p/plan.html", auto: false },
    ]);
    let db = await openDatabase(path.join(dir, "hub.db"));
    let store = new DeviceStore(db);
    const rows = store.list();
    assert.equal(rows.length, 1, "a malformed entry is skipped, as 0.12 skipped it");
    const [old] = rows;
    assert.equal(old.name, "Ana");
    assert.equal(old.reusable, 1);
    assert.equal(old.link_expires_at, null);
    assert.deepEqual([old.scope_kind, old.scope_id, old.auto], ["page", PAGE, 1]);
    assert.equal(fs.existsSync(path.join(dir, "invites.json")), false, "moved aside");
    assert.ok(fs.existsSync(path.join(dir, "invites.json.imported")));
    assert.equal(store.bySecret(token)?.id, old.id, "a reviewer cookie from 0.12 still works");

    // The old link opens on any number of browsers; each becomes a device of its own.
    const a = store.claim(store.findLink(token)!);
    const b = store.claim(store.findLink(token)!);
    assert.ok(a && b);
    assert.notEqual(a.device.id, b.device.id);
    assert.notEqual(a.secret, token);
    assert.deepEqual([a.device.name, a.device.scope_id, a.device.auto], ["Ana", PAGE, 1]);
    db.close();

    // Opening again imports nothing twice, even if the file comes back.
    legacyInvites(dir, [{ token, name: "Ana", sessionId: PAGE, file: "/p/plan.html", auto: true }]);
    db = await openDatabase(path.join(dir, "hub.db"));
    store = new DeviceStore(db);
    assert.equal(store.list().filter((r) => r.reusable).length, 1);

    // Made single-use: the old token stops working as link and cookie; devices made from it stay.
    const fresh = store.makeSingleUse(old.id);
    assert.notEqual(fresh.token, token);
    assert.equal(store.bySecret(token), null);
    assert.equal(store.findLink(token), null);
    assert.equal(store.linkState(store.findLink(fresh.token)!), "ok");
    assert.ok(store.bySecret(a.secret));
    assert.throws(() => store.makeSingleUse(old.id), /single-use already/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** A request as a browser on this machine sends it: Host and, for a POST, a same-origin Origin. Resolves with the status and the body. */
function req(
  port: number,
  method: string,
  route: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; data: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; data: string }>();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = http.request(
    {
      host: "127.0.0.1",
      port,
      method,
      path: route,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(method === "POST" ? { origin: `http://127.0.0.1:${port}` } : {}),
        ...(payload ? { "content-type": "application/json" } : {}),
        ...headers,
      },
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    },
  );
  r.on("error", reject);
  r.end(payload);
  return promise;
}

const get = async (port: number, route: string, cookie: string): Promise<number> =>
  (await req(port, "GET", route, { cookie })).status;

/** An event stream that only tracks whether the server has closed it. */
function openStream(
  port: number,
  route: string,
  cookie: string,
): { ended: () => boolean; snapshot: Promise<void>; close: () => void } {
  let ended = false;
  const snap = Promise.withResolvers<void>();
  const r = http.get(
    { host: "127.0.0.1", port, path: route, headers: { host: `127.0.0.1:${port}`, cookie } },
    (res) => {
      res.on("data", (c: Buffer) => {
        if (String(c).includes("event: snapshot")) snap.resolve();
      });
      res.on("end", () => (ended = true));
      res.on("error", () => (ended = true));
    },
  );
  r.on("error", () => (ended = true));
  return { ended: () => ended, snapshot: snap.promise, close: () => r.destroy() };
}

async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

const PAGE_HTML = `<!doctype html><html><head><title>Plan</title></head><body><script type="text/openui">root = Stack([])</script></body></html>`;

/**
 * A server started on a 0.12 state dir: invites.json names Ana on `plan.html`, with `token` as her
 * link and her cookie. `other.html` is a second page of the same folder. Runs `fn`, then stops it.
 */
async function withLegacyServer(
  fn: (o: {
    port: number;
    id: string;
    otherId: string;
    token: string;
    owner: Record<string, string>;
    api: (method: string, route: string, body?: unknown) => Promise<Record<string, unknown>>;
  }) => Promise<void>,
): Promise<void> {
  const state = tmp("austere-devices-state-");
  const work = tmp("austere-devices-work-");
  const file = path.join(work, "plan.html");
  const other = path.join(work, "other.html");
  fs.writeFileSync(file, PAGE_HTML);
  fs.writeFileSync(other, PAGE_HTML);
  const token = crypto.randomBytes(24).toString("base64url");
  const id = sessionId(file);
  legacyInvites(state, [{ token, name: "Ana", sessionId: id, file, auto: false }]);
  const port = await freePort();
  const child = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: {
      ...process.env,
      AUSTERE_AXI_STATE_DIR: state,
      AUSTERE_AXI_NO_TAILSCALE: "1",
      AUSTERE_AXI_LINK_HOST: "127.0.0.1",
      OPENUI_TELEMETRY_DISABLED: "1",
    },
    stdio: "ignore",
  });
  const owner = ownerHeaders(state);
  const api = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        "x-austere-key": owner["x-austere-key"],
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await r.json()) as Record<string, unknown>;
  };
  try {
    for (let i = 0; ; i++) {
      const ok = await fetch(`http://127.0.0.1:${port}/api/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      if (i > 100) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 50));
    }
    await api("POST", "/api/open", { file });
    const otherId = (
      (await api("POST", "/api/open", { file: other })) as { session: { id: string } }
    ).session.id;
    await fn({ port, id, otherId, token, owner: { cookie: owner.cookie }, api });
  } finally {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

/** The id of Ana's old-style link, from the owner's People list. */
async function anaId(port: number, owner: Record<string, string>): Promise<string> {
  const people = JSON.parse((await req(port, "GET", "/hub/api/people", owner)).data) as {
    links: { id: string; name: string }[];
  };
  return people.links.find((l) => l.name === "Ana")!.id;
}

test("a server started on a 0.12 state dir lets an old reviewer cookie in, and lists the invite as an old-style link", async () => {
  await withLegacyServer(async ({ port, id, token, api }) => {
    assert.equal(
      await get(port, `/s/${id}`, `austere_rv=${token}`),
      200,
      "the cookie 0.12 set still works",
    );
    assert.equal(await get(port, `/s/${id}`, "austere_rv=forged"), 403);
    const list = (await api("GET", "/api/share/list?links=1")) as {
      links: { name: string; reusable: boolean; link?: string }[];
    };
    const old = list.links.find((l) => l.name === "Ana");
    assert.equal(old?.reusable, true);
    assert.equal(
      old?.link,
      `http://127.0.0.1:${port}/s/${id}?invite=${token}`,
      "the same link as before",
    );
    await api("POST", "/api/share/revoke", { key: "Ana" });
    assert.equal(
      await get(port, `/s/${id}`, `austere_rv=${token}`),
      403,
      "revoked: the old cookie stops at once",
    );
  });
});

test("an old browser's artifact token stays dead after single-use, also once another browser claims the new link", async () => {
  await withLegacyServer(async ({ port, id, token, owner }) => {
    const page = await req(port, "GET", `/s/${id}`, { cookie: `austere_rv=${token}` });
    const artifact = JSON.parse(/window\.__AUSTERE__=(\{.*?\})<\/script>/.exec(page.data)![1]) as {
      artifactUrl: string;
    };
    // The sandboxed frame sends no cookie: the token in its URL is the credential.
    const frame = () => get(port, artifact.artifactUrl, "none=1");
    assert.equal(await frame(), 200);
    const made = await req(
      port,
      "POST",
      `/hub/api/people/${await anaId(port, owner)}/single-use`,
      owner,
    );
    assert.equal(made.status, 200, made.data);
    assert.equal(await frame(), 403, "single-use cuts the old browser's frame");
    await claimLink(port, (JSON.parse(made.data) as { link: string }).link);
    assert.equal(
      await frame(),
      403,
      "a new browser claiming the replacement link does not bring the old token back",
    );
  });
});

test("narrowing an old-style link's scope closes the old cookie's open streams on pages it leaves", async () => {
  await withLegacyServer(async ({ port, id, otherId, token, owner }) => {
    const cookie = `austere_rv=${token}`;
    const live = openStream(port, `/s/${id}/events`, cookie);
    try {
      await live.snapshot;
      const narrowed = await req(
        port,
        "POST",
        `/hub/api/people/${await anaId(port, owner)}/scope`,
        owner,
        { scope: "page", page: otherId },
      );
      assert.equal(narrowed.status, 200, narrowed.data);
      assert.equal(await get(port, `/s/${id}`, cookie), 403);
      assert.ok(await until(live.ended), "the open stream on the page it left is closed");
    } finally {
      live.close();
    }
  });
});
