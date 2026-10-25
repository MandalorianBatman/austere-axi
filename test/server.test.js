import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const PORT = 46000 + Math.floor(Math.random() * 1000);
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-test-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-work-"));
const FILE = path.join(WORK, "plan.html");
let server;

function req(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port: PORT, method, path: route, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, data: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
  fs.writeFileSync(path.join(WORK, "shot.png"), "png");
  server = spawn(process.execPath, ["src/cli/main.js", "server", "--port", String(PORT)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await req("GET", "/api/health");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

test("open, poll, send, reply, end", async () => {
  const open = await req("POST", "/api/open", { file: FILE });
  assert.equal(open.status, 200);
  assert.equal(open.data.status, "open");
  const id = open.data.session.id;

  const pollP = req("POST", "/api/poll", { file: FILE });
  await new Promise((r) => setTimeout(r, 100));
  const second = await req("POST", "/api/poll", { file: FILE });
  assert.equal(second.status, 409, "a second poll is refused while one listens");

  const host = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };
  const sent = await req(
    "POST",
    `/s/${id}/send`,
    { items: [{ kind: "annotation", target: "intro", component: "TextContent", note: "louder" }, { kind: "message", text: "thanks" }] },
    host,
  );
  assert.equal(sent.status, 200);
  const poll = await pollP;
  assert.equal(poll.data.status, "feedback");
  assert.deepEqual(
    poll.data.items.map((i) => i.kind),
    ["annotation", "message"],
  );

  const reply = await req("POST", "/api/reply", { file: FILE, text: "Made it louder." });
  assert.equal(reply.status, 200);

  const crossOrigin = await req("POST", `/s/${id}/end`, {}, { ...host, origin: "http://evil.example" });
  assert.equal(crossOrigin.status, 403);

  const end = await req("POST", `/s/${id}/end`, {}, host);
  assert.equal(end.status, 200);
  const after = await req("POST", "/api/poll", { file: FILE });
  assert.equal(after.data.status, "ended");
  assert.equal(after.data.endedBy, "user");

  const refused = await req("POST", "/api/open", { file: FILE });
  assert.equal(refused.data.status, "refused", "a user-ended review is not reopened uninvited");
  const reopened = await req("POST", "/api/open", { file: FILE, reopen: true });
  assert.equal(reopened.data.status, "open");
});

test("feedback sent while no agent listens waits for the next poll", async () => {
  const open = await req("POST", "/api/open", { file: FILE });
  const id = open.data.session.id;
  const host = { host: `127.0.0.1:${PORT}` };
  await req("POST", `/s/${id}/send`, { items: [{ kind: "message", text: "queued while away" }] }, host);
  const poll = await req("POST", "/api/poll", { file: FILE });
  assert.equal(poll.data.status, "feedback");
  assert.equal(poll.data.items[0].text, "queued while away");
});

test("serves the artifact with a local runtime and confines sibling files", async () => {
  const open = await req("POST", "/api/open", { file: FILE });
  const id = open.data.session.id;
  const host = { host: `127.0.0.1:${PORT}` };
  const page = await req("GET", `/s/${id}/a/plan.html`, undefined, host);
  assert.equal(page.status, 200);
  assert.match(page.data, /src="\/__austere\/austere\.js/);
  assert.doesNotMatch(page.data, /jsdelivr/);
  assert.equal((await req("GET", `/s/${id}/a/shot.png`, undefined, host)).status, 200);
  assert.equal((await req("GET", `/s/${id}/a/..%2F..%2Fetc%2Fpasswd`, undefined, host)).status, 404);
  assert.equal((await req("GET", `/s/${id}/a/plan.html`, undefined, { host: "evil.example" })).status, 403);
});
