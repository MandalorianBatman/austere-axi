// Request access (RLM-398): an unknown browser asks from the page's address; the owner approves,
// denies or blocks; limits; requests off unless the owner turns them on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DeviceStore, hashSecret } from "../src/cli/devices.ts";
import { openDatabase } from "../src/cli/hub.ts";
import { MAX_WAITING, REQUESTS_PER_ADDR_HOUR, RequestStore, WAITING_TTL_MS, describeAgent } from "../src/cli/requests.ts";
import type { AccessRequestsResponse, RequestDecisionResponse, RequestSwitchResponse, ShareListResponse } from "../src/cli/server.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const PAGE = "aaaaaaaaaaaa";

test("the store: one approval per asking browser, collected once; deny, block; per-address and waiting limits; the switch", async () => {
  const db = await openDatabase(":memory:");
  let now = 1_000_000;
  const store = new RequestStore(db, () => now);
  const devices = new DeviceStore(db, () => now);
  try {
    assert.equal(store.enabled(null), false, "off by default");
    store.setEnabled("p1", true);
    assert.deepEqual([store.enabled("p1"), store.enabled("p2"), store.enabled(null)], [true, false, false]);
    store.setEnabled(null, true);
    assert.deepEqual(store.switches(), { all: true, projects: [] }, "every page's setting clears the projects' own");
    store.setEnabled("p2", false);
    assert.deepEqual([store.enabled("p1"), store.enabled("p2"), store.enabled(null)], [true, false, true], "a project's own setting wins");
    assert.deepEqual(store.switches(), { all: true, projects: [{ id: "p2", on: false }] });
    store.setEnabled("p2", true);
    assert.deepEqual(store.switches(), { all: true, projects: [] }, "the same as every page's: no setting of its own");

    assert.throws(() => store.ask({ name: " ", page: PAGE, meta: {} }), (e: Error & { status?: number }) => e.status === 400 && /Type your name/.test(e.message));
    assert.throws(() => store.ask({ name: "Owner", page: PAGE, meta: {} }), /reserved/, "names are cleaned as invite names are");
    const ana = store.ask({ name: " Ana\n ", page: PAGE, meta: { addr: "10.0.0.1", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" } });
    assert.equal(ana.row.name, "Ana");
    assert.equal(ana.row.status, "waiting");
    assert.equal(ana.row.secret_hash, hashSecret(ana.secret), "only the pending secret's hash is stored");
    const mal = store.ask({ name: "Ana", page: PAGE, meta: { addr: "10.0.0.2" } });

    const device = store.approve(ana.row.id, { kind: "page", id: PAGE }, false);
    assert.deepEqual([device.name, device.origin, device.secret_hash, device.scope_id], ["Ana", "request", null, PAGE], "no secret until the browser that asked collects it");
    assert.throws(() => store.approve(ana.row.id, { kind: "all", id: null }, false), /approved already/);
    assert.equal(store.collect(mal.secret), null, "another browser with the same name gets nothing");
    const got = store.collect(ana.secret);
    assert.ok(got);
    assert.notEqual(got.secret, ana.secret, "the device secret is fresh, not the pending one");
    assert.equal(devices.bySecret(got.secret)?.id, device.id);
    assert.equal(devices.bySecret(ana.secret), null);
    assert.equal(store.collect(ana.secret), null, "collected once");

    // One name, one person: a stranger who types Ana's name is not let in as a second Ana with her scope.
    const eve = store.ask({ name: "ANA", page: PAGE, meta: { addr: "10.0.0.4" } });
    assert.throws(() => store.approve(eve.row.id, { kind: "page", id: PAGE }, false), (e: Error & { status?: number }) => e.status === 409 && /already has access/.test(e.message));
    assert.equal(store.get(eve.row.id)?.status, "waiting", "still waiting for the owner");
    assert.equal(store.approve(eve.row.id, { kind: "page", id: PAGE }, false, "Ana (phone)").name, "Ana (phone)", "the owner may let it in under another name");

    // A revoked approval cannot be collected.
    const bo = store.ask({ name: "Bo", page: PAGE, meta: { addr: "10.0.0.3" } });
    const boDevice = store.approve(bo.row.id, { kind: "all", id: null }, false);
    devices.revoke(boDevice.id);
    assert.equal(store.collect(bo.secret), null);

    assert.equal(store.decide(mal.row.id, "blocked").status, "blocked");
    assert.equal(store.bySecret(mal.secret)?.status, "blocked");
    assert.throws(() => store.decide(mal.row.id, "denied"), /blocked already/);

    // Five requests per address an hour.
    for (let i = 0; i < REQUESTS_PER_ADDR_HOUR - 1; i++) store.decide(store.ask({ name: `Cy${i}`, page: PAGE, meta: { addr: "10.0.0.1" } }).row.id, "denied");
    assert.throws(() => store.ask({ name: "Cy", page: PAGE, meta: { addr: "10.0.0.1" } }), (e: Error & { status?: number }) => e.status === 429 && /this address/.test(e.message));
    now += 3_600_001;
    assert.doesNotThrow(() => store.ask({ name: "Cy", page: PAGE, meta: { addr: "10.0.0.1" } }), "an hour later it may ask again");

    // Fifty waiting at most.
    for (let i = store.list("waiting").length; i < MAX_WAITING; i++) store.ask({ name: `W${i}`, page: PAGE, meta: { addr: `10.1.${i}.1` } });
    assert.throws(() => store.ask({ name: "Late", page: PAGE, meta: { addr: "10.2.0.1" } }), (e: Error & { status?: number }) => e.status === 429 && /waiting/.test(e.message));

    // A request nobody decided lapses after a week: it leaves the queue, and its browser may ask again.
    const [oldest] = store.list("waiting");
    now += WAITING_TTL_MS;
    assert.equal(store.list("waiting").length, 0);
    assert.equal(store.get(oldest.id)?.status, "lapsed");
    assert.throws(() => store.approve(oldest.id, { kind: "all", id: null }, false), /lapsed already/);
    assert.doesNotThrow(() => store.ask({ name: "Late", page: PAGE, meta: { addr: "10.2.0.1" } }));
  } finally {
    db.close();
  }
});

test("the owner recognises a request by its browser and system", () => {
  assert.equal(describeAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"), "Chrome on macOS");
  assert.equal(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
  assert.equal(describeAgent("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"), "Firefox on Linux");
  assert.equal(describeAgent(null), "unknown browser");
});

// ── the server ──

interface Res {
  status: number;
  data: string;
  headers: http.IncomingHttpHeaders;
}

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const STATE = tmp("austere-requests-state-");
const WORK = tmp("austere-requests-work-");
const TITLE = "Secret Plan Title";
const BODY = "confidential-intro-text";
const PAGE_HTML = `<!doctype html><html><head><title>${TITLE}</title></head><body><script type="text/openui">
root = Stack([intro])
intro = TextContent("${BODY}")
</script></body></html>`;
let port = 0;
let child: ChildProcess;
let id = "";
const owner = ownerHeaders(STATE);

/**
 * A request as a browser elsewhere on the tailnet sends it: from `from` (127.0.0.2 and up, which the
 * server does not count as loopback), with a same-origin Origin on POST unless `origin` says otherwise.
 */
function browser(from: string, method: string, route: string, { cookie = "", form, origin = true, json, headers = {} }: { cookie?: string; form?: Record<string, string>; origin?: boolean; json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const { promise, resolve, reject } = Promise.withResolvers<Res>();
  const payload = form ? new URLSearchParams(form).toString() : json !== undefined ? JSON.stringify(json) : undefined;
  const r = http.request(
    {
      host: "127.0.0.1",
      port,
      method,
      path: route,
      localAddress: from,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(cookie ? { cookie } : {}),
        ...(method === "POST" && origin ? { origin: `http://127.0.0.1:${port}` } : {}),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : json !== undefined ? { "content-type": "application/json" } : {}),
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        ...headers,
      },
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data, headers: res.headers }));
    },
  );
  r.on("error", reject);
  r.end(payload);
  return promise;
}

/** The owner's CLI route. */
async function api<T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { "x-austere-key": owner["x-austere-key"], ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json()) as T };
}

/** The owner's browser on the hub's People API: owner cookie, same origin. */
async function hub<T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { cookie: owner.cookie, ...(method === "POST" ? { origin: `http://127.0.0.1:${port}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: (await r.json()) as T };
}

/** The value of cookie `name` a response sets, as a Cookie header part, or "". */
function setCookie(res: Res, name: string): string {
  const c = (res.headers["set-cookie"] ?? []).find((v) => v.startsWith(name));
  return c ? c.split(";")[0] : "";
}

/** Ask for access on page `pid` from `from`: the pending cookie, or "" when refused. */
async function ask(from: string, name: string, pid = id, cookie = ""): Promise<{ res: Res; cookie: string }> {
  const res = await browser(from, "POST", `/s/${pid}/request`, { form: { name }, cookie });
  return { res, cookie: setCookie(res, "austere_rq=") };
}

const switchTo = (on: boolean, project?: string) => api<RequestSwitchResponse>("POST", "/api/share/requests", { on, project });
const waiting = async () => (await api<AccessRequestsResponse>("GET", "/api/share/requests")).data.waiting;

before(async () => {
  fs.writeFileSync(path.join(WORK, "plan.html"), PAGE_HTML);
  port = await freePort();
  child = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_LINK_HOST: "127.0.0.1", OPENUI_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) break;
    if (i > 100) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
  id = (await api<{ session: { id: string } }>("POST", "/api/open", { file: path.join(WORK, "plan.html") })).data.session.id;
});

after(async () => {
  if (child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("requests off (the default): an unknown browser gets the 403 it got before, and cannot ask", async () => {
  const page = await browser("127.0.0.2", "GET", `/s/${id}`);
  assert.equal(page.status, 403);
  assert.equal(page.data, "Ask the owner for a link to this page.");
  const asked = await ask("127.0.0.2", "Ana");
  assert.equal(asked.res.status, 403);
  assert.equal(asked.res.data, "Ask the owner for a link to this page.");
  assert.equal(asked.cookie, "");
  assert.equal((await browser("127.0.0.2", "GET", `/s/${id}/request`)).status, 403);
  assert.deepEqual(await waiting(), []);
  assert.deepEqual((await api<AccessRequestsResponse>("GET", "/api/share/requests")).data.switch, { all: false, projects: [] });
});

test("request → approve: the browser that asked gets in, another browser with the same name does not; nothing of the page shows before", async () => {
  assert.equal((await switchTo(true)).status, 200);
  try {
    const gate = await browser("127.0.0.3", "GET", `/s/${id}`);
    assert.equal(gate.status, 403);
    assert.match(gate.data, /<title>Ask for access<\/title>/);
    assert.match(gate.data, /Ask the owner for access/);
    assert.match(gate.data, /<form method="post" action="\/s\/[a-f0-9]{12}\/request">/);
    for (const leak of [TITLE, BODY, "plan.html", WORK]) assert.ok(!gate.data.includes(leak), `the gate does not show ${leak}`);

    // Cross-site or Origin-less POSTs are refused.
    assert.equal((await browser("127.0.0.3", "POST", `/s/${id}/request`, { form: { name: "Ana" }, origin: false })).status, 403);

    const ana = await ask("127.0.0.3", "Ana");
    assert.equal(ana.res.status, 303, ana.res.data);
    assert.match(ana.cookie, /^austere_rq=[A-Za-z0-9_-]{32}$/);
    assert.match(String(ana.res.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
    const waitPage = await browser("127.0.0.3", "GET", `/s/${id}`, { cookie: ana.cookie });
    assert.equal(waitPage.status, 403);
    assert.match(waitPage.data, /Waiting for the owner/);
    for (const leak of [TITLE, BODY, "plan.html"]) assert.ok(!waitPage.data.includes(leak), `the waiting page does not show ${leak}`);
    assert.deepEqual(JSON.parse((await browser("127.0.0.3", "GET", `/s/${id}/request`, { cookie: ana.cookie })).data), { state: "waiting" });
    // Sending again from the same browser keeps its one request.
    assert.equal((await ask("127.0.0.3", "Ana again", id, ana.cookie)).cookie, "");

    const mal = await ask("127.0.0.4", "Ana");
    assert.equal(mal.res.status, 303);

    const list = await hub<AccessRequestsResponse>("GET", "/hub/api/people/requests");
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.waiting.map((r) => [r.name, r.addr, r.browser, r.file]), [
      ["Ana", "127.0.0.3", "Chrome on Linux", path.join(WORK, "plan.html")],
      ["Ana", "127.0.0.4", "Chrome on Linux", path.join(WORK, "plan.html")],
    ]);
    assert.ok(list.data.waiting.every((r) => r.verifiedLogin === null && r.tailscaleDevice === null), "Tailscale fields stay empty until RLM-399");
    assert.ok(!JSON.stringify(list.data).includes(ana.cookie.split("=")[1]), "the pending secret is never listed");

    const approved = await hub<RequestDecisionResponse>("POST", `/hub/api/people/requests/${list.data.waiting[0].id}/approve`, { scope: "page" });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.request.status, "approved");
    assert.deepEqual([approved.data.device?.name, approved.data.device?.origin, approved.data.device?.scope], ["Ana", "request", "page"]);
    assert.equal((await hub("POST", `/hub/api/people/requests/${list.data.waiting[0].id}/deny`)).status, 409, "decided once");

    // The other browser with the same name is still outside.
    assert.deepEqual(JSON.parse((await browser("127.0.0.4", "GET", `/s/${id}/request`, { cookie: mal.cookie })).data), { state: "waiting" });
    const still = await browser("127.0.0.4", "GET", `/s/${id}`, { cookie: mal.cookie });
    assert.equal(still.status, 403);
    assert.ok(!still.data.includes(TITLE));

    // The waiting page's poll lets the browser that asked in, once.
    const poll = await browser("127.0.0.3", "GET", `/s/${id}/request`, { cookie: ana.cookie });
    assert.deepEqual(JSON.parse(poll.data), { state: "approved" });
    const device = setCookie(poll, "austere_rv_d");
    assert.match(device, /^austere_rv_d[0-9a-f]{10}=/);
    assert.notEqual(device.split("=")[1], ana.cookie.split("=")[1], "the device cookie is a fresh secret");
    assert.match(String(poll.headers["set-cookie"]), /austere_rq=; Path=\/s\/; HttpOnly; SameSite=Lax; Max-Age=0/, "the pending cookie is cleared");
    const inside = await browser("127.0.0.3", "GET", `/s/${id}`, { cookie: device });
    assert.equal(inside.status, 200);
    assert.match(inside.data, new RegExp(TITLE));
    // A copied pending cookie is worth nothing now.
    assert.deepEqual(JSON.parse((await browser("127.0.0.5", "GET", `/s/${id}/request`, { cookie: ana.cookie })).data), { state: "none" });

    const people = await hub<ShareListResponse>("GET", "/hub/api/people");
    assert.deepEqual(
      people.data.devices.filter((d) => d.origin === "request").map((d) => [d.name, d.lastAddr]),
      [["Ana", "127.0.0.3"]],
    );
    await api("POST", "/api/share/deny", { id: list.data.waiting[1].id });
    await api("POST", "/api/share/revoke", { key: "Ana" });
  } finally {
    await switchTo(false);
  }
});

test("deny lets the browser ask again; block stops it asking; both show on its page", async () => {
  await switchTo(true);
  try {
    const first = await ask("127.0.0.6", "Bo");
    const [req1] = await waiting();
    const denied = await api<RequestDecisionResponse>("POST", "/api/share/deny", { id: req1.id });
    assert.equal(denied.data.request.status, "denied");
    assert.deepEqual(JSON.parse((await browser("127.0.0.6", "GET", `/s/${id}/request`, { cookie: first.cookie })).data), { state: "denied" });
    const page = await browser("127.0.0.6", "GET", `/s/${id}`, { cookie: first.cookie });
    assert.match(page.data, /declined your last request/);
    assert.match(page.data, /<form/);

    const second = await ask("127.0.0.6", "Bo", id, first.cookie);
    assert.equal(second.res.status, 303);
    assert.notEqual(second.cookie, first.cookie);
    const [req2] = await waiting();
    const blocked = await hub<RequestDecisionResponse>("POST", `/hub/api/people/requests/${req2.id}/block`);
    assert.equal(blocked.data.request.status, "blocked");
    const blockedPage = await browser("127.0.0.6", "GET", `/s/${id}`, { cookie: second.cookie });
    assert.match(blockedPage.data, /blocked this browser/);
    assert.ok(!/<form/.test(blockedPage.data));
    const again = await ask("127.0.0.6", "Bo", id, second.cookie);
    assert.equal(again.res.status, 403);
    assert.equal(again.cookie, "");
    assert.deepEqual(await waiting(), []);
    assert.deepEqual((await api<AccessRequestsResponse>("GET", "/api/share/requests")).data.blocked.map((r) => r.id), [req2.id]);
  } finally {
    await switchTo(false);
  }
});

test("five requests per address an hour; a bad name is refused with the form", async () => {
  await switchTo(true);
  try {
    const bad = await ask("127.0.0.7", "   ");
    assert.equal(bad.res.status, 400);
    assert.match(bad.res.data, /Type your name/);
    assert.match(bad.res.data, /<form/);
    for (let i = 0; i < 5; i++) {
      const r = await ask("127.0.0.7", `Cy${i}`);
      assert.equal(r.res.status, 303, `request ${i + 1}`);
    }
    const sixth = await ask("127.0.0.7", "Cy5");
    assert.equal(sixth.res.status, 429);
    assert.match(sixth.res.data, /Too many requests from this address/);
    assert.equal((await ask("127.0.0.8", "Dee")).res.status, 303, "another address is not limited by it");
    for (const r of await waiting()) await api("POST", "/api/share/deny", { id: r.id });
  } finally {
    await switchTo(false);
  }
});

test("the switch is per project or for every page; a page outside it answers as before", async () => {
  const dir = path.join(WORK, "alpha");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.html"), PAGE_HTML);
  const aid = (await api<{ session: { id: string } }>("POST", "/api/open", { file: path.join(dir, "a.html") })).data.session.id;
  const on = await switchTo(true, dir);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.deepEqual(on.data.projects.map((p) => p.name), ["alpha"]);
  try {
    assert.match((await browser("127.0.0.9", "GET", `/s/${aid}`)).data, /Ask the owner for access/);
    assert.equal((await browser("127.0.0.9", "GET", `/s/${id}`)).data, "Ask the owner for a link to this page.", "a page of no project");
    const asked = await ask("127.0.0.9", "Eli", aid);
    assert.equal(asked.res.status, 303);
    const [r] = await waiting();
    assert.deepEqual(r.project?.name, "alpha");
    // Approved for the project: the device reaches the project's pages, not the others.
    const approved = await api<RequestDecisionResponse>("POST", "/api/share/approve", { id: r.id, scope: "project" });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.match(approved.data.device?.reaches ?? "", /^project alpha/);
    const joined = await browser("127.0.0.9", "GET", `/s/${aid}`, { cookie: asked.cookie });
    assert.equal(joined.status, 303, "a page load collects the approval too");
    const device = setCookie(joined, "austere_rv_d");
    assert.equal((await browser("127.0.0.9", "GET", `/s/${aid}`, { cookie: device })).status, 200);
    assert.equal((await browser("127.0.0.9", "GET", `/s/${id}`, { cookie: device })).status, 403);
    await api("POST", "/api/share/revoke", { key: "Eli" });
  } finally {
    await switchTo(false, dir);
  }
});

test("behind a reverse proxy on this machine, a request carries the address the proxy saw; a remote peer's own header is ignored", async () => {
  await switchTo(true);
  try {
    const proxied = await browser("127.0.0.1", "POST", `/s/${id}/request`, { form: { name: "Hal" }, headers: { "x-forwarded-for": "203.0.113.9, 100.64.0.7" } });
    assert.equal(proxied.status, 303, proxied.data);
    const forged = await browser("127.0.0.13", "POST", `/s/${id}/request`, { form: { name: "Ivy" }, headers: { "x-forwarded-for": "100.64.0.8" } });
    assert.equal(forged.status, 303, forged.data);
    assert.deepEqual(
      (await waiting()).map((r) => [r.name, r.addr]),
      [
        ["Hal", "100.64.0.7"],
        ["Ivy", "127.0.0.13"],
      ],
    );
    for (const r of await waiting()) await api("POST", "/api/share/deny", { id: r.id });
  } finally {
    await switchTo(false);
  }
});

test("a request whose body arrives after the owner turned requests off is refused, and nothing is stored", async () => {
  await switchTo(true);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<Res>();
    const payload = new URLSearchParams({ name: "Slow" }).toString();
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/s/${id}/request`,
        localAddress: "127.0.0.10",
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded", "content-length": String(payload.length) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data, headers: res.headers }));
      },
    );
    r.on("error", reject);
    r.write(payload.slice(0, 3));
    // Real time on purpose: the server must have taken the headers and passed its first check (requests on) before the switch goes off; nothing it emits marks that point.
    await new Promise((ok) => setTimeout(ok, 200));
    await switchTo(false);
    r.end(payload.slice(3));
    const res = await promise;
    assert.equal(res.status, 403);
    assert.equal(res.data, "Ask the owner for a link to this page.");
    assert.deepEqual(await waiting(), []);
  } finally {
    await switchTo(false);
  }
});

/** The CLI against this test's server. */
function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string }>();
  const p = spawn(process.execPath, ["src/cli/main.ts", ...args], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_PORT: String(port), AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1", OPENUI_TELEMETRY_DISABLED: "1" },
  });
  let out = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (out += c));
  p.on("close", (code) => resolve({ code, out }));
  return promise;
}

test("the CLI: share requests on|off, lists who waits, approves under another name, refuses a taken name", async () => {
  const on = await cli("share", "requests", "on");
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /requests: on for every page/);
  try {
    await ask("127.0.0.11", "Gus");
    await ask("127.0.0.12", "gus");
    const list = await cli("share", "requests");
    assert.equal(list.code, 0, list.out);
    const ids = [...list.out.matchAll(/id: (r[0-9a-f]{10})/g)].map((m) => m[1]);
    assert.equal(ids.length, 2, list.out);
    assert.match(list.out, /from: "?127\.0\.0\.11/);
    assert.match(list.out, /browser: Chrome on Linux/);
    const first = await cli("share", "approve", ids[0]);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /status: approved\nreviewer: Gus\n/);
    const taken = await cli("share", "approve", ids[1]);
    assert.notEqual(taken.code, 0);
    assert.match(taken.out, /gus\\?" already has access with this scope/);
    const renamed = await cli("share", "approve", ids[1], "--as", "Gus 2");
    assert.equal(renamed.code, 0, renamed.out);
    assert.match(renamed.out, /reviewer: Gus 2\n/);
    await cli("share", "revoke", "Gus");
    await cli("share", "revoke", "Gus 2");
  } finally {
    const off = await cli("share", "requests", "off");
    assert.match(off.out, /requests: off/);
  }
});

test("the request routes are the owner's: a device or a stranger cannot list or decide", async () => {
  assert.equal((await browser("127.0.0.2", "GET", "/hub/api/people/requests")).status, 403);
  assert.equal((await browser("127.0.0.2", "POST", "/hub/api/people/requests/switch", { json: { on: true } })).status, 403);
  const foreign = await fetch(`http://127.0.0.1:${port}/hub/api/people/requests`, { headers: { cookie: owner.cookie, origin: "http://evil.example" } });
  assert.equal(foreign.status, 403, "not for another site, GET included");
  assert.equal((await hub("POST", "/hub/api/people/requests/switch", { on: "yes" })).status, 400);
  assert.equal((await api("POST", "/api/share/approve", { id: "r0000000000" })).status, 404);
});
