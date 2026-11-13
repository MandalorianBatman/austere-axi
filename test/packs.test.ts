// Component packs: the catalog, the page tag, schema merging, and the whole
// author → install → use loop through the CLI (folder and npm registry).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import { catalogFromSpec, promptSpec, searchCatalog } from "../src/shared/catalog.ts";
import { formatPacksMeta, parsePacksMeta, splitSpec } from "../src/shared/packs-meta.ts";
import { mergePackSchemas, setPacksMeta } from "../src/cli/packs.ts";
import { looksLikePath, pickVersion, untar } from "../src/cli/install.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";
import type { PackCatalog } from "../types/catalog.d.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-work-"));
process.env.AUSTERE_AXI_STATE_DIR = STATE;
process.env.OPENUI_TELEMETRY_DISABLED = "1";
const ENV: NodeJS.ProcessEnv = { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1" };

/** dist/catalog.json of a built pack, as far as these tests read it. */
interface BuiltCatalog {
  pack: string;
  components: { name: string; signature: string }[];
  defs: Record<string, unknown>;
  integrity: string;
}

/** packs.json in the state dir. */
interface PacksLock {
  packs: Record<string, { trust: string; source: string; integrity: string }>;
}

interface RegistryMeta {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, { name: string; version: string; dist: { tarball: string; integrity: string } }>;
}

// Async: the mock registry below answers from this process while the CLI runs.
function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
  return cliWith(ENV, ...args);
}

function cliWith(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.ts", ...args], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const page = (program: string, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Packs</title>
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
  assert.equal(two.match(/austere-packs/g)?.length, 1);
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
  assert.equal(cat.components.find((c) => c.name === "AreaChart")?.tier, "extended");
  assert.deepEqual(cat.components.find((c) => c.name === "Table")?.examples, ["t = Table([])"]);
  const p = promptSpec(spec, tiers);
  assert.deepEqual(Object.keys(p.components), ["BarChart", "Table"]);
  assert.match(p.componentGroups[0].notes.at(-1) as string, /Also in Charts .*: AreaChart\./);
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
  const out = mergePackSchemas(core, [cat as unknown as PackCatalog]);
  assert.deepEqual(out.properties?.Gantt, { $ref: "#/$defs/Gantt" });
  assert.ok(out.required?.includes("GanttTask"));
  assert.deepEqual(out.$defs?.Card.properties?.children.items?.anyOf, [{ $ref: "#/$defs/Card" }, { $ref: "#/$defs/Gantt" }]);
  assert.notEqual(out.$defs?.Card.type, "string");
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

function tarEntry(name: string, data: Buffer): Buffer {
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

function tgz(files: Record<string, string | Buffer>): Buffer {
  return zlib.gzipSync(Buffer.concat([...Object.entries(files).map(([n, d]) => tarEntry(`package/${n}`, Buffer.from(d))), Buffer.alloc(1024)]));
}

test("folders and tarballs are told apart from npm names", () => {
  for (const p of [".", "./x", "../x", "/abs/x", "~/x", "packs/milestones", "C:\\packs\\x", "x-1.0.0.tgz"]) assert.ok(looksLikePath(p), p);
  for (const n of ["gantt", "gantt@1.2.0", "@acme/flows", "@acme/flows@^1"]) assert.ok(!looksLikePath(n), n);
});

test("untar reads files under the package folder", () => {
  const files = untar(zlib.gunzipSync(tgz({ "dist/pack.js": "x()", "package.json": "{}" })));
  assert.equal(files.get("dist/pack.js")?.toString(), "x()");
  assert.equal(files.get("package.json")?.toString(), "{}");
});

// ── the loop through the CLI ──

const PACK = path.join(WORK, "austere-pack-milestones");

test("new → build → add → show → check --fix → export → spec → remove", async () => {
  let r = await cli("components", "new", PACK);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(PACK, "src/Milestones.jsx")));
  r = await cli("components", "build", PACK);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status: built/);
  const cat = JSON.parse(fs.readFileSync(path.join(PACK, "dist/catalog.json"), "utf8")) as BuiltCatalog;
  assert.equal(cat.pack, "austere-pack-milestones");
  assert.equal(cat.components[0].signature, "Milestones(events: string[])");
  assert.ok(cat.defs.Milestones);
  assert.match(cat.integrity, /^sha384-/);

  r = await cli("components", "add", PACK);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /trust: local/);
  r = await cli("components", "show", "Milestones");
  assert.match(r.out, /from: pack austere-pack-milestones@0\.1\.0/);
  assert.match(r.out, /check --fix/);
  r = await cli("components", "search", "milestones", "events");
  assert.match(r.out, /Milestones\(events: string\[\]\)/);

  const file = path.join(WORK, "launch.html");
  fs.writeFileSync(file, page('root = Stack([c])\nc = Card([CardHeader("Launch"), t])\nt = Milestones(["Mon | Freeze", "Fri | GA"])'));
  r = await cli("check", file);
  assert.equal(r.code, 1);
  assert.match(r.out, /code: missing-pack/);
  assert.doesNotMatch(r.out, /Available components/);
  r = await cli("check", "--fix", file);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /declared austere-pack-milestones@0\.1\.0/);
  assert.match(fs.readFileSync(file, "utf8"), /<meta name="austere-packs" content="austere-pack-milestones@0\.1\.0 sha384-/);
  assert.match((await cli("check", file)).out, /status: ok/);
  // A second --fix changes nothing.
  assert.doesNotMatch((await cli("check", "--fix", file)).out, /fixed/);

  r = await cli("export", file, "--out", path.join(WORK, "launch.export.html"));
  assert.equal(r.code, 0, r.out);
  const exported = fs.readFileSync(path.join(WORK, "launch.export.html"), "utf8");
  assert.ok(exported.includes(fs.readFileSync(path.join(PACK, "dist/pack.js"), "utf8").slice(0, 200).replace(/<\/script/gi, "<\\/script")));

  // Rebuilt and added again at the same version: the page's hash is stale, and check says so.
  fs.appendFileSync(path.join(PACK, "src/style.css"), "\n.pack-milestones strong { letter-spacing: 0; }\n");
  assert.equal((await cli("components", "build", PACK)).code, 0);
  r = await cli("components", "add", PACK);
  assert.match(r.out, /update their integrity hash/);
  r = await cli("check", file);
  assert.match(r.out, /code: pack-integrity/);
  r = await cli("check", "--fix", file);
  assert.match(r.out, /fixed: \[updated integrity hashes\]/);
  assert.doesNotMatch((await cli("check", file)).out, /pack-integrity/);

  r = await cli("spec");
  assert.match(r.out, /## Installed packs\n.*check --fix.*\n- austere-pack-milestones@0\.1\.0: Milestones/);
  r = await cli("spec", "austere-pack-milestones");
  assert.match(r.out, /^### austere-pack-milestones@0\.1\.0 \(third-party\)/);
  assert.match(r.out, /Milestones\(events: string\[\]\) — Vertical milestones/);

  r = await cli("components", "remove", "austere-pack-milestones");
  assert.match(r.out, /status: removed/);
  r = await cli("check", file);
  assert.match(r.out, /pack-not-installed/);
  assert.match(r.out, /is not installed here/);
});

test("export inlines the bundled shadcn pack after the runtime", async () => {
  const file = path.join(WORK, "progress.html");
  fs.writeFileSync(file, page('root = Stack([p])\np = Progress(64, "Rows migrated")'));
  const r = await cli("export", file, "--out", path.join(WORK, "progress.export.html"));
  assert.equal(r.code, 0, r.out);
  const html = fs.readFileSync(path.join(WORK, "progress.export.html"), "utf8");
  const head = (f: string) => fs.readFileSync(path.join("dist", f), "utf8").slice(0, 300).replace(/<\/script/gi, "<\\/script");
  const runtimeAt = html.indexOf(head("austere.js"));
  const packAt = html.indexOf(head("packs/shadcn/pack.js"));
  assert.ok(packAt > 0, "the shadcn pack is inlined");
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
  assert.match(r.out, /Ask the user to look at it and run `austere-axi components add \S+ --trust` themselves/);
  assert.doesNotMatch(r.out, /rerun with --trust/i, "the agent is not told to pass --trust itself");
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
  const file = path.join(dir, "src/Milestones.jsx");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('renderer: MilestonesView,', 'renderer: MilestonesView,\n  slots: ["Nope.children"],'));
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

test("a removed component says what replaced it", async () => {
  const file = path.join(WORK, "removed.html");
  fs.writeFileSync(file, page('root = Stack([d])\nd = Mermaid("graph LR\\nA-->B")'));
  const r = await cli("check", file);
  assert.equal(r.code, 1);
  assert.match(r.out, /Mermaid was removed from austere-axi\. Draw the diagram with Architecture/);
  assert.doesNotMatch(r.out, /components search mermaid/);
});

// ── npm registry ──

/** A fake npm registry: what is published on it, and every request it got. */
interface FakeRegistry {
  url: string;
  server: http.Server;
  published: Record<string, RegistryMeta | Buffer>;
  keywordsOf: Record<string, string[]>;
  /** Statuses it answers a tarball with, one per request, before it serves the tarball. */
  tarballFailures: Map<string, number[]>;
  /** Requests it got for each tarball. */
  tarballRequests: Map<string, number>;
  /** While set, it never answers a search. */
  searchStalled: boolean;
  /** While set, it drops every connection. */
  down: boolean;
  requests: { path: string; authorization: string | undefined }[];
}

async function startRegistry(): Promise<FakeRegistry> {
  const reg: FakeRegistry = { url: "", server: http.createServer(), published: {}, keywordsOf: {}, tarballFailures: new Map(), tarballRequests: new Map(), searchStalled: false, down: false, requests: [] };
  reg.server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (reg.down) return req.socket.destroy();
    reg.requests.push({ path: req.url ?? "/", authorization: req.headers.authorization });
    const search = new URL(req.url ?? "/", "http://registry");
    if (search.pathname === "/-/v1/search") {
      if (reg.searchStalled) return;
      const keyword = /^keywords:(.+)$/.exec(search.searchParams.get("text") ?? "")?.[1];
      const objects = Object.entries(reg.keywordsOf)
        .filter(([, k]) => keyword && k.includes(keyword))
        .map(([name]) => {
          const meta = reg.published[name] as RegistryMeta;
          return { package: { name, version: meta["dist-tags"].latest, keywords: reg.keywordsOf[name] } };
        });
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ objects, total: objects.length }));
    }
    const url = decodeURIComponent((req.url ?? "").slice(1));
    if (url.startsWith("tarballs/")) {
      const file = url.slice("tarballs/".length);
      reg.tarballRequests.set(file, (reg.tarballRequests.get(file) ?? 0) + 1);
      const status = reg.tarballFailures.get(file)?.shift();
      if (status) return res.writeHead(status).end();
      const body = reg.published[file];
      if (!body) return res.writeHead(404).end();
      return res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    }
    const meta = reg.published[url];
    if (!meta || typeof meta !== "object" || Buffer.isBuffer(meta)) return res.writeHead(404).end("{}");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(meta));
  });
  await new Promise<void>((r) => reg.server.listen(0, "127.0.0.1", r));
  reg.url = `http://127.0.0.1:${(reg.server.address() as AddressInfo).port}/`;
  return reg;
}

/** The default registry (AUSTERE_AXI_NPM_REGISTRY) of every test. */
let npm: FakeRegistry;

function publish(name: string, version: string, files: Record<string, string | Buffer>, on: FakeRegistry = npm) {
  const tarball = tgz(files);
  on.published[name] ||= { name, "dist-tags": {}, versions: {} };
  const meta = on.published[name];
  if (Buffer.isBuffer(meta)) throw new Error(`${name} is a tarball`);
  meta["dist-tags"].latest = version;
  meta.versions[version] = {
    name,
    version,
    dist: {
      tarball: `${on.url}tarballs/${encodeURIComponent(name)}-${version}.tgz`,
      integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`,
    },
  };
  on.published[`${name}-${version}.tgz`] = tarball;
  on.keywordsOf[name] = (JSON.parse(String(files["package.json"] ?? "{}")) as { keywords?: string[] }).keywords ?? [];
}

before(async () => {
  npm = await startRegistry();
  ENV.AUSTERE_AXI_NPM_REGISTRY = npm.url;
});

after(() => npm?.server.close());

async function builtPackFiles(name: string, version: string): Promise<Record<string, string | Buffer>> {
  const dir = path.join(WORK, `src-${name.replace(/\W/g, "-")}-${version}`);
  await cli("components", "new", dir, "--name", name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
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
  assert.match(r.out, /not on the user's trust list.*Ask the user to review its source .*`austere-axi components add austere-pack-steps --trust` or `austere-axi trust add austere-pack-steps` themselves/);
  assert.doesNotMatch(r.out, /rerun with --trust/i, "the agent is not told to pass --trust itself");
  r = await cli("components", "add", "austere-pack-steps@~1.0.0", "--trust");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pack: austere-pack-steps@1\.0\.0/);
  r = await cli("components", "add", "austere-pack-steps", "--trust");
  assert.match(r.out, /pack: austere-pack-steps@1\.1\.0\nreplaced: "1\.0\.0"/);
  const lock = JSON.parse(fs.readFileSync(path.join(STATE, "packs.json"), "utf8")) as PacksLock;
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
  npm.published["austere-pack-evil-1.0.0.tgz"] = tgz({ "dist/pack.js": "alert(1)", "dist/catalog.json": "{}" });
  r = await cli("components", "add", "austere-pack-evil", "--trust");
  assert.equal(r.code, 1);
  assert.match(r.out, /does not match the registry's integrity hash/);

  // A catalog whose pack.js changed after it was built is refused.
  const files = await builtPackFiles("austere-pack-stale", "1.0.0");
  files["dist/pack.js"] = Buffer.concat([Buffer.from(files["dist/pack.js"]), Buffer.from("\n;")]);
  publish("austere-pack-stale", "1.0.0", files);
  r = await cli("components", "add", "austere-pack-stale", "--trust");
  assert.equal(r.code, 1);
  assert.match(r.out, /changed after its catalog was built/);

  r = await cli("components", "add", "austere-pack-missing", "--trust");
  assert.match(r.out, /no package austere-pack-missing/);
});

test("search and show find packs on npm that are not installed, without installing them", async () => {
  // A fresh machine: nothing installed, no cached pack list.
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-remote-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-orbit", "0.2.0", await builtPackFiles("austere-pack-orbit", "0.2.0"));
    const broken = await builtPackFiles("austere-pack-broken", "1.0.0");
    broken["dist/catalog.json"] = JSON.stringify({ format: 1, pack: "austere-pack-broken" });
    publish("austere-pack-broken", "1.0.0", broken);
    const unlisted = await builtPackFiles("austere-pack-unlisted", "1.0.0");
    unlisted["package.json"] = JSON.stringify({ name: "austere-pack-unlisted", version: "1.0.0" });
    publish("austere-pack-unlisted", "1.0.0", unlisted);

    let r = await cliWith(env, "components", "search", "milestones");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Milestones\(events: string\[\]\) — .*\[\w+; npm austere-pack-orbit@0\.2\.0, not installed, third-party\]/);
    assert.match(r.out, /\[\w+; npm @austere-axi\/pack-steps@0\.1\.0, not installed, first-party\]/);
    assert.doesNotMatch(r.out, /austere-pack-broken|austere-pack-evil|austere-pack-stale|austere-pack-unlisted/, "packs failing the install checks, or without the keyword, are left out");
    assert.match(r.out, /`austere-axi components add @austere-axi\/pack-steps`/);
    assert.match(r.out, /ask the user to review its source .*`austere-axi components add austere-pack-orbit --trust`/);
    assert.doesNotMatch(r.out, /remote:/);

    r = await cliWith(env, "components", "show", "Milestones");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /signature: "?Milestones\(events: string\[\]\)/);
    assert.match(r.out, /from: "?npm \S+@[\d.]+, not installed, (first|third)-party/);
    assert.match(r.out, /example: /);
    assert.match(r.out, /use: .*components add /);
    assert.ok(!fs.existsSync(path.join(state, "packs.json")), "show installs nothing");
    assert.ok(!fs.existsSync(path.join(state, "packs")), "show writes no pack files");

    // Installed wins: the pack shows once, as installed.
    r = await cliWith(env, "components", "add", "austere-pack-orbit", "--trust");
    assert.equal(r.code, 0, r.out);
    r = await cliWith(env, "components", "search", "milestones");
    assert.match(r.out, /\[\w+; pack austere-pack-orbit@0\.2\.0\]/);
    assert.doesNotMatch(r.out, /npm austere-pack-orbit/);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("the user's trust list: a pin trusts one version and pack.js, a scope trusts every pack in it", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-trust-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  const trusted = path.join(state, "trusted.json");
  const sha384 = (b: string | Buffer) => `sha384-${crypto.createHash("sha384").update(b).digest("base64")}`;
  const lockOf = () => (fs.existsSync(path.join(state, "packs.json")) ? (JSON.parse(fs.readFileSync(path.join(state, "packs.json"), "utf8")) as PacksLock).packs : {});
  try {
    // An agent's shell has no terminal: trust add refuses and writes nothing.
    let r = await cliWith(env, "trust", "add", "austere-pack-pinned");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs the user at a terminal/);
    assert.ok(!fs.existsSync(trusted), "trust add without a terminal writes nothing");

    const v1 = await builtPackFiles("austere-pack-pinned", "1.0.0");
    publish("austere-pack-pinned", "1.0.0", v1);
    const tamper = await builtPackFiles("austere-pack-tamper", "1.0.0");
    publish("austere-pack-tamper", "1.0.0", tamper);
    // Published before the first search, which caches the registry's pack list.
    const flows = await builtPackFiles("@acme/pack-flows", "0.3.0");
    const flowsCat = JSON.parse(String(flows["dist/catalog.json"])) as BuiltCatalog;
    flows["dist/catalog.json"] = JSON.stringify({ ...flowsCat, components: flowsCat.components.map((c) => ({ ...c, description: "Acmeflows across the company" })) });
    publish("@acme/pack-flows", "0.3.0", flows);
    publish("@acme/pack-other", "0.1.0", await builtPackFiles("@acme/pack-other", "0.1.0"));
    const registryA = ENV.AUSTERE_AXI_NPM_REGISTRY as string;
    fs.writeFileSync(
      trusted,
      JSON.stringify({
        format: 2,
        pins: {
          "austere-pack-pinned": { version: "1.0.0", integrity: sha384(v1["dist/pack.js"]) },
          "austere-pack-tamper": { version: "1.0.0", integrity: sha384(tamper["dist/pack.js"]) },
        },
        scopes: [{ scope: "@acme", registry: registryA }],
      }),
    );

    r = await cliWith(env, "components", "search", "milestones");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[\w+; npm austere-pack-pinned@1\.0\.0, not installed, trusted\]/);
    assert.match(r.out, /austere-pack-pinned is on the user's trust list .*you may run `austere-axi components add austere-pack-pinned@1\.0\.0`/);

    // Another version of a pinned pack is not trusted; without a version, the pinned one installs.
    publish("austere-pack-pinned", "1.1.0", await builtPackFiles("austere-pack-pinned", "1.1.0"));
    r = await cliWith(env, "components", "add", "austere-pack-pinned@1.1.0");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs --trust[\s\S]*does not match the user's trust list/);
    assert.equal(lockOf()["austere-pack-pinned"], undefined);
    r = await cliWith(env, "components", "add", "austere-pack-pinned");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pack: austere-pack-pinned@1\.0\.0/);
    assert.equal(lockOf()["austere-pack-pinned"].trust, "trust-list");

    // The same version republished with another pack.js is refused.
    const packJs = Buffer.concat([Buffer.from(tamper["dist/pack.js"]), Buffer.from("\n;")]);
    const cat = JSON.parse(String(tamper["dist/catalog.json"])) as BuiltCatalog;
    const changed = { ...tamper, "dist/pack.js": packJs, "dist/catalog.json": JSON.stringify({ ...cat, integrity: sha384(packJs) }) };
    publish("austere-pack-tamper", "1.0.0", changed);
    r = await cliWith(env, "components", "add", "austere-pack-tamper");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs --trust[\s\S]*does not match the user's trust list/);
    assert.equal(lockOf()["austere-pack-tamper"], undefined);

    // A trusted scope covers any pack in it, on the registry it was trusted on only.
    r = await cliWith(env, "components", "search", "acmeflows");
    assert.match(r.out, /npm @acme\/pack-flows@0\.3\.0, not installed, trusted\]/);
    // Registry B: the same packs behind another URL, where anyone could own @acme.
    const mirror = http.createServer((req, res) => npm.server.emit("request", req, res));
    await new Promise<void>((done) => mirror.listen(0, "127.0.0.1", done));
    try {
      const envB = { ...env, AUSTERE_AXI_NPM_REGISTRY: `http://127.0.0.1:${(mirror.address() as AddressInfo).port}/` };
      r = await cliWith(envB, "components", "search", "acmeflows");
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /npm @acme\/pack-flows@0\.3\.0, not installed, third-party\]/);
      r = await cliWith(envB, "components", "add", "@acme/pack-flows");
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /needs --trust[\s\S]*not on the user's trust list/);
      assert.equal(lockOf()["@acme/pack-flows"], undefined);
    } finally {
      mirror.close();
    }
    r = await cliWith(env, "components", "add", "@acme/pack-flows");
    assert.equal(r.code, 0, r.out);
    assert.equal(lockOf()["@acme/pack-flows"].trust, "trust-list");

    r = await cliWith(env, "trust", "list");
    assert.match(r.out, /austere-pack-pinned@1\.0\.0 sha384-/);
    assert.ok(r.out.includes(`@acme on ${registryA}`), r.out);
    r = await cliWith(env, "trust", "remove", "@acme");
    assert.equal(r.code, 0, r.out);
    r = await cliWith(env, "components", "add", "@acme/pack-other");
    assert.match(r.out, /needs --trust/);

    // A malformed list: add and trust refuse, naming the file; search still answers, counting every pack third-party.
    fs.writeFileSync(trusted, JSON.stringify({ format: 2, pins: { "austere-pack-pinned": { version: "1.0.0" } }, scopes: [{ scope: "@acme", registry: registryA }] }));
    const namesFile = new RegExp(`${path.basename(state)}[\\\\/]+trusted\\.json is malformed .*ask the user to fix or delete it`);
    r = await cliWith(env, "components", "add", "austere-pack-pinned");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, namesFile);
    r = await cliWith(env, "trust", "list");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, namesFile);
    r = await cliWith(env, "components", "search", "acme");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /results:[\s\S]*pack @acme\/pack-flows@0\.3\.0\]/);
    assert.match(r.out, /npm @acme\/pack-other@0\.1\.0, not installed, third-party\]/);
    assert.match(r.out, new RegExp(`trust list unreadable: ask the user to fix .*${path.basename(state)}[\\\\/]+trusted\\.json`));

    // A format 1 list never recorded a scope's registry, so it is not read.
    fs.writeFileSync(trusted, JSON.stringify({ format: 1, pins: {}, scopes: ["@acme"] }));
    r = await cliWith(env, "trust", "list");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /format 1 does not record which registry a scope was trusted on/);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

/** `trust add` by the user at a terminal, answering yes; `meanwhile` runs at the prompt, as another process editing the list would. */
function trustAddWhile(env: NodeJS.ProcessEnv, target: string, meanwhile: () => void): Promise<{ code: number | null; out: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string }>();
  const atTerminal = "data:text/javascript,Object.defineProperty(process.stdin,'isTTY',{value:true})";
  const child = spawn(process.execPath, ["--import", atTerminal, "src/cli/main.ts", "trust", "add", target], { env });
  let out = "";
  let answered = false;
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => {
    out += c;
    if (answered || !out.includes("[y/N]")) return;
    answered = true;
    meanwhile();
    child.stdin.end("y\n");
  });
  child.on("close", (code) => resolve({ code, out }));
  return promise;
}

test("trust add keeps changes made to the list while it waited for the user", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-trust-race-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  const trusted = path.join(state, "trusted.json");
  const registryA = ENV.AUSTERE_AXI_NPM_REGISTRY as string;
  const writeList = (list: { pins: Record<string, { version: string; integrity: string }>; scopes: { scope: string; registry: string }[] }) =>
    fs.writeFileSync(trusted, JSON.stringify({ format: 2, ...list }));
  const readList = () => JSON.parse(fs.readFileSync(trusted, "utf8")) as { pins: Record<string, unknown>; scopes: { scope: string }[] };
  try {
    writeList({ pins: {}, scopes: [{ scope: "@old", registry: registryA }] });
    let r = await trustAddWhile(env, "@acme", () => writeList({ pins: {}, scopes: [] }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /status: trusted/);
    assert.deepEqual(readList().scopes.map((s) => s.scope), ["@acme"], "a scope removed at the prompt stays removed");

    publish("austere-pack-raced", "1.0.0", await builtPackFiles("austere-pack-raced", "1.0.0"));
    const otherPin = { version: "1.0.0", integrity: `sha384-${crypto.createHash("sha384").update("other").digest("base64")}` };
    r = await trustAddWhile(env, "austere-pack-raced", () => writeList({ pins: { "austere-pack-other": otherPin }, scopes: [] }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /status: pinned/);
    const list = readList();
    assert.deepEqual(Object.keys(list.pins).sort(), ["austere-pack-other", "austere-pack-raced"], "a pin added at the prompt is kept");
    assert.deepEqual(list.scopes, [], "a scope removed at the prompt stays removed");
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a trusted scope covers versions its pin does not, and search names the version it read", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-trust-version-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  const described = async (version: string) => {
    const files = await builtPackFiles("@acme/pack-versions", version);
    const cat = JSON.parse(String(files["dist/catalog.json"])) as BuiltCatalog;
    files["dist/catalog.json"] = JSON.stringify({ ...cat, components: cat.components.map((c) => ({ ...c, description: "Acmeversions across the company" })) });
    return files;
  };
  try {
    const v1 = await described("1.0.0");
    publish("@acme/pack-versions", "1.0.0", v1);
    publish("@acme/pack-versions", "2.0.0", await described("2.0.0"));
    fs.writeFileSync(
      path.join(state, "trusted.json"),
      JSON.stringify({
        format: 2,
        pins: { "@acme/pack-versions": { version: "1.0.0", integrity: `sha384-${crypto.createHash("sha384").update(v1["dist/pack.js"]).digest("base64")}` } },
        scopes: [{ scope: "@acme", registry: ENV.AUSTERE_AXI_NPM_REGISTRY }],
      }),
    );
    let r = await cliWith(env, "components", "search", "acmeversions");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /npm @acme\/pack-versions@2\.0\.0, not installed, trusted\]/);
    assert.match(r.out, /you may run `austere-axi components add @acme\/pack-versions@2\.0\.0`/);
    r = await cliWith(env, "components", "add", "@acme/pack-versions@2.0.0");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pack: @acme\/pack-versions@2\.0\.0/);
    const lock = JSON.parse(fs.readFileSync(path.join(state, "packs.json"), "utf8")) as PacksLock;
    assert.equal(lock.packs["@acme/pack-versions"].trust, "trust-list");
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("with the registry down, search returns local results and says npm was not searched", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-offline-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_NPM_REGISTRY: `http://127.0.0.1:${await freePort()}/` };
  try {
    let r = await cliWith(env, "components", "search", "bar", "chart");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /BarChart\(/);
    assert.match(r.out, /remote: .*unavailable/);
    r = await cliWith(env, "components", "show", "Gantt");
    assert.equal(r.code, 1);
    assert.match(r.out, /unknown/);
    assert.match(r.out, /remote: .*unavailable/);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a pack installed at an older version than npm's shows once, as installed", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-older-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-comet", "0.1.0", await builtPackFiles("austere-pack-comet", "0.1.0"));
    let r = await cliWith(env, "components", "add", "austere-pack-comet", "--trust");
    assert.equal(r.code, 0, r.out);
    publish("austere-pack-comet", "0.2.0", await builtPackFiles("austere-pack-comet", "0.2.0"));
    r = await cliWith(env, "components", "search", "comet");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[\w+; pack austere-pack-comet@0\.1\.0\]/);
    assert.equal(r.out.match(/austere-pack-comet@/g)?.length, 1, r.out);
  } finally {
    delete npm.keywordsOf["austere-pack-comet"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a pack npm fails to serve is left out and counted, not cached; the other packs are still listed", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-partial-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-nova", "1.0.0", await builtPackFiles("austere-pack-nova", "1.0.0"));
    publish("austere-pack-nova-down", "1.0.0", await builtPackFiles("austere-pack-nova-down", "1.0.0"));
    npm.tarballFailures.set("austere-pack-nova-down-1.0.0.tgz", [500]);
    let r = await cliWith(env, "components", "search", "nova");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /npm austere-pack-nova@1\.0\.0/);
    assert.doesNotMatch(r.out, /austere-pack-nova-down/);
    assert.match(r.out, /remote: 1 npm pack could not be read/);
    assert.doesNotMatch(r.out, /local components only/);

    r = await cliWith(env, "components", "search", "nova");
    assert.match(r.out, /npm austere-pack-nova-down@1\.0\.0/, "a server error is tried again on the next search");
    assert.doesNotMatch(r.out, /remote:/);
  } finally {
    npm.tarballFailures.clear();
    delete npm.keywordsOf["austere-pack-nova"];
    delete npm.keywordsOf["austere-pack-nova-down"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("only a failure that cannot change is cached: a 408 is tried again on the next search, a 404 stays cached", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-lasting-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-tardy", "1.0.0", await builtPackFiles("austere-pack-tardy", "1.0.0"));
    publish("austere-pack-gone", "1.0.0", await builtPackFiles("austere-pack-gone", "1.0.0"));
    npm.tarballFailures.set("austere-pack-tardy-1.0.0.tgz", [408]);
    delete npm.published["austere-pack-gone-1.0.0.tgz"];
    let r = await cliWith(env, "components", "search", "tardy");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /npm austere-pack-tardy/);
    assert.match(r.out, /remote: 1 npm pack could not be read/, "the 408 is counted as unread, the 404 is not");

    r = await cliWith(env, "components", "search", "tardy");
    assert.match(r.out, /npm austere-pack-tardy@1\.0\.0/, "a 408 is tried again on the next search");
    assert.doesNotMatch(r.out, /remote:/);
    assert.equal(npm.tarballRequests.get("austere-pack-gone-1.0.0.tgz"), 1, "a 404 is cached for that version");
  } finally {
    npm.tarballFailures.clear();
    delete npm.keywordsOf["austere-pack-tardy"];
    delete npm.keywordsOf["austere-pack-gone"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("show --pack picks one of several components with the same name, and search names --pack for them", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-twins-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-twin-a", "1.0.0", await builtPackFiles("austere-pack-twin-a", "1.0.0"));
    const b = await builtPackFiles("austere-pack-twin-b", "1.0.0");
    const bCatalog = JSON.parse(String(b["dist/catalog.json"])) as { components: { signature: string }[] };
    bCatalog.components[0].signature = "Milestones(events: string[], twin: string)";
    b["dist/catalog.json"] = JSON.stringify(bCatalog);
    publish("austere-pack-twin-b", "1.0.0", b);
    const table = await builtPackFiles("austere-pack-tablet", "1.0.0");
    const tCatalog = JSON.parse(String(table["dist/catalog.json"])) as { components: { name: string; signature: string }[] };
    tCatalog.components[0].name = "Table";
    tCatalog.components[0].signature = "Table(tablet: string[])";
    table["dist/catalog.json"] = JSON.stringify(tCatalog);
    publish("austere-pack-tablet", "1.0.0", table);

    let r = await cliWith(env, "components", "search", "twin");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /`austere-axi components show Milestones --pack austere-pack-twin-[ab]`/);
    r = await cliWith(env, "components", "show", "Milestones", "--pack", "austere-pack-twin-b");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /signature: "?Milestones\(events: string\[\], twin: string\)/);
    assert.match(r.out, /from: "?npm austere-pack-twin-b@1\.0\.0/);
    r = await cliWith(env, "components", "show", "Milestones", "--pack", "austere-pack-twin-a");
    assert.match(r.out, /from: "?npm austere-pack-twin-a@1\.0\.0/);

    r = await cliWith(env, "components", "search", "tablet");
    assert.match(r.out, /`austere-axi components show Table --pack austere-pack-tablet`/, "a remote name that matches a local component names --pack");
    r = await cliWith(env, "components", "show", "Table");
    assert.match(r.out, /from: core/);
    r = await cliWith(env, "components", "show", "Table", "--pack", "austere-pack-tablet");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /signature: "?Table\(tablet: string\[\]\)/);
    assert.match(r.out, /from: "?npm austere-pack-tablet@1\.0\.0/);
  } finally {
    delete npm.keywordsOf["austere-pack-twin-a"];
    delete npm.keywordsOf["austere-pack-twin-b"];
    delete npm.keywordsOf["austere-pack-tablet"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a pack the registry refuses (401/403) is not cached as broken; the next search lists it", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-refused-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-gated", "1.0.0", await builtPackFiles("austere-pack-gated", "1.0.0"));
    npm.tarballFailures.set("austere-pack-gated-1.0.0.tgz", [403]);
    let r = await cliWith(env, "components", "search", "gated");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /austere-pack-gated@/);
    assert.match(r.out, /remote: 1 npm pack could not be read/);

    r = await cliWith(env, "components", "search", "gated");
    assert.match(r.out, /npm austere-pack-gated@1\.0\.0/, "a refused tarball is tried again once access is fixed");
  } finally {
    npm.tarballFailures.clear();
    delete npm.keywordsOf["austere-pack-gated"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a pack with a malformed catalog is left out of search and refused by add", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-malformed-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    const files = await builtPackFiles("austere-pack-nogroup", "1.0.0");
    const catalog = JSON.parse(String(files["dist/catalog.json"])) as { components: { group?: string }[] };
    delete catalog.components[0].group;
    files["dist/catalog.json"] = JSON.stringify(catalog);
    publish("austere-pack-nogroup", "1.0.0", files);
    let r = await cliWith(env, "components", "search", "nogroup");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /austere-pack-nogroup/);
    assert.doesNotMatch(r.out, /remote:/, "a pack that fails the install checks is not a registry failure");
    r = await cliWith(env, "components", "add", "austere-pack-nogroup", "--trust");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /bad component entry \\?"Milestones\\?" \(needs a name, signature and group\)/);
  } finally {
    delete npm.keywordsOf["austere-pack-nogroup"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a pack that inflates past the unpacked cap is left out of search and refused by add", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-bomb-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    const files = await builtPackFiles("austere-pack-bomb", "1.0.0");
    files["filler.bin"] = Buffer.alloc(40 * 1024 * 1024);
    publish("austere-pack-bomb", "1.0.0", files);
    let r = await cliWith(env, "components", "search", "bomb", "chart");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /BarChart\(/);
    assert.doesNotMatch(r.out, /austere-pack-bomb/);
    r = await cliWith(env, "components", "add", "austere-pack-bomb", "--trust");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /austere-pack-bomb@1\.0\.0 unpacks to more than 32 MB/);
  } finally {
    delete npm.keywordsOf["austere-pack-bomb"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a pack whose component name is not a string is left out of search", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-arrayname-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    const files = await builtPackFiles("austere-pack-arrayname", "1.0.0");
    const catalog = JSON.parse(String(files["dist/catalog.json"])) as { components: { name: unknown }[] };
    catalog.components[0].name = ["Foo"];
    files["dist/catalog.json"] = JSON.stringify(catalog);
    publish("austere-pack-arrayname", "1.0.0", files);
    const r = await cliWith(env, "components", "search", "arrayname", "chart");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /BarChart\(/);
    assert.doesNotMatch(r.out, /austere-pack-arrayname/);
  } finally {
    delete npm.keywordsOf["austere-pack-arrayname"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("an npm pack's oversized signature and group are capped in search and show", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-huge-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    const files = await builtPackFiles("austere-pack-huge", "1.0.0");
    const catalog = JSON.parse(String(files["dist/catalog.json"])) as { components: { name: string; signature: string; group: string }[] };
    catalog.components[0].name = "Hugesig";
    catalog.components[0].signature = `Hugesig(${"field: string, ".repeat(2000)})`;
    catalog.components[0].group = "g".repeat(5000);
    files["dist/catalog.json"] = JSON.stringify(catalog);
    publish("austere-pack-huge", "1.0.0", files);
    let r = await cliWith(env, "components", "search", "hugesig");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Hugesig\(field: string/);
    for (const line of r.out.split("\n")) assert.ok(line.length < 700, `search line of ${line.length} chars`);
    r = await cliWith(env, "components", "show", "Hugesig");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Hugesig\(field: string/);
    for (const line of r.out.split("\n")) assert.ok(line.length < 700, `show line of ${line.length} chars`);
  } finally {
    delete npm.keywordsOf["austere-pack-huge"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("search still answers when the npm cache cannot be written", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-nocache-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-lumen", "1.0.0", await builtPackFiles("austere-pack-lumen", "1.0.0"));
    fs.writeFileSync(path.join(state, "npm-packs"), "not a folder");
    const r = await cliWith(env, "components", "search", "lumen", "chart");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /BarChart\(/);
    assert.match(r.out, /npm austere-pack-lumen@1\.0\.0/);
    assert.doesNotMatch(r.out, /remote:/);
  } finally {
    delete npm.keywordsOf["austere-pack-lumen"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("after one search, npm results come from the cache when the registry goes down", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-cached-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state };
  try {
    publish("austere-pack-halo", "1.0.0", await builtPackFiles("austere-pack-halo", "1.0.0"));
    let r = await cliWith(env, "components", "search", "halo");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /npm austere-pack-halo@1\.0\.0/);

    npm.down = true;
    r = await cliWith(env, "components", "search", "halo");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /npm austere-pack-halo@1\.0\.0/);
    assert.doesNotMatch(r.out, /remote:/);
    r = await cliWith(env, "components", "show", "Milestones");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /from: "?npm \S+@[\d.]+, not installed/);
  } finally {
    npm.down = false;
    delete npm.keywordsOf["austere-pack-halo"];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a scope mapped to a private registry: search, add and trust use it, and its token goes nowhere else", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-packs-scoped-"));
  const token = "s3cret-acme-token";
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, ACME_NPM_TOKEN: token };
  const acme = await startRegistry();
  const host = new URL(acme.url).host;
  const lockOf = () => (JSON.parse(fs.readFileSync(path.join(state, "packs.json"), "utf8")) as { packs: Record<string, { trust: string; resolved: string }> }).packs;
  const run = async (...args: string[]) => {
    const r = await cliWith(env, ...args);
    assert.ok(!r.out.includes(token), `the token is never printed: ${r.out}`);
    return r;
  };
  const described = async (name: string, version: string, description: string) => {
    const files = await builtPackFiles(name, version);
    const cat = JSON.parse(String(files["dist/catalog.json"])) as BuiltCatalog;
    return { ...files, "dist/catalog.json": JSON.stringify({ ...cat, components: cat.components.map((c) => ({ ...c, description })) }) };
  };
  const mapAcme = (url: string, tokenEnv?: string) =>
    fs.writeFileSync(path.join(state, "registries.json"), JSON.stringify({ format: 1, scopes: { "@acme": { url, tokenEnv } } }));
  try {
    // Mapping a scope picks which host gets a token, so an agent (no terminal) cannot make one.
    let r = await run("registry", "add", "@acme", acme.url.slice(0, -1), "--token-env", "ACME_NPM_TOKEN");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /registry add needs the user at a terminal[\s\S]*Ask the user/);
    assert.ok(!fs.existsSync(path.join(state, "registries.json")), "nothing written without a terminal");
    r = await run("registry", "add", "@acme", "http://npm.acme.dev/");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /must be https \(http only on localhost\)/);
    r = await run("registry", "add", "@austere-axi", "https://npm.acme.dev/");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /first-party/);
    r = await run("registry", "add", "@acme", `https://me:${token}@npm.acme.dev/`);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /must not carry credentials/);

    mapAcme(acme.url, "ACME_NPM_TOKEN");
    r = await run("registry", "list");
    assert.ok(r.out.includes(`@acme ${acme.url} (token from $ACME_NPM_TOKEN)`), r.out);

    publish("@acme/pack-rocket", "1.0.0", await described("@acme/pack-rocket", "1.0.0", "Rocketlaunch countdown"), acme);
    publish("@acme/pack-fuel", "1.0.0", await described("@acme/pack-fuel", "1.0.0", "Fuelgauge readout"), acme);
    // A tarball the registry points at another host is fetched without the token.
    publish("@acme/pack-elsewhere", "1.0.0", await described("@acme/pack-elsewhere", "1.0.0", "Rocketlaunch elsewhere"), acme);
    const moved = "@acme/pack-elsewhere-1.0.0.tgz";
    npm.published[moved] = acme.published[moved];
    (acme.published["@acme/pack-elsewhere"] as RegistryMeta).versions["1.0.0"].dist.tarball = `${npm.url}tarballs/${encodeURIComponent(moved)}`;
    // A mapped registry serves only its scope, and the default registry's packs in that scope are someone else's.
    publish("austere-pack-shadow", "1.0.0", await described("austere-pack-shadow", "1.0.0", "Shadowcraft overlay"), acme);
    publish("@acme/pack-rocket", "9.0.0", await described("@acme/pack-rocket", "9.0.0", "Impostorware"));
    publish("austere-pack-skyline", "1.0.0", await described("austere-pack-skyline", "1.0.0", "Skylinechart"));
    npm.requests.length = 0;

    r = await run("components", "search", "rocketlaunch");
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`npm @acme/pack-rocket@1.0.0 (${host}), not installed, third-party]`), r.out);
    assert.ok(r.out.includes(`npm @acme/pack-elsewhere@1.0.0 (${host}), not installed, third-party]`), r.out);
    assert.ok(r.out.includes(`npm view @acme/pack-rocket repository --registry ${acme.url}`), r.out);
    assert.doesNotMatch(r.out, /remote:/);
    r = await run("components", "search", "shadowcraft");
    assert.doesNotMatch(r.out, /austere-pack-shadow/, "a mapped registry cannot list a pack outside its scope");
    r = await run("components", "search", "impostorware");
    assert.doesNotMatch(r.out, /pack-rocket@9/, "the default registry's packs in a mapped scope are left out");
    r = await run("components", "search", "skylinechart");
    assert.match(r.out, /npm austere-pack-skyline@1\.0\.0, not installed, third-party\]/, "the default registry is not named");

    r = await run("components", "add", "@acme/pack-rocket");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs --trust/);
    r = await run("components", "add", "@acme/pack-rocket", "--trust");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pack: "?@acme\/pack-rocket@1\.0\.0/);
    assert.ok(lockOf()["@acme/pack-rocket"].resolved.startsWith(acme.url), "installed from the mapped registry");
    r = await run("components", "add", "@acme/pack-elsewhere", "--trust");
    assert.equal(r.code, 0, r.out);

    assert.ok(acme.requests.some((q) => q.path.startsWith("/-/v1/search")) && acme.requests.some((q) => q.path.startsWith("/tarballs/")), "the mapped registry was searched and served tarballs");
    assert.ok(acme.requests.every((q) => q.authorization === `Bearer ${token}`), "every request to the mapped registry carries its token");
    assert.ok(npm.requests.some((q) => q.path.includes("pack-elsewhere")), "the moved tarball came from the default registry");
    assert.ok(npm.requests.every((q) => q.authorization === undefined), "the default registry never sees the token");

    // A scope trusted while @acme is mapped is bound to the mapped registry (what `trust add @acme` records).
    fs.writeFileSync(path.join(state, "trusted.json"), JSON.stringify({ format: 2, pins: {}, scopes: [{ scope: "@acme", registry: acme.url }] }));
    r = await run("components", "search", "fuelgauge");
    assert.ok(r.out.includes(`npm @acme/pack-fuel@1.0.0 (${host}), not installed, trusted]`), r.out);
    r = await run("components", "add", "@acme/pack-fuel");
    assert.equal(r.code, 0, r.out);
    assert.equal(lockOf()["@acme/pack-fuel"].trust, "trust-list");
    r = await run("registry", "remove", "@acme");
    assert.equal(r.code, 0, r.out);
    r = await run("components", "add", "@acme/pack-fuel");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs --trust[\s\S]*not on the user's trust list/, "unmapped, @acme comes from the default registry, where the scope is not trusted");

    // The mapped registry down: the default one still answers, with a note.
    mapAcme(`http://127.0.0.1:${await freePort()}/`);
    r = await run("components", "search", "skylinechart");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /npm austere-pack-skyline@1\.0\.0/);
    assert.match(r.out, /remote: .*@acme registry unavailable \(/);

    // The mapped registry stalls until the budget runs out: the default registry's packs, not yet cached, are still read.
    fs.rmSync(path.join(state, "npm-packs"), { recursive: true, force: true });
    mapAcme(acme.url);
    acme.searchStalled = true;
    publish("austere-pack-meteor", "1.0.0", await described("austere-pack-meteor", "1.0.0", "Meteorshower"));
    r = await run("components", "search", "meteorshower");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /npm austere-pack-meteor@1\.0\.0/, "a pack not yet cached is read while the other registry stalls");
    assert.match(r.out, /remote: .*@acme registry unavailable \(no answer from .* within 4s\)/);
    acme.searchStalled = false;

    // A malformed registries file: search answers with a note, add and registry refuse, naming the file.
    fs.writeFileSync(path.join(state, "registries.json"), "{ not json");
    const namesFile = new RegExp(`${path.basename(state)}[\\\\/]+registries\\.json is malformed .*ask the user to fix it`);
    r = await run("components", "search", "skylinechart");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /npm austere-pack-skyline@1\.0\.0/);
    assert.match(r.out, new RegExp(`registries unreadable: ask the user to fix .*${path.basename(state)}[\\\\/]+registries\\.json`));
    r = await run("components", "add", "@acme/pack-rocket", "--trust");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, namesFile);
    r = await run("registry", "list");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, namesFile);
  } finally {
    acme.server.close();
    for (const name of ["@acme/pack-rocket", "austere-pack-skyline", "austere-pack-meteor"]) delete npm.keywordsOf[name];
    fs.rmSync(state, { recursive: true, force: true });
  }
});

// ── the review server serves installed packs ──

test("the server serves an installed pack only at its locked version and hash", async () => {
  const port = await freePort();
  const server = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], { env: ENV, stdio: "ignore" });
  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
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
    const lock = (JSON.parse(fs.readFileSync(path.join(STATE, "packs.json"), "utf8")) as PacksLock).packs["austere-pack-steps"];
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
      page('root = Stack([t])\nt = Milestones(["Mon | Freeze"])', `<meta name="austere-packs" content="austere-pack-steps@1.1.0 ${lock.integrity}">\n`),
    );
    const opened = await cli(page3p, "--no-open");
    assert.match(opened.out, /status: open/);
    const sid = /\/s\/([a-f0-9]{12})/.exec(opened.out)?.[1];
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ items: [{ kind: "message", text: "ship it" }] });
      const r = http.request(
        { host: "127.0.0.1", port, method: "POST", path: `/s/${sid}/send`, headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, ...ownerHeaders(STATE) } },
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

test("the bundled shadcn pack lists its components in the built catalog", () => {
  const file = path.join("dist", "packs", "shadcn", "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8")) as BuiltCatalog;
  const names = catalog.components.map((c) => c.name);
  for (const n of ["Progress", "Avatar", "AvatarGroup", "Tooltip", "HoverCard", "Breadcrumb", "BreadcrumbItem", "Kbd", "Skeleton", "Calendar", "Timeline", "TimelineItem"]) {
    assert.ok(names.includes(n), `${n} is in the shadcn catalog`);
  }
});
