// Component packs: the catalog, the page tag, schema merging, and the whole
// author → install → use loop through the CLI (folder and npm registry).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import { catalogFromSpec, promptSpec, searchCatalog } from "../src/shared/catalog.js";
import { formatPacksMeta, parsePacksMeta, splitSpec } from "../src/shared/packs-meta.js";
import { mergePackSchemas, setPacksMeta } from "../src/cli/packs.js";
import { looksLikePath, pickVersion, untar } from "../src/cli/install.js";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-work-"));
process.env.AUSTERE_AXI_STATE_DIR = STATE;
process.env.OPENUI_TELEMETRY_DISABLED = "1";
const ENV = { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1" };

// Async: the mock registry below answers from this process while the CLI runs.
function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.js", ...args], { env: ENV });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const page = (program, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Packs</title>
${head}<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>`;

after(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

// ── pure parts ──

test("the packs tag: scoped names, integrity, junk dropped, round trip", () => {
  assert.deepEqual(splitSpec("@acme/flows@1.2.3"), { name: "@acme/flows", version: "1.2.3" });
  assert.deepEqual(splitSpec("@acme/flows"), { name: "@acme/flows", version: "" });
  const list = parsePacksMeta("gantt@1.0.0 sha384-abc+/=, @acme/flows@0.3.1, bad name@1, nover, gantt@2.0.0, x@1.0");
  assert.deepEqual(list, [
    { name: "gantt", version: "1.0.0", integrity: "sha384-abc+/=" },
    { name: "@acme/flows", version: "0.3.1" },
  ]);
  assert.equal(formatPacksMeta(list), "gantt@1.0.0 sha384-abc+/=, @acme/flows@0.3.1");
});

test("setPacksMeta puts the tag before the runtime script, replaces it, and removes it", () => {
  const html = page('root = Stack([a])\na = TextContent("x")');
  const one = setPacksMeta(html, [{ name: "gantt", version: "1.0.0" }]);
  assert.ok(one.indexOf('<meta name="austere-packs" content="gantt@1.0.0">') < one.indexOf("austere.js"));
  const two = setPacksMeta(one, [{ name: "gantt", version: "1.1.0", integrity: "sha384-x" }]);
  assert.equal(two.match(/austere-packs/g).length, 1);
  assert.match(two, /content="gantt@1\.1\.0 sha384-x"/);
  assert.equal(setPacksMeta(two, []), html);
});

test("catalog: tiers leave the prompt but stay searchable; search ranks names first", () => {
  const spec = {
    components: {
      BarChart: { signature: "BarChart(labels: string[])", description: "Vertical bars" },
      AreaChart: { signature: "AreaChart(labels: string[])", description: "Filled area under lines" },
      Table: { signature: "Table(cols: Col[])", description: "Rows and columns" },
    },
    componentGroups: [
      { name: "Charts", components: ["BarChart", "AreaChart"], notes: ["- Charts take column arrays."] },
      { name: "Data", components: ["Table"], notes: [] },
    ],
  };
  const tiers = { AreaChart: "extended" };
  const cat = catalogFromSpec(spec, { version: "1.0.0", tiers, examples: { Table: ["t = Table([])"] } });
  assert.equal(cat.components.find((c) => c.name === "AreaChart").tier, "extended");
  assert.deepEqual(cat.components.find((c) => c.name === "Table").examples, ["t = Table([])"]);
  const p = promptSpec(spec, tiers);
  assert.deepEqual(Object.keys(p.components), ["BarChart", "Table"]);
  assert.match(p.componentGroups[0].notes.at(-1), /Also in Charts .*: AreaChart\./);
  const hits = searchCatalog(cat.components, "area chart");
  assert.equal(hits[0].entry.name, "AreaChart");
  assert.equal(searchCatalog(cat.components, "rows")[0].entry.name, "Table");
  assert.deepEqual(searchCatalog(cat.components, "   "), []);
});

test("mergePackSchemas adds the component, its defs and its slots, and leaves core components alone", () => {
  const core = {
    properties: { Card: { $ref: "#/$defs/Card" } },
    required: ["Card"],
    $defs: { Card: { properties: { children: { type: "array", items: { anyOf: [{ $ref: "#/$defs/Card" }] } } } } },
  };
  const cat = {
    components: [
      { name: "Gantt", slots: ["Card.children", "Nope.children"] },
      { name: "GanttTask", slots: null },
      { name: "Card", slots: ["Card.children"] },
    ],
    defs: { Gantt: { type: "object" }, GanttTask: { type: "object" }, Card: { type: "string" } },
  };
  const out = mergePackSchemas(core, [cat]);
  assert.deepEqual(out.properties.Gantt, { $ref: "#/$defs/Gantt" });
  assert.ok(out.required.includes("GanttTask"));
  assert.deepEqual(out.$defs.Card.properties.children.items.anyOf, [{ $ref: "#/$defs/Card" }, { $ref: "#/$defs/Gantt" }]);
  assert.notEqual(out.$defs.Card.type, "string");
  assert.equal(core.required.length, 1, "the core schema is not mutated");
});

test("pickVersion: tags, exact versions and ranges", () => {
  const meta = { "dist-tags": { latest: "1.4.0", next: "2.0.0-rc.1" }, versions: Object.fromEntries(["0.2.1", "0.2.5", "0.3.0", "1.2.0", "1.4.0", "2.0.0-rc.1"].map((v) => [v, {}])) };
  assert.equal(pickVersion(meta, ""), "1.4.0");
  assert.equal(pickVersion(meta, "next"), "2.0.0-rc.1");
  assert.equal(pickVersion(meta, "1.2.0"), "1.2.0");
  assert.equal(pickVersion(meta, "^1.2.0"), "1.4.0");
  assert.equal(pickVersion(meta, "^0.2.1"), "0.2.5");
  assert.equal(pickVersion(meta, "~0.2.0"), "0.2.5");
  assert.equal(pickVersion(meta, "0"), "0.3.0");
  assert.equal(pickVersion(meta, "^3.0.0"), null);
  assert.equal(pickVersion(meta, "9.9.9"), null);
});

function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function tgz(files) {
  return zlib.gzipSync(Buffer.concat([...Object.entries(files).map(([n, d]) => tarEntry(`package/${n}`, Buffer.from(d))), Buffer.alloc(1024)]));
}

test("folders and tarballs are told apart from npm names", () => {
  for (const p of [".", "./x", "../x", "/abs/x", "~/x", "packs/timeline", "C:\\packs\\x", "x-1.0.0.tgz"]) assert.ok(looksLikePath(p), p);
  for (const n of ["gantt", "gantt@1.2.0", "@acme/flows", "@acme/flows@^1"]) assert.ok(!looksLikePath(n), n);
});

test("untar reads files under the package folder", () => {
  const files = untar(zlib.gunzipSync(tgz({ "dist/pack.js": "x()", "package.json": "{}" })));
  assert.equal(files.get("dist/pack.js").toString(), "x()");
  assert.equal(files.get("package.json").toString(), "{}");
});

// ── the loop through the CLI ──

const PACK = path.join(WORK, "austere-pack-timeline");

test("new → build → add → show → check --fix → export → spec → remove", async () => {
  let r = await cli("components", "new", PACK);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(PACK, "src/Timeline.jsx")));
  r = await cli("components", "build", PACK);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status: built/);
  const cat = JSON.parse(fs.readFileSync(path.join(PACK, "dist/catalog.json"), "utf8"));
  assert.equal(cat.pack, "austere-pack-timeline");
  assert.equal(cat.components[0].signature, "Timeline(events: string[])");
  assert.ok(cat.defs.Timeline);
  assert.match(cat.integrity, /^sha384-/);

  r = await cli("components", "add", PACK);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /trust: local/);
  r = await cli("components", "show", "Timeline");
  assert.match(r.out, /from: pack austere-pack-timeline@0\.1\.0/);
  assert.match(r.out, /check --fix/);
  r = await cli("components", "search", "timeline", "events");
  assert.match(r.out, /Timeline\(events: string\[\]\)/);

  const file = path.join(WORK, "launch.html");
  fs.writeFileSync(file, page('root = Stack([c])\nc = Card([CardHeader("Launch"), t])\nt = Timeline(["Mon | Freeze", "Fri | GA"])'));
  r = await cli("check", file);
  assert.equal(r.code, 1);
  assert.match(r.out, /code: missing-pack/);
  assert.doesNotMatch(r.out, /Available components/);
  r = await cli("check", "--fix", file);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /declared austere-pack-timeline@0\.1\.0/);
  assert.match(fs.readFileSync(file, "utf8"), /<meta name="austere-packs" content="austere-pack-timeline@0\.1\.0 sha384-/);
  assert.match((await cli("check", file)).out, /status: ok/);
  // A second --fix changes nothing.
  assert.doesNotMatch((await cli("check", "--fix", file)).out, /fixed/);

  r = await cli("export", file, "--out", path.join(WORK, "launch.export.html"));
  assert.equal(r.code, 0, r.out);
  const exported = fs.readFileSync(path.join(WORK, "launch.export.html"), "utf8");
  assert.ok(exported.includes(fs.readFileSync(path.join(PACK, "dist/pack.js"), "utf8").slice(0, 200).replace(/<\/script/gi, "<\\/script")));

  // Rebuilt and added again at the same version: the page's hash is stale, and check says so.
  fs.appendFileSync(path.join(PACK, "src/style.css"), "\n.pack-timeline strong { letter-spacing: 0; }\n");
  assert.equal((await cli("components", "build", PACK)).code, 0);
  r = await cli("components", "add", PACK);
  assert.match(r.out, /update their integrity hash/);
  r = await cli("check", file);
  assert.match(r.out, /code: pack-integrity/);
  r = await cli("check", "--fix", file);
  assert.match(r.out, /fixed: \[updated integrity hashes\]/);
  assert.doesNotMatch((await cli("check", file)).out, /pack-integrity/);

  r = await cli("spec");
  assert.match(r.out, /## Installed packs\n.*check --fix.*\n- austere-pack-timeline@0\.1\.0: Timeline/);
  r = await cli("spec", "austere-pack-timeline");
  assert.match(r.out, /^### austere-pack-timeline@0\.1\.0 \(third-party\)/);
  assert.match(r.out, /Timeline\(events: string\[\]\) — Vertical timeline/);

  r = await cli("components", "remove", "austere-pack-timeline");
  assert.match(r.out, /status: removed/);
  r = await cli("check", file);
  assert.match(r.out, /pack-not-installed/);
  assert.match(r.out, /is not installed here/);
});

test("export inlines the bundled Mermaid pack after the runtime", async () => {
  const file = path.join(WORK, "flow.html");
  fs.writeFileSync(file, page('root = Stack([f])\nf = Mermaid("flowchart LR\n  a --> b")'));
  const r = await cli("export", file, "--out", path.join(WORK, "flow.export.html"));
  assert.equal(r.code, 0, r.out);
  const html = fs.readFileSync(path.join(WORK, "flow.export.html"), "utf8");
  const head = (f) => fs.readFileSync(path.join("dist", f), "utf8").slice(0, 300).replace(/<\/script/gi, "<\\/script");
  const runtimeAt = html.indexOf(head("austere.js"));
  const packAt = html.indexOf(head("packs/mermaid/pack.js"));
  assert.ok(packAt > 0, "the Mermaid pack is inlined");
  assert.ok(runtimeAt > 0 && runtimeAt < packAt, "after the runtime");
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/austere-axi/);
});

test("a tarball needs --trust whatever name it claims; a folder is local but still third-party", async () => {
  const dir = path.join(WORK, "claims-first-party");
  await cli("components", "new", dir, "--name", "@austere-axi/pack-claims");
  assert.equal((await cli("components", "build", dir)).code, 0);
  const file = path.join(WORK, "claims.tgz");
  fs.writeFileSync(
    file,
    tgz({
      "package.json": fs.readFileSync(path.join(dir, "package.json")),
      "dist/pack.js": fs.readFileSync(path.join(dir, "dist/pack.js")),
      "dist/catalog.json": fs.readFileSync(path.join(dir, "dist/catalog.json")),
    }),
  );
  let r = await cli("components", "add", file);
  assert.equal(r.code, 1);
  assert.match(r.out, /needs --trust/);
  r = await cli("components", "add", file, "--trust");
  assert.match(r.out, /trust: --trust/);
  r = await cli("components", "list");
  assert.match(r.out, /pack: @austere-axi\/pack-claims@0\.1\.0\n\s+trust: third-party/);
  r = await cli("components", "add", dir);
  assert.match(r.out, /trust: local/);
  r = await cli("spec", "@austere-axi/pack-claims");
  assert.match(r.out, /\(third-party\)/);
  await cli("components", "remove", "@austere-axi/pack-claims");
});

test("components build refuses a slot that names no component", async () => {
  const dir = path.join(WORK, "bad-slot");
  await cli("components", "new", dir);
  const file = path.join(dir, "src/Timeline.jsx");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('renderer: TimelineView,', 'renderer: TimelineView,\n  slots: ["Nope.children"],'));
  const r = await cli("components", "build", dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /slot Nope\.children: Nope is not a component here/);
});

test("unknown components point at search instead of listing everything", async () => {
  const file = path.join(WORK, "unknown.html");
  fs.writeFileSync(file, page('root = Stack([s])\ns = Sparkline([1, 2])'));
  const r = await cli("check", file);
  assert.match(r.out, /components search sparkline/);
  assert.doesNotMatch(r.out, /Available components/);
});

// ── npm registry ──

let registry;
let registryPort;
const published = {};

function publish(name, version, files) {
  const tarball = tgz(files);
  published[name] ||= { name, "dist-tags": {}, versions: {} };
  published[name]["dist-tags"].latest = version;
  published[name].versions[version] = {
    name,
    version,
    dist: {
      tarball: `http://127.0.0.1:${registryPort}/tarballs/${encodeURIComponent(name)}-${version}.tgz`,
      integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`,
    },
  };
  published[`${name}-${version}.tgz`] = tarball;
}

before(async () => {
  registry = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.slice(1));
    if (url.startsWith("tarballs/")) {
      const body = published[url.slice("tarballs/".length)];
      if (!body) return res.writeHead(404).end();
      return res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    }
    const meta = published[url];
    if (!meta || typeof meta !== "object" || Buffer.isBuffer(meta)) return res.writeHead(404).end("{}");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(meta));
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));
  registryPort = registry.address().port;
  ENV.AUSTERE_AXI_NPM_REGISTRY = `http://127.0.0.1:${registryPort}/`;
});

after(() => registry?.close());

async function builtPackFiles(name, version) {
  const dir = path.join(WORK, `src-${name.replace(/\W/g, "-")}-${version}`);
  await cli("components", "new", dir, "--name", name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.version = version;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  const r = await cli("components", "build", dir);
  assert.equal(r.code, 0, r.out);
  return {
    "package.json": JSON.stringify(pkg),
    "dist/pack.js": fs.readFileSync(path.join(dir, "dist/pack.js")),
    "dist/catalog.json": fs.readFileSync(path.join(dir, "dist/catalog.json")),
  };
}

test("installing from the registry: third-party packs need --trust; ranges resolve; integrity is checked", async () => {
  publish("austere-pack-steps", "1.0.0", await builtPackFiles("austere-pack-steps", "1.0.0"));
  publish("austere-pack-steps", "1.1.0", await builtPackFiles("austere-pack-steps", "1.1.0"));
  let r = await cli("components", "add", "austere-pack-steps");
  assert.equal(r.code, 1);
  assert.match(r.out, /needs --trust/);
  r = await cli("components", "add", "austere-pack-steps@~1.0.0", "--trust");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pack: austere-pack-steps@1\.0\.0/);
  r = await cli("components", "add", "austere-pack-steps", "--trust");
  assert.match(r.out, /pack: austere-pack-steps@1\.1\.0\nreplaced: "1\.0\.0"/);
  const lock = JSON.parse(fs.readFileSync(path.join(STATE, "packs.json"), "utf8"));
  assert.equal(lock.packs["austere-pack-steps"].trust, "--trust");
  assert.equal(lock.packs["austere-pack-steps"].source, "npm");
  assert.ok(!fs.existsSync(path.join(STATE, "packs", "austere-pack-steps@1.0.0")), "the replaced version is removed");

  // First-party scope: no --trust needed.
  publish("@austere-axi/pack-steps", "0.1.0", await builtPackFiles("@austere-axi/pack-steps", "0.1.0"));
  r = await cli("components", "add", "@austere-axi/pack-steps");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /trust: first-party/);

  // A tampered tarball fails the registry's integrity hash.
  publish("austere-pack-evil", "1.0.0", await builtPackFiles("austere-pack-evil", "1.0.0"));
  published["austere-pack-evil-1.0.0.tgz"] = tgz({ "dist/pack.js": "alert(1)", "dist/catalog.json": "{}" });
  r = await cli("components", "add", "austere-pack-evil", "--trust");
  assert.equal(r.code, 1);
  assert.match(r.out, /does not match the registry's integrity hash/);

  // A catalog whose pack.js changed after it was built is refused.
  const files = await builtPackFiles("austere-pack-stale", "1.0.0");
  files["dist/pack.js"] = Buffer.concat([files["dist/pack.js"], Buffer.from("\n;")]);
  publish("austere-pack-stale", "1.0.0", files);
  r = await cli("components", "add", "austere-pack-stale", "--trust");
  assert.equal(r.code, 1);
  assert.match(r.out, /changed after its catalog was built/);

  r = await cli("components", "add", "austere-pack-missing", "--trust");
  assert.match(r.out, /no package austere-pack-missing/);
});

// ── the review server serves installed packs ──

test("the server serves an installed pack only at its locked version and hash", async () => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ["src/cli/main.js", "server", "--port", String(port)], { env: ENV, stdio: "ignore" });
  const get = (p, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        })
        .on("error", reject);
    });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await get("/api/health")).status === 200) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    const lock = JSON.parse(fs.readFileSync(path.join(STATE, "packs.json"), "utf8")).packs["austere-pack-steps"];
    const route = `/__austere/installed-packs/${encodeURIComponent("austere-pack-steps@1.1.0")}/pack.js`;
    const ok = await get(`${route}?integrity=${encodeURIComponent(lock.integrity)}`);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /registerPack|austere-pack-steps/);
    assert.equal((await get(`/__austere/installed-packs/${encodeURIComponent("austere-pack-steps@1.0.0")}/pack.js`)).status, 404);
    assert.equal((await get(`${route}?integrity=sha384-wrong`)).status, 409);

    // poll tells the agent when the page runs third-party pack code.
    ENV.AUSTERE_AXI_PORT = String(port);
    const page3p = path.join(WORK, "steps.html");
    fs.writeFileSync(
      page3p,
      page('root = Stack([t])\nt = Timeline(["Mon | Freeze"])', `<meta name="austere-packs" content="austere-pack-steps@1.1.0 ${lock.integrity}">\n`),
    );
    const opened = await cli(page3p, "--no-open");
    assert.match(opened.out, /status: open/);
    const sid = /\/s\/([a-f0-9]{12})/.exec(opened.out)[1];
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ items: [{ kind: "message", text: "ship it" }] });
      const r = http.request(
        { host: "127.0.0.1", port, method: "POST", path: `/s/${sid}/send`, headers: { "content-type": "application/json", host: `127.0.0.1:${port}` } },
        (res) => res.resume().on("end", resolve),
      );
      r.on("error", reject);
      r.end(body);
    });
    const polled = await cli("poll", page3p);
    assert.match(polled.out, /status: feedback/);
    assert.match(polled.out, /caution: .*third-party pack code \(austere-pack-steps@1\.1\.0\)/);
    delete ENV.AUSTERE_AXI_PORT;

    // Tampered on disk after install.
    const file = path.join(STATE, "packs", "austere-pack-steps@1.1.0", "pack.js");
    fs.appendFileSync(file, "\n;");
    assert.equal((await get(route)).status, 409);
    // Control routes refuse browsers (any page could otherwise call them on localhost).
    assert.equal((await get("/api/health", { origin: "https://evil.example" })).status, 403);
    assert.equal((await get("/api/health", { "sec-fetch-site": "cross-site" })).status, 403);
  } finally {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill();
    await exited;
  }
});
