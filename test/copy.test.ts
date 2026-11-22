// Reuse by copy (RLM-354) and the `similar:` line of a first open (RLM-353): patch --from takes
// statements with everything they reference from another page; open names pages that read alike.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sessionId } from "../src/cli/sessions.ts";
import { freePort } from "./port.ts";

interface CliResult {
  code: number | null;
  out: string;
}

const PORT = await freePort();
const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-copy-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-copy-work-")));
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: STATE,
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  AUSTERE_AXI_PERSIST: "1",
  OPENUI_TELEMETRY_DISABLED: "1",
};
for (const name of [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "COPILOT_AGENT_SESSION_ID",
  "DSH_SESSION_ID",
  "AUSTERE_AXI_RUN_ID",
])
  delete ENV[name];

function cli(args: string[], input = ""): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve("src/cli/main.ts"), ...args], {
      env: ENV,
      cwd: WORK,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const html = (
  program: string,
  title: string,
) => `<!doctype html><html><head><title>${title}</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>
`;
const write = (name: string, program: string, title = name): string => {
  const file = path.join(WORK, `${name}.html`);
  fs.writeFileSync(file, html(program, title));
  return file;
};
const origins = (file: string) => {
  const db = new DatabaseSync(path.join(STATE, "hub.db"), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT name, src_artifact_id, src_name, src_rev FROM statement_origins WHERE artifact_id = ? ORDER BY name",
      )
      .all(sessionId(file)) as unknown as {
      name: string;
      src_artifact_id: string;
      src_name: string;
      src_rev: number;
    }[];
  } finally {
    db.close();
  }
};

const SOURCE = `root = Stack([flow])
flow = Architecture([client, api], [call])
client = Node("Client", "external")
api = Node("API", "backend", "Node")
call = Edge(client, api, "HTTPS")
unrelated = TextContent("not this")`;

before(() => {
  fs.mkdirSync(path.join(WORK, ".git"), { recursive: true });
});

after(async () => {
  await cli(["stop"]);
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("patch --from copies a statement with what it references; a name that clashes is renamed and its references follow", async () => {
  const src = write("copy-src", SOURCE);
  const dest = write(
    "copy-dest",
    `root = Stack([intro, client])\nintro = TextContent("intro")\nclient = TextContent("my own client")`,
  );
  assert.equal((await cli([src])).code, 0);

  const r = await cli(
    ["patch", dest, "--from", `${src}#flow`],
    "root = Stack([intro, client, flow])",
  );
  assert.equal(r.code, 0, r.out);
  assert.match(
    r.out,
    /copied: \[flow, client2, api, call\]/,
    "the one asked for first, then what it brought",
  );
  assert.match(r.out, /renamed: \{"client":"client2"\}/);
  const text = fs.readFileSync(dest, "utf8");
  assert.match(
    text,
    /client = TextContent\("my own client"\)/,
    "the page's own statement is untouched",
  );
  assert.match(text, /client2 = Node\("Client", "external"\)/);
  assert.match(
    text,
    /flow = Architecture\(\[client2, api\], \[call\]\)/,
    "the diagram's references follow the new name",
  );
  assert.match(text, /call = Edge\(client2, api, "HTTPS"\)/);
  assert.doesNotMatch(text, /unrelated/);
  assert.equal((await cli(["check", dest])).code, 0, "check passes");

  // Where each came from.
  assert.deepEqual(
    origins(dest).map((o) => [o.name, o.src_artifact_id, o.src_name, o.src_rev]),
    [
      ["api", sessionId(src), "api", 1],
      ["call", sessionId(src), "call", 1],
      ["client2", sessionId(src), "client", 1],
      ["flow", sessionId(src), "flow", 1],
    ],
  );
  const outline = await cli(["outline", dest]);
  assert.match(
    outline.out,
    /flow Architecture \(3\): nodes: Client, API Client → API \(HTTPS\) ← copy-src\.html#flow/,
    "a copied part is marked",
  );
  const log = (await cli(["history", dest])).out;
  assert.match(
    log,
    /copied:\n[\s\S]*- [^\n]*client2 from [^\n]*copy-src\.html#client \(revision 1\)/,
  );
  assert.match(
    log,
    /rev: 2\n[\s\S]*source: patch[\s\S]*rev: 1\n[\s\S]*source: open/,
    "the page as it was before the first patch is revision 1, though it was never opened",
  );

  // A copied statement nothing references is dropped and said so, with no origin kept.
  const dropped = await cli(
    ["patch", dest, "--from", `${src}#unrelated`],
    'intro = TextContent("still intro")',
  );
  assert.equal(dropped.code, 0, dropped.out);
  assert.match(dropped.out, /dropped: \[unrelated\]/);
  assert.equal(
    origins(dest).some((o) => o.name === "unrelated"),
    false,
  );
});

test("a source edited by hand and never recorded is recorded before it is copied: the origin names a revision that holds what was copied", async () => {
  const src = write("hand-src", SOURCE);
  const dest = write("hand-dest", `root = Stack([intro])\nintro = TextContent("intro")`);
  assert.equal((await cli([src])).code, 0);
  assert.equal((await cli(["stop"])).code, 0);
  fs.writeFileSync(
    src,
    html(
      SOURCE.replace('"API"', '"API by hand"').replace('"backend", "Node"', '"backend", "Node 99"'),
      "hand-src",
    ),
  );
  const r = await cli(["patch", dest, "--from", `${src}#api`], "root = Stack([intro, api])");
  assert.equal(r.code, 0, r.out);
  const o = origins(dest).find((x) => x.name === "api");
  assert.equal(o?.src_rev, 2, "a revision of its own, not revision 1");
  const shown = await cli(["show", src, "api", "--rev", String(o?.src_rev)]);
  assert.match(shown.out, /API by hand/);
});

test("--rev copies an older version; an unknown statement lists the names the source has", async () => {
  const src = write("rev-src", SOURCE);
  const dest = write("rev-dest", `root = Stack([intro])\nintro = TextContent("intro")`);
  assert.equal((await cli([src])).code, 0);
  assert.equal((await cli(["patch", src], 'api = Node("API v2", "backend", "Node 24")')).code, 0);

  const now = await cli(["patch", dest, "--from", `${src}#api`], "root = Stack([intro, api])");
  assert.equal(now.code, 0, now.out);
  assert.match(fs.readFileSync(dest, "utf8"), /api = Node\("API v2"/);
  assert.equal(origins(dest)[0].src_rev, 2);

  // An older revision, into a page that has no `api`.
  const older = write("rev-dest-old", `root = Stack([intro])\nintro = TextContent("intro")`);
  assert.equal(
    (
      await cli(
        ["patch", older, "--from", `${src}#api`, "--rev", "1"],
        "root = Stack([intro, api])",
      )
    ).code,
    0,
  );
  assert.match(
    fs.readFileSync(older, "utf8"),
    /api = Node\("API", "backend", "Node"\)/,
    "the text of revision 1, not the current one",
  );
  assert.equal(origins(older)[0].src_rev, 1);

  // A name the page has: the copy is `api2`, so the stdin that wants it names it.
  assert.equal(
    (
      await cli(
        ["patch", dest, "--from", `${src}#api`, "--rev", "1"],
        "root = Stack([intro, api, api2])",
      )
    ).code,
    0,
  );
  assert.match(
    fs.readFileSync(dest, "utf8"),
    /api = Node\("API v2"[^\n]*\n[\s\S]*api2 = Node\("API", "backend", "Node"\)/,
  );

  const unknown = await cli(["patch", dest, "--from", `${src}#nope`], "root = Stack([intro])");
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /has no statement nope; it has: root, flow, client, api, call/);
  const noRev = await cli(
    ["patch", dest, "--from", `${src}#api`, "--rev", "9"],
    "root = Stack([intro])",
  );
  assert.match(noRev.out, /has no revision 9/);
  const lone = await cli(["patch", dest, "--rev", "1"], "root = Stack([intro])");
  assert.equal(lone.code, 2);
  const bad = await cli(["patch", dest, "--from", `${src}`], "root = Stack([intro])");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /--from takes <file>#<statement>/);
});

test("the first open of a page lists pages of its project that read alike; a re-open and an unrelated page do not", async () => {
  write(
    "alike-a",
    `root = Stack([head])\nhead = Card([CardHeader("Session storage migration")])`,
    "Session storage migration",
  );
  assert.equal((await cli([path.join(WORK, "alike-a.html")])).code, 0);
  write(
    "alike-b",
    `root = Stack([head])\nhead = Card([CardHeader("Billing export")])`,
    "Billing export",
  );
  const unrelated = await cli([path.join(WORK, "alike-b.html")]);
  assert.doesNotMatch(unrelated.out, /similar:/);

  const second = write(
    "alike-c",
    `root = Stack([head])\nhead = Card([CardHeader("Moving sessions: migration notes")])`,
    "Session migration, take two",
  );
  const first = await cli([second]);
  assert.match(
    first.out,
    /similar:\n\s+- title: Session storage migration\n\s+file: [^\n]*alike-a\.html[^\n]*\n\s+age: \d+[smhd]/,
  );
  assert.doesNotMatch(first.out, /alike-b/);
  assert.match(first.out, /similar_note: [^\n]*find <words>/);
  assert.doesNotMatch((await cli([second])).out, /similar:/, "not on a re-open");
});
