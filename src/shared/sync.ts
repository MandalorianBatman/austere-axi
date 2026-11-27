// The hosted-page sync protocol: frames, mutations, rows and presence messages shared by the
// CLI (owner peer), the chrome (reviewer) and austere-cloud (page object). Published as
// "austere-axi/sync" (dist/sync.mjs, zod bundled in). The types live in types/sync.d.ts, the
// contract; this file implements it and checks itself against it at the bottom. The wire
// protocol is in docs/sync-protocol.md. No Node APIs here:
// the chrome and the Worker run it too.
import { z } from "zod";
import type * as api from "austere-axi/sync";

export type {
  AckFrame,
  AclRow,
  AddNoteArgs,
  AddReplyArgs,
  ByeFrame,
  ChangesFrame,
  ClientFrame,
  ClientPresence,
  Credentials,
  DeleteArgs,
  ErrorCode,
  ErrorFrame,
  FocusFrame,
  GrantArgs,
  HelloFrame,
  Mutation,
  MutationArgs,
  MutationKey,
  MutationName,
  NoteAnnotation,
  NoteItem,
  NoteMessage,
  NoteRefArgs,
  NoteRow,
  NoteState,
  PackRef,
  PageRow,
  Parsed,
  PresenceStatus,
  PublishArgs,
  PullFrame,
  RawRow,
  ReceivedChanges,
  ReceivedFrame,
  ReplyRow,
  RevokeArgs,
  Role,
  Row,
  RowType,
  ServerFrame,
  ServerPresence,
  StatusFrame,
  SyncError,
  Viewer,
  ViewerBye,
  ViewerFocus,
  ViewerHello,
  ViewerStatus,
} from "austere-axi/sync";

export const SYNC_VERSION = 2;
export const MIN_SYNC_VERSION = 1;
export const SUBPROTOCOL = "austere-sync.1";
export const LIMITS = { frameBytes: 65536, noteItemsBytes: 4096, nameChars: 40 } as const;
export const ERROR_CODES = [
  "upgrade_required",
  "forbidden",
  "rate_limited",
  "too_large",
  "invalid",
] as const;
export const MUTATION_ROLE = {
  publish: "owner",
  addNote: "reviewer",
  releaseNote: "owner",
  discardNote: "owner",
  addReply: "owner",
  grant: "owner",
  revoke: "owner",
  delete: "owner",
} as const;
export const MUTATIONS = [
  "publish",
  "addNote",
  "releaseNote",
  "discardNote",
  "addReply",
  "grant",
  "revoke",
  "delete",
] as const;
export const ROW_TYPES = ["page", "note", "reply", "acl"] as const;

const STATEMENT = /^[A-Za-z_$][\w$]{0,99}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_B64URL = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COLOUR = /^#[0-9a-f]{6}$/;
const GRANT_ID = /^[A-Za-z0-9_-]{16}$/;

// Every object is loose: fields this version does not know are kept on the parsed value.
const seq = z.int().positive();
const cursor = z.int().nonnegative();
const ms = z.int().nonnegative();
const name = z.string().min(1).max(LIMITS.nameChars);
const sha256 = z.string().regex(SHA256_HEX);
const statement = z.string().regex(STATEMENT).nullable();
const status = z.enum(["viewing", "away", "writing"]);
const role = z.enum(["owner", "reviewer"]);
const errorBody = {
  code: z.enum(ERROR_CODES),
  message: z.string(),
  retryAfter: z.int().nonnegative().optional(),
};

const noteItem = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("message"),
    text: z.string(),
  }) satisfies z.ZodType<api.NoteMessage>,
  z.looseObject({
    kind: z.literal("annotation"),
    target: z.string().optional(),
    component: z.string().optional(),
    path: z.array(z.string()).optional(),
    selection: z.string().optional(),
    excerpt: z.string().optional(),
    note: z.string().optional(),
    detail: z
      .looseObject({
        part: z.string().optional(),
        row: z.string().optional(),
        column: z.string().optional(),
        rowIndex: z.int().optional(),
      })
      .optional(),
  }) satisfies z.ZodType<api.NoteAnnotation>,
]);

const packRef = z.looseObject({
  sha256,
  name: z.string().min(1),
  version: z.string().min(1),
}) satisfies z.ZodType<api.PackRef>;

const ARGS: { [N in api.MutationName]: z.ZodType<api.MutationArgs[N]> } = {
  publish: z.looseObject({
    title: z.string(),
    cliVersion: z.string().regex(VERSION),
    html: sha256,
    packs: z.array(packRef),
    auto: z.boolean(),
    unlisted: z.boolean(),
    presence: z.boolean(),
    project: z.string().max(200).optional(),
    relPath: z.string().max(1000).optional(),
  }),
  addNote: z.looseObject({ items: z.array(noteItem).min(1), name: z.string().optional() }),
  releaseNote: z.looseObject({ note: z.string().min(1) }),
  discardNote: z.looseObject({ note: z.string().min(1) }),
  addReply: z.looseObject({ text: z.string().min(1) }),
  grant: z.looseObject({
    name,
    tokenHash: z.string().regex(SHA256_B64URL),
    expiresAt: ms.nullable(),
  }),
  revoke: z.looseObject({ name }),
  delete: z.looseObject({}),
};

const mutationKey = z.looseObject({ clientId: z.string().regex(CLIENT_ID), n: seq });
const mutationFrame = mutationKey.extend({
  v: z.int(),
  t: z.literal("mutation"),
  name: z.enum(MUTATIONS),
  args: z.unknown(),
});

const rowBase = { v: z.int(), id: z.string().min(1), seq };
const rawRow = z.looseObject({ ...rowBase, type: z.string() }) satisfies z.ZodType<api.RawRow>;

const ROWS: { [T in api.RowType]: z.ZodType<Extract<api.Row, { type: T }>> } = {
  page: z.looseObject({
    ...rowBase,
    type: z.literal("page"),
    title: z.string(),
    cliVersion: z.string().regex(VERSION),
    html: z.string(),
    packs: z.array(packRef),
    auto: z.boolean(),
    unlisted: z.boolean(),
    presence: z.boolean(),
    publishedAt: ms,
    expiresAt: ms,
    deleted: z.boolean(),
  }),
  note: z.looseObject({
    ...rowBase,
    type: z.literal("note"),
    author: z.string(),
    items: z.array(noteItem),
    at: ms,
    state: z.enum(["held", "released", "discarded"]),
  }),
  reply: z.looseObject({ ...rowBase, type: z.literal("reply"), text: z.string(), at: ms }),
  acl: z.looseObject({
    ...rowBase,
    type: z.literal("acl"),
    name: z.string(),
    grantedAt: ms,
    expiresAt: ms.nullable(),
    revoked: z.boolean(),
    grant: z.string().regex(GRANT_ID).optional(),
  }),
};

const CLIENT_FRAMES: {
  [T in Exclude<api.ClientFrame["t"], "mutation">]: z.ZodType<Extract<api.ClientFrame, { t: T }>>;
} = {
  pull: z.looseObject({ v: z.int(), t: z.literal("pull"), after: cursor }),
  hello: z.looseObject({ v: z.int(), t: z.literal("hello"), status, name: z.string().optional() }),
  status: z.looseObject({ v: z.int(), t: z.literal("status"), status }),
  focus: z.looseObject({ v: z.int(), t: z.literal("focus"), statement }),
  bye: z.looseObject({ v: z.int(), t: z.literal("bye") }),
};

const changesFrame = z.looseObject({
  v: z.int(),
  t: z.literal("changes"),
  rows: z.array(z.unknown()),
  cursor,
  more: z.boolean().optional(),
  reset: z.boolean().optional(),
});

const viewerId = z.string().min(1);
const SERVER_FRAMES: {
  [T in Exclude<api.ServerFrame["t"], "changes">]: z.ZodType<Extract<api.ServerFrame, { t: T }>>;
} = {
  ack: z.looseObject({
    v: z.int(),
    t: z.literal("ack"),
    clientId: z.string(),
    n: seq,
    error: z.looseObject(errorBody).optional(),
  }),
  error: z.looseObject({ v: z.int(), t: z.literal("error"), ...errorBody }),
  hello: z.looseObject({
    v: z.int(),
    t: z.literal("hello"),
    viewer: z.looseObject({
      id: viewerId,
      name: z.string(),
      colour: z.string().regex(COLOUR),
      role,
    }),
    status,
    focus: statement,
    self: z.boolean(),
  }),
  status: z.looseObject({ v: z.int(), t: z.literal("status"), viewer: viewerId, status }),
  focus: z.looseObject({ v: z.int(), t: z.literal("focus"), viewer: viewerId, statement }),
  bye: z.looseObject({ v: z.int(), t: z.literal("bye"), viewer: viewerId }),
};

const ok = <T>(value: T): api.Parsed<T> => ({ ok: true, value });
const fail = (code: api.ErrorCode, message: string): { ok: false; error: api.SyncError } => ({
  ok: false,
  error: { code, message },
});
const has = <K extends string>(o: Record<K, unknown>, key: unknown): key is K =>
  typeof key === "string" && Object.hasOwn(o, key);

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The first issue as `<where>: <message>`, e.g. `args.items.0.kind: Invalid input`. */
function invalid(what: string, error: z.ZodError): { ok: false; error: api.SyncError } {
  const issue = error.issues[0];
  const where = issue && issue.path.length ? `${what}.${issue.path.join(".")}` : what;
  return fail("invalid", `${where}: ${issue ? issue.message : "invalid"}`);
}

/** The UTF-8 size of `text` when it is over `max` bytes. UTF-8 takes one to three bytes per UTF-16 unit. */
function overLimit(text: string, max: number): number | undefined {
  if (text.length * 3 <= max) return undefined;
  const bytes = utf8Bytes(text);
  return bytes > max ? bytes : undefined;
}

/**
 * Decodes a text frame and checks its size and version. A decoded value (an in-process caller,
 * a test) goes through JSON first, so it is judged exactly as it would be on the wire.
 */
function frameOf(data: unknown, maxBytes: number | null): api.Parsed<Record<string, unknown>> {
  let text: string | undefined;
  try {
    text = typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    // A cycle or a BigInt: nothing a socket could have carried.
  }
  if (text === undefined) return fail("invalid", "frame is not JSON");
  const bytes = maxBytes === null ? undefined : overLimit(text, maxBytes);
  if (bytes !== undefined)
    return fail("too_large", `frame is ${bytes} bytes; the limit is ${maxBytes}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("invalid", "frame is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid", "frame is not a JSON object");
  const frame = value as Record<string, unknown>;
  const error = versionError(frame.v, "frame");
  return error ? { ok: false, error } : ok(frame);
}

function versionError(v: unknown, what: string): api.SyncError | undefined {
  if (typeof v !== "number" || !Number.isInteger(v))
    return { code: "invalid", message: `${what}.v: expected an integer protocol version` };
  if (v < MIN_SYNC_VERSION)
    return {
      code: "upgrade_required",
      message: `${what} speaks sync v${v}; v${MIN_SYNC_VERSION} or later is required`,
    };
  return undefined;
}

export function parseClientFrame(data: unknown): api.Parsed<api.ClientFrame> {
  const decoded = frameOf(data, LIMITS.frameBytes);
  if (!decoded.ok) return decoded;
  const frame = decoded.value;
  if (frame.t === "mutation") {
    // A rejected mutation whose key is readable is answered with an ack, so its sender can drop it.
    const keyed = mutationKey.safeParse(frame);
    const reject = (r: { ok: false; error: api.SyncError }) =>
      keyed.success ? { ...r, key: { clientId: keyed.data.clientId, n: keyed.data.n } } : r;
    const head = mutationFrame.safeParse(frame);
    if (!head.success) return reject(invalid("mutation", head.error));
    const args = ARGS[head.data.name].safeParse(head.data.args);
    if (!args.success) return reject(invalid(`${head.data.name}.args`, args.error));
    if (head.data.name === "addNote" && "items" in args.data) {
      const bytes = utf8Bytes(JSON.stringify(args.data.items));
      if (bytes > LIMITS.noteItemsBytes)
        return reject(
          fail("too_large", `note items are ${bytes} bytes; the limit is ${LIMITS.noteItemsBytes}`),
        );
    }
    // The head and args schemas together are exactly Mutation<name>.
    return ok({ ...head.data, args: args.data } as api.Mutation);
  }
  if (!has(CLIENT_FRAMES, frame.t))
    return fail("invalid", `unknown frame type ${JSON.stringify(frame.t)}`);
  const parsed = CLIENT_FRAMES[frame.t].safeParse(frame);
  return parsed.success ? ok(parsed.data) : invalid(frame.t, parsed.error);
}

export function parseServerFrame(data: unknown): api.Parsed<api.ReceivedFrame | null> {
  const decoded = frameOf(data, null);
  if (!decoded.ok) return decoded;
  const frame = decoded.value;
  if (frame.t === "changes") {
    const parsed = changesFrame.safeParse(frame);
    if (!parsed.success) return invalid("changes", parsed.error);
    const rows: api.Row[] = [];
    const skipped: api.RawRow[] = [];
    for (const [i, value] of parsed.data.rows.entries()) {
      const raw = rawRow.safeParse(value);
      if (!raw.success) return invalid(`changes.rows.${i}`, raw.error);
      const error = versionError(raw.data.v, `changes.rows.${i}`);
      if (error) return { ok: false, error };
      if (!has(ROWS, raw.data.type)) {
        skipped.push(raw.data);
        continue;
      }
      const row = ROWS[raw.data.type].safeParse(value);
      if (!row.success) return invalid(`changes.rows.${i}`, row.error);
      rows.push(row.data);
    }
    return ok({ ...parsed.data, rows, skipped });
  }
  if (!has(SERVER_FRAMES, frame.t)) return ok(null);
  const parsed = SERVER_FRAMES[frame.t].safeParse(frame);
  return parsed.success ? ok(parsed.data) : invalid(frame.t, parsed.error);
}

export function mutation<N extends api.MutationName>(
  name: N,
  args: api.MutationArgs[N],
  key: api.MutationKey,
): api.Mutation<N> {
  // Mutation<N> is a distributive conditional, which TypeScript cannot match against a generic N.
  const frame = {
    v: SYNC_VERSION,
    t: "mutation",
    clientId: key.clientId,
    n: key.n,
    name,
    args,
  } as api.Mutation<N>;
  // Too large to parse means no key to ack: queued, it would be re-sent forever.
  const bytes = overLimit(JSON.stringify(frame), LIMITS.frameBytes);
  if (bytes !== undefined)
    throw new RangeError(`${name} is ${bytes} bytes; a frame may be at most ${LIMITS.frameBytes}`);
  return frame;
}

const OWNER_PREFIX = "austere-owner.";
const INVITE_PREFIX = "austere-invite.";

export function syncProtocols(credentials: api.Credentials): string[] {
  const out = [SUBPROTOCOL];
  for (const [prefix, token] of [
    [OWNER_PREFIX, credentials.owner],
    [INVITE_PREFIX, credentials.invite],
  ] as const) {
    if (token === undefined) continue;
    // A subprotocol is an HTTP token: base64url fits, anything else would break the handshake.
    if (!TOKEN.test(token)) throw new Error("sync token must be 16-256 base64url characters");
    out.push(prefix + token);
  }
  return out;
}

export function readProtocols(
  header: string | null | undefined,
): api.Credentials & { sync: boolean } {
  const out: api.Credentials & { sync: boolean } = { sync: false };
  for (const item of (header ?? "").split(",")) {
    const p = item.trim();
    if (p === SUBPROTOCOL) out.sync = true;
    else if (p.startsWith(OWNER_PREFIX) && TOKEN.test(p.slice(OWNER_PREFIX.length)))
      out.owner ??= p.slice(OWNER_PREFIX.length);
    else if (p.startsWith(INVITE_PREFIX) && TOKEN.test(p.slice(INVITE_PREFIX.length)))
      out.invite ??= p.slice(INVITE_PREFIX.length);
  }
  return out;
}

export function grantId(tokenHash: string): string {
  // 96 bits of a hash of a 256-bit random token: names the grant, reveals nothing usable.
  return tokenHash.slice(0, 16);
}

// This file implements every value types/sync.d.ts declares, with the declared types.
({
  SYNC_VERSION,
  MIN_SYNC_VERSION,
  SUBPROTOCOL,
  LIMITS,
  ERROR_CODES,
  MUTATIONS,
  MUTATION_ROLE,
  ROW_TYPES,
  mutation,
  parseClientFrame,
  parseServerFrame,
  syncProtocols,
  readProtocols,
  grantId,
}) satisfies typeof api;
