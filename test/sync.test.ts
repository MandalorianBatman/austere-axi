import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
  MIN_SYNC_VERSION,
  SUBPROTOCOL,
  SYNC_VERSION,
  grantId,
  mutation,
  parseClientFrame,
  parseServerFrame,
  readProtocols,
  syncProtocols,
} from "../src/shared/sync.ts";
import type { MutationArgs, MutationName, Parsed } from "../src/shared/sync.ts";

const key = { clientId: "cli_8f3Kq2", n: 1 };
const sha = "a".repeat(64);
const tokenHash = "b".repeat(43);

const valid: { [N in MutationName]: MutationArgs[N] } = {
  publish: {
    title: "Plan",
    cliVersion: "0.9.0",
    html: sha,
    packs: [{ sha256: sha, name: "@acme/charts", version: "1.2.0" }],
    auto: false,
    unlisted: false,
    presence: true,
  },
  addNote: {
    items: [
      { kind: "annotation", target: "intro", note: "why?", detail: { rowIndex: 2 } },
      { kind: "message", text: "looks good" },
    ],
  },
  releaseNote: { note: "n1" },
  discardNote: { note: "n1" },
  addReply: { text: "Fixed in the next version." },
  grant: { name: "Ana", tokenHash, expiresAt: null },
  revoke: { name: "Ana" },
  delete: {},
};

// One wrong field per mutation, and where the error must point.
const invalid: { [N in MutationName]: [Record<string, unknown>, RegExp] } = {
  publish: [{ ...valid.publish, html: "not-a-sha" }, /^publish\.args\.html:/],
  addNote: [{ items: [{ kind: "annotation", target: 7 }] }, /^addNote\.args\.items\.0\.target:/],
  releaseNote: [{ note: "" }, /^releaseNote\.args\.note:/],
  discardNote: [{}, /^discardNote\.args\.note:/],
  addReply: [{ text: 42 }, /^addReply\.args\.text:/],
  grant: [{ ...valid.grant, name: "x".repeat(LIMITS.nameChars + 1) }, /^grant\.args\.name:/],
  revoke: [{ name: "" }, /^revoke\.args\.name:/],
  delete: [[] as unknown as Record<string, unknown>, /^delete\.args:/],
};

function error<T>(r: Parsed<T>): {
  code: string;
  message: string;
  key?: { clientId: string; n: number };
} {
  if (r.ok) assert.fail(`expected a parse error, got ${JSON.stringify(r.value)}`);
  return { ...r.error, key: r.key };
}

function value<T>(r: Parsed<T>): T {
  if (!r.ok) assert.fail(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

for (const name of Object.keys(valid) as MutationName[]) {
  test(`${name}: a valid mutation round-trips through a text frame`, () => {
    const frame = mutation(name, valid[name], key);
    assert.equal(frame.v, SYNC_VERSION);
    assert.deepEqual(value(parseClientFrame(JSON.stringify(frame))), frame);
  });

  test(`${name}: an invalid argument is rejected with its path and key`, () => {
    const [args, where] = invalid[name];
    const e = error(parseClientFrame({ v: 1, t: "mutation", ...key, name, args }));
    assert.equal(e.code, "invalid");
    assert.match(e.message, where);
    assert.deepEqual(e.key, key, "the server acks it so the sender drops it");
  });
}

test("a mutation needs a well-formed idempotency key; without one there is nothing to ack", () => {
  for (const bad of [
    { clientId: "short", n: 1 },
    { clientId: key.clientId, n: 0 },
    { clientId: key.clientId, n: 1.5 },
    { clientId: key.clientId },
  ]) {
    const e = error(parseClientFrame({ v: 1, t: "mutation", name: "delete", args: {}, ...bad }));
    assert.equal(e.code, "invalid");
    assert.match(e.message, /^mutation\.(clientId|n):/);
    assert.equal(e.key, undefined);
  }
});

test("an unknown mutation or frame type from a client is invalid", () => {
  const unknown = error(
    parseClientFrame({ v: 1, t: "mutation", ...key, name: "rename", args: {} }),
  );
  assert.match(unknown.message, /^mutation\.name:/);
  assert.deepEqual(unknown.key, key);
  assert.match(
    error(parseClientFrame({ v: 1, t: "mutation", ...key, name: "__proto__", args: {} })).message,
    /^mutation\.name:/,
  );
  assert.equal(error(parseClientFrame({ v: 1, t: "toString" })).code, "invalid");
  assert.equal(error(parseClientFrame({ v: 1, t: "subscribe" })).code, "invalid");
});

test("unknown fields are kept on mutations, args, items and frames", () => {
  const sent = {
    v: 1,
    t: "mutation",
    ...key,
    name: "addNote",
    trace: "t1",
    args: { items: [{ kind: "message", text: "hi", lang: "en" }], draft: true },
  };
  assert.deepEqual(value(parseClientFrame(sent)), sent);
  const pull = { v: 1, t: "pull", after: 0, since: "x" };
  assert.deepEqual(value(parseClientFrame(pull)), pull);
});

test("version: below MIN_SYNC_VERSION needs an upgrade, a newer version is read as far as known", () => {
  const old = MIN_SYNC_VERSION - 1;
  assert.equal(
    error(parseClientFrame({ ...mutation("delete", {}, key), v: old })).code,
    "upgrade_required",
  );
  assert.equal(error(parseServerFrame({ v: old, t: "bye", viewer: "x" })).code, "upgrade_required");
  assert.equal(error(parseClientFrame({ v: "1", t: "pull", after: 0 })).code, "invalid");
  assert.equal(error(parseClientFrame({ t: "pull", after: 0 })).code, "invalid");

  const newer = {
    ...mutation("addReply", { text: "ok" }, key),
    v: SYNC_VERSION + 1,
    args: { text: "ok", format: "md" },
  };
  assert.deepEqual(value(parseClientFrame(newer)), newer);
});

test("size limits answer too_large, counted in UTF-8 bytes", () => {
  const frame = (text: string) => ({
    v: 1,
    t: "mutation",
    ...key,
    name: "addReply",
    args: { text },
  });
  const big = JSON.stringify(frame("x".repeat(LIMITS.frameBytes)));
  assert.deepEqual(error(parseClientFrame(big)), {
    code: "too_large",
    message: `frame is ${big.length} bytes; the limit is ${LIMITS.frameBytes}`,
    key: undefined,
  });
  // 40,000 "é" fit in 65,536 UTF-16 units but are 80,000 bytes.
  assert.equal(error(parseClientFrame(JSON.stringify(frame("é".repeat(40000))))).code, "too_large");
  // A decoded frame is measured as its JSON, not let through.
  assert.equal(error(parseClientFrame(frame("x".repeat(LIMITS.frameBytes)))).code, "too_large");

  // Note items: `[{"kind":"message","text":""}]` is 30 bytes, so 4,066 more is exactly the limit.
  const note = (text: string) => mutation("addNote", { items: [{ kind: "message", text }] }, key);
  assert.equal(
    parseClientFrame(JSON.stringify(note("x".repeat(LIMITS.noteItemsBytes - 30)))).ok,
    true,
  );
  const e = error(parseClientFrame(JSON.stringify(note("x".repeat(LIMITS.noteItemsBytes - 29)))));
  assert.equal(e.code, "too_large");
  assert.match(e.message, /4097 bytes; the limit is 4096/);
  assert.deepEqual(e.key, key, "the key was readable, so the server acks the rejection");
  assert.equal(error(parseClientFrame(JSON.stringify(note("é".repeat(2100))))).code, "too_large");
});

test("mutation() refuses a frame the server could not ack", () => {
  assert.throws(
    () => mutation("addReply", { text: "x".repeat(LIMITS.frameBytes) }, key),
    RangeError,
  );
});

test("cliVersion is a bare version, since it becomes a URL path", () => {
  for (const cliVersion of ["0.9.0", "1.0.0-rc.1"])
    assert.equal(
      parseClientFrame(mutation("publish", { ...valid.publish, cliVersion }, key)).ok,
      true,
    );
  for (const cliVersion of ["0.9.0/../../x", '0.9.0"><script>', "0.9", "v0.9.0"]) {
    assert.match(
      error(
        parseClientFrame({
          ...mutation("publish", valid.publish, key),
          args: { ...valid.publish, cliVersion },
        }),
      ).message,
      /^publish\.args\.cliVersion:/,
    );
  }
});

test("a frame that is not a JSON object is invalid", () => {
  for (const data of ["{", "[]", "null", "7", 7, null]) {
    assert.equal(error(parseClientFrame(data)).code, "invalid");
    assert.equal(error(parseServerFrame(data)).code, "invalid");
  }
});

test("presence frames from a client", () => {
  for (const frame of [
    { v: 1, t: "hello", status: "viewing" },
    { v: 1, t: "hello", status: "viewing", name: "Sam" },
    { v: 1, t: "status", status: "writing" },
    { v: 1, t: "focus", statement: "intro" },
    { v: 1, t: "focus", statement: null },
    { v: 1, t: "bye" },
  ]) {
    assert.deepEqual(value(parseClientFrame(frame)), frame);
  }
  assert.match(
    error(parseClientFrame({ v: 1, t: "status", status: "typing" })).message,
    /^status\.status:/,
  );
  assert.match(
    error(parseClientFrame({ v: 1, t: "focus", statement: "not an id" })).message,
    /^focus\.statement:/,
  );
  assert.match(error(parseClientFrame({ v: 1, t: "focus" })).message, /^focus\.statement:/);
});

test("presence frames from the server", () => {
  const hello = {
    v: 1,
    t: "hello",
    viewer: { id: "c1", name: "Ana", colour: "#3b82f6", role: "reviewer" },
    status: "viewing",
    focus: null,
    self: false,
  };
  assert.deepEqual(value(parseServerFrame(hello)), hello);
  assert.deepEqual(
    value(parseServerFrame({ v: 1, t: "focus", viewer: "c1", statement: "intro" })),
    { v: 1, t: "focus", viewer: "c1", statement: "intro" },
  );
  assert.match(
    error(parseServerFrame({ ...hello, viewer: { ...hello.viewer, colour: "blue" } })).message,
    /^hello\.viewer\.colour:/,
  );
  assert.match(error(parseServerFrame({ v: 1, t: "bye" })).message, /^bye\.viewer:/);
});

const rows = {
  page: {
    v: 1,
    type: "page",
    id: "p".repeat(22),
    seq: 1,
    title: "Plan",
    cliVersion: "0.9.0",
    html: sha,
    packs: [],
    auto: false,
    unlisted: false,
    presence: true,
    publishedAt: 1,
    expiresAt: 2,
    deleted: false,
  },
  note: {
    v: 1,
    type: "note",
    id: "n1",
    seq: 2,
    author: "Ana",
    items: [{ kind: "message", text: "hi" }],
    at: 3,
    state: "held",
  },
  reply: { v: 1, type: "reply", id: "r1", seq: 3, text: "ok", at: 4 },
  acl: {
    v: 1,
    type: "acl",
    id: "Ana",
    seq: 4,
    name: "Ana",
    grantedAt: 1,
    expiresAt: null,
    revoked: false,
  },
};

test("changes: every row type parses; unknown rows are skipped but kept; the cursor stands", () => {
  const future = { v: SYNC_VERSION + 1, type: "reaction", id: "x1", seq: 5, emoji: "+1" };
  const inherited = { v: 1, type: "constructor", id: "x2", seq: 6 };
  const withExtra = { ...rows.note, pinned: true };
  const got = value(
    parseServerFrame(
      JSON.stringify({
        v: 1,
        t: "changes",
        rows: [rows.page, withExtra, rows.reply, rows.acl, future, inherited],
        cursor: 6,
        more: false,
      }),
    ),
  );
  assert.ok(got && got.t === "changes");
  assert.deepEqual(got.rows, [rows.page, withExtra, rows.reply, rows.acl]);
  assert.deepEqual(got.skipped, [future, inherited]);
  assert.equal(got.cursor, 6);
});

test("acl rows: `grant` is optional, a 16-character grantId of the token hash, and nothing else", () => {
  const tokenHash = "Abc_-123456789012345678901234567890123456789".slice(0, 43);
  assert.equal(grantId(tokenHash), tokenHash.slice(0, 16));
  const withGrant = { ...rows.acl, grant: grantId(tokenHash) };
  const got = value(
    parseServerFrame({ v: 1, t: "changes", rows: [withGrant, rows.acl], cursor: 4 }),
  );
  assert.ok(got && got.t === "changes");
  assert.deepEqual(got.rows, [withGrant, rows.acl]);
  // The whole hash is not a grant id: a server that sent it would be sending more than it should.
  assert.match(
    error(
      parseServerFrame({
        v: 1,
        t: "changes",
        rows: [{ ...rows.acl, grant: tokenHash }],
        cursor: 4,
      }),
    ).message,
    /^changes\.rows\.0\.grant:/,
  );
});

test("changes: a malformed row fails the frame with the row's path", () => {
  const bad = { ...rows.note, state: "pending" };
  assert.match(
    error(parseServerFrame({ v: 1, t: "changes", rows: [rows.reply, bad], cursor: 2 })).message,
    /^changes\.rows\.1\.state:/,
  );
  assert.match(
    error(
      parseServerFrame({ v: 1, t: "changes", rows: [{ type: "reaction", id: "x" }], cursor: 2 }),
    ).message,
    /^changes\.rows\.0\./,
  );
  assert.equal(
    error(parseServerFrame({ v: 1, t: "changes", rows: [{ ...rows.reply, v: 0 }], cursor: 2 }))
      .code,
    "upgrade_required",
  );
  assert.match(
    error(parseServerFrame({ v: 1, t: "changes", rows: [], cursor: -1 })).message,
    /^changes\.cursor:/,
  );
});

test("server frames: ack, error, and an unknown type parses to null", () => {
  const ack = {
    v: 1,
    t: "ack",
    ...key,
    error: { code: "rate_limited", message: "60 notes per hour", retryAfter: 120 },
  };
  assert.deepEqual(value(parseServerFrame(ack)), ack);
  assert.match(
    error(parseServerFrame({ ...ack, error: { code: "teapot", message: "" } })).message,
    /^ack\.error\.code:/,
  );
  const err = {
    v: 1,
    t: "error",
    code: "upgrade_required",
    message: "austere-axi 0.9.0 or later is required",
  };
  assert.deepEqual(value(parseServerFrame(err)), err);
  assert.equal(value(parseServerFrame({ v: 1, t: "cursor", at: 3 })), null);
  assert.equal(value(parseServerFrame({ v: 1, t: "toString" })), null);
});

test("handshake: credentials ride in Sec-WebSocket-Protocol", () => {
  const owner = "o".repeat(43);
  const invite = "i_-".repeat(10);
  const protocols = syncProtocols({ owner, invite });
  assert.equal(protocols[0], SUBPROTOCOL);
  assert.deepEqual(readProtocols(protocols.join(", ")), { sync: true, owner, invite });
  assert.deepEqual(readProtocols(`austere-owner.${owner}`), { sync: false, owner });
  assert.deepEqual(readProtocols("austere-invite.bad token, austere-invite.a"), { sync: false });
  assert.deepEqual(readProtocols(null), { sync: false });
  assert.throws(() => syncProtocols({ invite: "has space in it......" }), /base64url/);
});

test("the published bundle (austere-axi/sync) imports nothing and parses frames", async () => {
  const code = fs.readFileSync(fileURLToPath(import.meta.resolve("austere-axi/sync")), "utf8");
  // Workers and browsers load it as it is; zod must be inside.
  assert.doesNotMatch(code, /\bimport\s*[{*"'(]|\bimport\s+\w|\brequire\(/);
  // Dynamic on purpose: this loads the built dist/sync.mjs, which only `npm test` (pretest) builds.
  const pub = await import("austere-axi/sync");
  assert.deepEqual(
    value(pub.parseClientFrame(JSON.stringify(mutation("revoke", { name: "Ana" }, key)))),
    mutation("revoke", { name: "Ana" }, key),
  );
  assert.equal(error(pub.parseClientFrame({ v: 0, t: "bye" })).code, "upgrade_required");
});
