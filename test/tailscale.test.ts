// Who a reviewer is (RLM-399). Tailscale names a person only for a connection the tailnet listener
// accepted, asked with the socket's own address (a fake `tailscale` here); a header never does. The
// local-network listener serves reviewers only: every owner path answers 403 there.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { OWNER_COOKIE } from "../src/cli/invites.ts";
import { lanAddresses, parseWhois } from "../src/cli/net.ts";
import type { AccessRequestsResponse, AccessSummary, RequestDecisionResponse, SessionsResponse, ShareResponse } from "../src/cli/server.ts";
import type { LocalNetwork } from "../src/shared/hub-api.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const PAGE_HTML = `<!doctype html><html><head><title>Plan</title></head><body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`;

interface Res {
  status: number;
  data: string;
  headers: http.IncomingHttpHeaders;
}

interface Server {
  port: number;
  state: string;
  child: ChildProcess;
  owner: { "x-austere-key": string; cookie: string };
}

/** A request to `host` (a listener's address) from `from`, as a browser there sends it. */
function call(port: number, host: string, method: string, route: string, { from, headers = {}, form, json }: { from?: string; headers?: Record<string, string>; form?: Record<string, string>; json?: unknown } = {}): Promise<Res> {
  const { promise, resolve, reject } = Promise.withResolvers<Res>();
  const payload = form ? new URLSearchParams(form).toString() : json !== undefined ? JSON.stringify(json) : undefined;
  const r = http.request(
    {
      host,
      port,
      method,
      path: route,
      ...(from ? { localAddress: from } : {}),
      headers: {
        host: `${host}:${port}`,
        ...(method === "POST" && !json ? { origin: `http://${host}:${port}` } : {}),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : json !== undefined ? { "content-type": "application/json" } : {}),
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
async function api<T>(srv: Server, method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await call(srv.port, "127.0.0.1", method, route, { headers: { "x-austere-key": srv.owner["x-austere-key"] }, json: body });
  return { status: r.status, data: JSON.parse(r.data) as T };
}

async function startServer(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const state = tmp("austere-ts-state-");
  const child = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1", ...env },
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) break;
    if (i > 100) throw new Error("server did not start");
    // The server is another process with no ready signal but its health route: poll that.
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, state, child, owner: ownerHeaders(state) };
}

async function stopServer(srv: Server): Promise<void> {
  if (srv.child.exitCode === null) {
    const exited = once(srv.child, "exit");
    srv.child.kill();
    await exited;
  }
  fs.rmSync(srv.state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** The device cookie a 303 sets. */
function deviceCookie(r: Res): string {
  const set = ([] as (string | undefined)[]).concat(r.headers["set-cookie"]).find((c) => c?.startsWith("austere_rv_d")) ?? "";
  return set.split(";")[0];
}

const whois = (login: string, name: string, device: string, tags: string[] | null = null) =>
  JSON.stringify({ Node: { Name: `${device}.tail1234.ts.net.`, ComputedName: device, Tags: tags }, UserProfile: { LoginName: login, DisplayName: name } });

test("whois: a person's login, name and device; a tagged device or a bad answer is nobody", () => {
  assert.deepEqual(parseWhois(whois("ana@example.com", "Ana", "ana-phone")), { login: "ana@example.com", name: "Ana", device: "ana-phone" });
  assert.equal(parseWhois(whois("tagged-devices", "Tagged Devices", "ci", ["tag:ci"])), null);
  assert.equal(parseWhois(JSON.stringify({ Node: { ComputedName: "ci", Tags: ["tag:ci"] }, UserProfile: { LoginName: "ana@example.com" } })), null, "a tag wins over a login");
  assert.equal(parseWhois(null), null);
  assert.equal(parseWhois("not json"), null);
  assert.equal(parseWhois("{}"), null);
});

// The fake tailnet: this server's Tailscale address is 127.0.0.2; peers connect from 127.0.0.5 and up.
// 127.0.0.x other than .1 is loopback-only on Linux.
describe("over the tailnet listener", { skip: process.platform !== "linux" && "127.0.0.2 is loopback only on Linux" }, () => {
  const TAILNET = "127.0.0.2";
  const ALICE = "127.0.0.5";
  const TAGGED = "127.0.0.6";
  const FAILING = "127.0.0.7";
  const BOB = "127.0.0.8";
  const CAROL = "127.0.0.9";
  const bin = tmp("austere-ts-bin-");
  const work = tmp("austere-ts-work-");
  const file = path.join(work, "plan.html");
  const calls = path.join(bin, "calls");
  let srv: Server;
  let id = "";
  const whoisCalls = (): string[] => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").split("\n").filter((l) => l.startsWith("whois"));

  before(async () => {
    fs.writeFileSync(file, PAGE_HTML);
    fs.writeFileSync(path.join(bin, `whois-${ALICE}.json`), whois("alice@example.com", "Alice Example", "alice-phone"));
    fs.writeFileSync(path.join(bin, `whois-${TAGGED}.json`), whois("tagged-devices", "Tagged Devices", "ci-runner", ["tag:ci"]));
    fs.writeFileSync(path.join(bin, `whois-${BOB}.json`), whois("bob@example.com", "Bob Builder", "bob-laptop"));
    fs.writeFileSync(path.join(bin, `whois-${CAROL}.json`), whois("carol@example.com", "Carol", "carol-pc"));
    // `status` says Tailscale runs at 127.0.0.2; `whois` answers from the files above and fails for any other address.
    fs.writeFileSync(
      path.join(bin, "tailscale"),
      `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$1" in\n  status) printf '{"BackendState":"Running","Self":{"TailscaleIPs":["${TAILNET}"],"DNSName":""}}' ;;\n  whois) f="${bin}/whois-$3.json"; if [ -f "$f" ]; then cat "$f"; else echo "peer not found" >&2; exit 1; fi ;;\n  *) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    srv = await startServer({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, AUSTERE_AXI_NO_TAILSCALE: "", AUSTERE_AXI_TAILNET_CHECK_MS: "0" });
    id = (await api<{ session: { id: string } }>(srv, "POST", "/api/open", { file })).data.session.id;
  });

  after(async () => {
    await stopServer(srv);
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  test("a login the owner let in opens the page by Tailscale's word; the same headers on loopback are ignored", async () => {
    const allowed = await api<AccessSummary>(srv, "POST", "/api/share/tailscale", { login: "alice@example.com", file, name: "Alice" });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    assert.deepEqual([allowed.data.origin, allowed.data.verifiedLogin, allowed.data.name, allowed.data.scope], ["tailscale", "alice@example.com", "Alice", "page"]);

    const page = await call(srv.port, TAILNET, "GET", `/s/${id}`, { from: ALICE });
    assert.equal(page.status, 200, page.data);
    assert.ok(whoisCalls().includes(`whois --json ${ALICE}`), "asked with the socket's own address");
    const list = await api<{ devices: AccessSummary[] }>(srv, "GET", "/api/share/list");
    const alice = list.data.devices.find((d) => d.id === allowed.data.id);
    assert.equal(alice?.lastAddr, ALICE);
    assert.equal(alice?.lastHost, "alice-phone", "the device as Tailscale names it");

    // Headers that claim to be Alice: from Bob on the tailnet, from a peer on loopback, and from loopback itself.
    const claims = { "tailscale-user-login": "alice@example.com", "tailscale-user-name": "Alice Example", "x-forwarded-for": ALICE };
    const before = whoisCalls().length;
    assert.equal((await call(srv.port, TAILNET, "GET", `/s/${id}`, { from: BOB, headers: claims })).status, 403, "the tailnet listener asks about the socket, not the header");
    assert.equal((await call(srv.port, "127.0.0.1", "GET", `/s/${id}`, { from: ALICE, headers: claims })).status, 403, "loopback never asks Tailscale");
    assert.equal((await call(srv.port, "127.0.0.1", "GET", `/s/${id}`, { headers: claims })).status, 403, "a proxy's X-Forwarded-For names an address, not a person");
    assert.deepEqual(whoisCalls().slice(before), [`whois --json ${BOB}`], "only the tailnet connection was looked up");

    // Revoked: Tailscale still names Alice, but she no longer gets in.
    assert.equal((await api(srv, "POST", "/api/share/revoke", { key: allowed.data.id })).status, 200);
    assert.equal((await call(srv.port, TAILNET, "GET", `/s/${id}`, { from: ALICE })).status, 403);
  });

  test("a tagged device is unknown, and a failing whois degrades to unknown", async () => {
    assert.equal((await api(srv, "POST", "/api/share/requests", { on: true })).status, 200);
    try {
      for (const from of [TAGGED, FAILING]) {
        const page = await call(srv.port, TAILNET, "GET", `/s/${id}`, { from });
        assert.equal(page.status, 403, `${from}: ${page.data}`);
        assert.match(page.data, /<input name="name"/, `${from}: asks for a typed name, as for anyone unknown`);
        assert.doesNotMatch(page.data, /Tailscale says/);
      }
      assert.ok(whoisCalls().includes(`whois --json ${FAILING}`), "the failing lookup was made");
    } finally {
      await api(srv, "POST", "/api/share/requests", { on: false });
    }
  });

  test("a request over Tailscale carries the verified login and device; the device it makes is that login's", async () => {
    assert.equal((await api(srv, "POST", "/api/share/requests", { on: true })).status, 200);
    try {
      const form = await call(srv.port, TAILNET, "GET", `/s/${id}`, { from: BOB });
      assert.equal(form.status, 403);
      assert.match(form.data, /Tailscale says you are <strong>Bob Builder<\/strong> \(bob@example\.com\) on <strong>bob-laptop<\/strong>/);
      // A typed name does not override what Tailscale says.
      const sent = await call(srv.port, TAILNET, "POST", `/s/${id}/request`, { from: BOB, form: { name: "Mallory" } });
      assert.equal(sent.status, 303, sent.data);
      const pending = ([] as (string | undefined)[]).concat(sent.headers["set-cookie"])[0]?.split(";")[0] ?? "";
      const waiting = (await api<AccessRequestsResponse>(srv, "GET", "/api/share/requests")).data.waiting;
      assert.equal(waiting.length, 1);
      assert.deepEqual([waiting[0].name, waiting[0].verifiedLogin, waiting[0].tailscaleDevice, waiting[0].addr], ["Bob Builder", "bob@example.com", "bob-laptop", BOB]);

      const approved = await api<RequestDecisionResponse>(srv, "POST", "/api/share/approve", { id: waiting[0].id });
      assert.equal(approved.status, 200);
      assert.equal(approved.data.device?.verifiedLogin, "bob@example.com");
      const joined = await call(srv.port, TAILNET, "GET", `/s/${id}`, { from: BOB, headers: { cookie: pending } });
      assert.equal(joined.status, 303);
      const cookie = deviceCookie(joined);
      assert.ok(cookie);
      assert.equal((await call(srv.port, TAILNET, "GET", `/s/${id}`, { from: BOB, headers: { cookie } })).status, 200);
      // The same cookie from another Tailscale login: not Bob's browser any more.
      assert.equal((await call(srv.port, TAILNET, "GET", `/s/${id}`, { from: CAROL, headers: { cookie } })).status, 403);
      // On loopback nobody is named: the cookie alone is the device, as before.
      assert.equal((await call(srv.port, "127.0.0.1", "GET", `/s/${id}`, { from: "127.0.0.10", headers: { cookie } })).status, 200);
    } finally {
      await api(srv, "POST", "/api/share/requests", { on: false });
    }
  });
});

// A real local-network address of this machine: the listener binds there. CI runners and laptops have one.
const LAN = lanAddresses().find((a) => net.isIPv4(a.address))?.address;

describe("the local-network listener", { skip: !LAN && "this computer has no local-network IPv4 address" }, () => {
  const lan = LAN as string;
  const work = tmp("austere-lan-work-");
  const file = path.join(work, "plan.html");
  let srv: Server;
  let id = "";

  before(async () => {
    fs.writeFileSync(file, PAGE_HTML);
    srv = await startServer({});
    id = (await api<{ session: { id: string } }>(srv, "POST", "/api/open", { file })).data.session.id;
  });

  after(async () => {
    await stopServer(srv);
    fs.rmSync(work, { recursive: true, force: true });
  });

  test("off by default; refuses an address that is not this computer's", async () => {
    const off = await api<LocalNetwork>(srv, "GET", "/api/settings/lan");
    assert.equal(off.data.address, null);
    assert.ok(off.data.choices.some((c) => c.address === lan));
    await assert.rejects(call(srv.port, lan, "GET", `/s/${id}`), "nothing listens there yet");
    const bad = await api<{ error: string }>(srv, "POST", "/api/settings/lan", { lan: "192.0.2.1" });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /not an address of this computer/);
    assert.equal((await api<{ error: string }>(srv, "POST", "/api/settings/lan", { lan: "0.0.0.0" })).status, 400, "never every address");
  });

  test("on: owner routes and owner sign-in answer 403 with the reason; reviewer routes work", async () => {
    const on = await api<LocalNetwork>(srv, "POST", "/api/settings/lan", { lan });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.deepEqual([on.data.address, on.data.listening, on.data.url], [lan, true, `http://${lan}:${srv.port}`]);

    const reason = /The owner does not sign in over the local network/;
    const ownerCookie = srv.owner.cookie;
    const refused: [string, string, Record<string, string>][] = [
      ["/", "the hub", { cookie: ownerCookie }],
      ["/hub/api/settings", "Settings", { cookie: ownerCookie }],
      [`/s/${id}`, "the page with the owner cookie", { cookie: ownerCookie }],
      [`/s/${id}?key=${srv.owner["x-austere-key"]}`, "the owner's key link", {}],
      [`/s/${id}?login=abc`, "a sign-in code", {}],
      ["/api/sessions", "a control route with the key", { "x-austere-key": srv.owner["x-austere-key"] }],
    ];
    for (const [route, what, headers] of refused) {
      const r = await call(srv.port, lan, "GET", route, { headers });
      assert.equal(r.status, 403, `${what}: ${r.status}`);
      assert.match(r.data, reason, what);
      assert.doesNotMatch(String(r.headers["set-cookie"] ?? ""), new RegExp(`${OWNER_COOKIE}=[^;]`), `${what}: no owner cookie is set`);
    }
    const cleared = await call(srv.port, lan, "GET", `/s/${id}`, { headers: { cookie: ownerCookie } });
    assert.match(String(cleared.headers["set-cookie"]), new RegExp(`^${OWNER_COOKIE}=; Path=/;.*Max-Age=0`), "an owner cookie sent there is cleared");
    const page = await call(srv.port, lan, "GET", `/s/${id}`);
    assert.equal(page.status, 403);
    assert.match(page.data, reason, "an unknown browser is told the owner does not sign in here");

    // No link with the owner key points at the local network; a teammate's link does.
    const sessions = await api<SessionsResponse>(srv, "GET", "/api/sessions");
    assert.equal(sessions.data.sessions.find((s) => s.id === id)?.links.remote, undefined);
    const shared = await api<ShareResponse>(srv, "POST", "/api/share", { file, name: "Dana" });
    assert.equal(shared.status, 200, JSON.stringify(shared.data));
    const link = new URL(shared.data.link);
    assert.equal(link.host, `${lan}:${srv.port}`);

    // The reviewer joins and reviews there: the page, its events, and a note.
    const joined = await call(srv.port, lan, "POST", `/s/${id}/join`, { form: { invite: link.searchParams.get("invite") ?? "" } });
    assert.equal(joined.status, 303, joined.data);
    const cookie = deviceCookie(joined);
    assert.equal((await call(srv.port, lan, "GET", `/s/${id}`, { headers: { cookie } })).status, 200);
    assert.equal((await call(srv.port, lan, "GET", `/s/${id}/transcript`, { headers: { cookie } })).status, 200);
    const note = await call(srv.port, lan, "POST", `/s/${id}/send`, { headers: { cookie, origin: `http://${lan}:${srv.port}`, "content-type": "application/json" }, json: { items: [{ kind: "message", text: "from the LAN" }] } });
    assert.equal(note.status, 200, note.data);
    assert.equal((await call(srv.port, lan, "GET", `/s/${id}/history`, { headers: { cookie } })).status, 403, "an owner route stays the owner's");

    // The owner on this computer is unaffected.
    assert.equal((await call(srv.port, "127.0.0.1", "GET", "/", { headers: { cookie: ownerCookie } })).status, 200);
  });

  test("off again: the listener goes", async () => {
    const off = await api<LocalNetwork>(srv, "POST", "/api/settings/lan", { lan: null });
    assert.deepEqual([off.status, off.data.address, off.data.listening], [200, null, false]);
    await assert.rejects(call(srv.port, lan, "GET", `/s/${id}`));
  });

  test("an AUSTERE_AXI_LINK_HOST that names the local-network address gets no owner key link", async () => {
    const other = await startServer({ AUSTERE_AXI_LINK_HOST: lan });
    try {
      assert.equal((await api<LocalNetwork>(other, "POST", "/api/settings/lan", { lan })).status, 200);
      const opened = await api<{ links: { local: string; remote?: string } }>(other, "POST", "/api/open", { file });
      assert.equal(opened.data.links.remote, undefined, "the key would cross the local network in plain HTTP");
      assert.match(opened.data.links.local, /^http:\/\/127\.0\.0\.1:/);
    } finally {
      await stopServer(other);
    }
  });
});
