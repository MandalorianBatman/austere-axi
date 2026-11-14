// Types for "austere-axi/sync": the hosted-page sync protocol shared by the CLI
// (owner peer), the chrome (reviewer) and austere-cloud (page object). Hand-written;
// src/shared/sync.ts implements exactly this (it checks itself against this file).
// The wire protocol is specified in docs/hosted-share-links.md, "Sync, access and presence".
//
// Change additively only: new optional fields, new mutations, new row types, new
// frame types. Never remove or retype a field, and never add a value to an existing
// union of string literals (add a field instead). Bump SYNC_VERSION with each addition.

/** Protocol version this module speaks. Every frame, mutation and row carries it as `v`. */
export declare const SYNC_VERSION: 1;
/** Oldest `v` still accepted. A frame below it gets `upgrade_required`. */
export declare const MIN_SYNC_VERSION: 1;
/** WebSocket subprotocol both sides must agree on. */
export declare const SUBPROTOCOL: "austere-sync.1";

export declare const LIMITS: {
  /** Largest client frame, in UTF-8 bytes (`too_large`). */
  readonly frameBytes: 65536;
  /** Largest `addNote` items, as UTF-8 bytes of their JSON (`too_large`). */
  readonly noteItemsBytes: 4096;
  /** Longest reviewer or invite name, in characters. */
  readonly nameChars: 40;
};

export type Role = "owner" | "reviewer";
export type ErrorCode = "upgrade_required" | "forbidden" | "rate_limited" | "too_large" | "invalid";
export type PresenceStatus = "viewing" | "away" | "writing";
/** `held`: waits for the owner. `released`: goes to the agent. `discarded`: dropped by the owner. */
export type NoteState = "held" | "released" | "discarded";

export declare const ERROR_CODES: readonly ErrorCode[];

export interface SyncError {
  code: ErrorCode;
  message: string;
  /** Seconds to wait before retrying; set with `rate_limited`. */
  retryAfter?: number;
}

/**
 * A parse result. On failure, `key` is set when the frame was a mutation whose idempotency
 * key could be read: answer it with an `ack` carrying the error, not an `error` frame.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: SyncError; key?: MutationKey };

// ── Note items: what the chrome's composer and annotator produce ─────────────

export interface NoteMessage {
  kind: "message";
  text: string;
}

export interface NoteAnnotation {
  kind: "annotation";
  /** Statement id. */
  target?: string;
  component?: string;
  path?: string[];
  selection?: string;
  excerpt?: string;
  note?: string;
  detail?: { part?: string; row?: string; column?: string; rowIndex?: number };
}

export type NoteItem = NoteMessage | NoteAnnotation;

/** A third-party pack the page loads from `/pk/<sha256>.js`. */
export interface PackRef {
  /** Lowercase hex SHA-256 of the uploaded pack object. */
  sha256: string;
  name: string;
  version: string;
}

// ── Mutations (client → server) ──────────────────────────────────────────────

export interface PublishArgs {
  title: string;
  /** CLI version the page was bundled for; it pins `/rt/<cliVersion>/…`. */
  cliVersion: string;
  /** Lowercase hex SHA-256 of the uploaded page object. */
  html: string;
  packs: PackRef[];
  /** Notes go to the agent without the owner releasing them. */
  auto: boolean;
  /** Anyone with the page URL may review, no invite needed. */
  unlisted: boolean;
  /** Viewers exchange presence frames. */
  presence: boolean;
}

export interface AddNoteArgs {
  items: NoteItem[];
  /** Self-declared name; read only on unlisted pages without an invite. */
  name?: string;
}

export interface NoteRefArgs {
  /** Note row id. */
  note: string;
}

export interface AddReplyArgs {
  text: string;
}

export interface GrantArgs {
  /** Invite name, which is also the reviewer's name. Granting an existing name replaces its token. */
  name: string;
  /** base64url SHA-256 of the invite token (43 characters). The token itself never leaves the owner. */
  tokenHash: string;
  /** Epoch ms, or null for no expiry before the page's own. */
  expiresAt: number | null;
}

export interface RevokeArgs {
  name: string;
}

/** No arguments; send `{}`. */
export type DeleteArgs = Record<string, unknown>;

export interface MutationArgs {
  publish: PublishArgs;
  addNote: AddNoteArgs;
  releaseNote: NoteRefArgs;
  discardNote: NoteRefArgs;
  addReply: AddReplyArgs;
  grant: GrantArgs;
  revoke: RevokeArgs;
  delete: DeleteArgs;
}

export type MutationName = keyof MutationArgs;

export declare const MUTATIONS: readonly MutationName[];
/** Who may send each mutation. Anything else gets `forbidden`. */
export declare const MUTATION_ROLE: Readonly<Record<MutationName, Role>>;

/** The idempotency key: `n` increases by one per mutation a client sends. */
export interface MutationKey {
  /** Random per client install, 8–64 base64url characters. */
  clientId: string;
  n: number;
}

export type Mutation<N extends MutationName = MutationName> = N extends MutationName
  ? { v: number; t: "mutation"; clientId: string; n: number; name: N; args: MutationArgs[N] }
  : never;

/** Builds a mutation frame at SYNC_VERSION. */
export declare function mutation<N extends MutationName>(name: N, args: MutationArgs[N], key: MutationKey): Mutation<N>;

// ── Rows (server → client) ───────────────────────────────────────────────────

export type RowType = "page" | "note" | "reply" | "acl";
export declare const ROW_TYPES: readonly RowType[];

export interface PageRow {
  v: number;
  type: "page";
  /** The page id. */
  id: string;
  seq: number;
  title: string;
  cliVersion: string;
  html: string;
  packs: PackRef[];
  auto: boolean;
  unlisted: boolean;
  presence: boolean;
  publishedAt: number;
  expiresAt: number;
  /** The page was deleted: drop everything cached for it. */
  deleted: boolean;
}

export interface NoteRow {
  v: number;
  type: "note";
  id: string;
  seq: number;
  /** Invite name, or the self-declared name on an unlisted page. */
  author: string;
  items: NoteItem[];
  at: number;
  state: NoteState;
}

export interface ReplyRow {
  v: number;
  type: "reply";
  id: string;
  seq: number;
  text: string;
  at: number;
}

/** One invite. Owner peers only. */
export interface AclRow {
  v: number;
  type: "acl";
  /** The invite name. */
  id: string;
  seq: number;
  name: string;
  grantedAt: number;
  expiresAt: number | null;
  revoked: boolean;
}

export type Row = PageRow | NoteRow | ReplyRow | AclRow;

/** A row of a type this version does not know: kept verbatim, not acted on. */
export interface RawRow {
  v: number;
  type: string;
  id: string;
  seq: number;
  [field: string]: unknown;
}

// ── Frames ───────────────────────────────────────────────────────────────────

/** Asks for every row changed after `after` (0 = everything), then for live changes. */
export interface PullFrame {
  v: number;
  t: "pull";
  after: number;
}

export interface HelloFrame {
  v: number;
  t: "hello";
  status: PresenceStatus;
}

/** Also the heartbeat: send at least every 30 s. */
export interface StatusFrame {
  v: number;
  t: "status";
  status: PresenceStatus;
}

export interface FocusFrame {
  v: number;
  t: "focus";
  /** Statement id the viewer last clicked, or null to clear. */
  statement: string | null;
}

export interface ByeFrame {
  v: number;
  t: "bye";
}

export type ClientPresence = HelloFrame | StatusFrame | FocusFrame | ByeFrame;
export type ClientFrame = Mutation | PullFrame | ClientPresence;

export interface Viewer {
  /** Per connection, server-assigned. */
  id: string;
  name: string;
  /** `#rrggbb`, server-assigned. */
  colour: string;
  role: Role;
}

/** Reply to one mutation. Without `error` it was applied (or had been already). */
export interface AckFrame {
  v: number;
  t: "ack";
  clientId: string;
  n: number;
  error?: SyncError;
}

export interface ChangesFrame {
  v: number;
  t: "changes";
  /** Latest state of each row changed after the pulled cursor, in `seq` order. */
  rows: Row[];
  /** Store this after the rows are applied; pull after it next time. */
  cursor: number;
  /** More rows follow in the next frame. */
  more?: boolean;
  /** The cursor was ahead of the server: drop the cached rows; these rows start from 0. */
  reset?: boolean;
}

/** A connection-level failure. After `upgrade_required` or `forbidden` the server closes the socket. */
export interface ErrorFrame {
  v: number;
  t: "error";
  code: ErrorCode;
  message: string;
  retryAfter?: number;
}

/** A viewer joined, or (on join) one already present. `self` marks the receiver's own entry. */
export interface ViewerHello {
  v: number;
  t: "hello";
  viewer: Viewer;
  status: PresenceStatus;
  focus: string | null;
  self: boolean;
}

export interface ViewerStatus {
  v: number;
  t: "status";
  /** Viewer id. */
  viewer: string;
  status: PresenceStatus;
}

export interface ViewerFocus {
  v: number;
  t: "focus";
  viewer: string;
  statement: string | null;
}

export interface ViewerBye {
  v: number;
  t: "bye";
  viewer: string;
}

export type ServerPresence = ViewerHello | ViewerStatus | ViewerFocus | ViewerBye;
export type ServerFrame = AckFrame | ChangesFrame | ErrorFrame | ServerPresence;

/** A parsed `changes` frame: rows of unknown types are moved to `skipped`. */
export interface ReceivedChanges extends ChangesFrame {
  skipped: RawRow[];
}

export type ReceivedFrame = Exclude<ServerFrame, ChangesFrame> | ReceivedChanges;

/**
 * Validates one frame from a client (the server's side). `data` is the WebSocket text
 * frame, or an already-decoded value. Unknown fields are kept on the result.
 */
export declare function parseClientFrame(data: unknown): Parsed<ClientFrame>;

/**
 * Validates one frame from the server (a client's side). Unknown fields are kept;
 * a frame of an unknown `t` parses to null, to be skipped.
 */
export declare function parseServerFrame(data: unknown): Parsed<ReceivedFrame | null>;

// ── Handshake ────────────────────────────────────────────────────────────────

/** Browsers cannot set WebSocket headers, so credentials ride in Sec-WebSocket-Protocol. */
export interface Credentials {
  /** Owner token (owner peer). */
  owner?: string;
  /** Invite token (reviewer chrome). */
  invite?: string;
}

/** The subprotocol list to open a socket with: SUBPROTOCOL first, then the credentials. */
export declare function syncProtocols(credentials: Credentials): string[];

/** Reads a Sec-WebSocket-Protocol request header. `sync` is false when SUBPROTOCOL is missing. */
export declare function readProtocols(header: string | null | undefined): Credentials & { sync: boolean };
