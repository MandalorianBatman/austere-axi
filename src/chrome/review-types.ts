// The shapes the review page reads and writes: the boot object, the transcript, the iframe bridge, the server's events.
import type { Mutation } from "../shared/sync.ts";

export type Mode = "annotate" | "explore";

/** The boot object the server hands the page. */
export interface Boot {
  id: string;
  title: string;
  name: string;
  file: string;
  version?: string;
  artifactUrl?: string;
  hosted?: { base?: string; report?: string; publishedAt?: number; signIn?: string } | null;
  viewer?: { role: string; name: string; auto?: boolean };
}

/** A queued note. Items come from the frame (untrusted), localStorage or the server. */
export interface QueueItem {
  kind: string;
  qid?: string;
  target?: string;
  component?: string;
  note?: string;
  text?: string;
  selection?: string;
  excerpt?: string;
  message?: string;
  statement?: string;
  detail?: { part?: unknown; row?: unknown; column?: unknown; [key: string]: unknown };
  form?: Record<string, unknown>;
  path?: unknown;
}

/** A transcript entry: an agent reply or a batch of notes. */
export interface Entry {
  id: string;
  role: string;
  at: number;
  text?: string;
  author?: string;
  items?: QueueItem[];
  held?: boolean;
  end?: boolean;
  seenAt?: number;
  /** The harness of the agent session a wake handed the note to. */
  seenBy?: string;
  workAt?: number;
  doneAt?: number;
  discarded?: boolean;
  /** Hosted: a note still waiting for its ack. */
  pending?: boolean;
}

/** A parser or render error the frame reports. */
export interface RenderIssue {
  statementId?: string;
  message: string;
  severity?: string;
}

/** Messages the frame posts over the review bridge. Frame code is untrusted. */
export type FrameMessage = { austere: 1 } & (
  | { type: "hello" }
  | { type: "ready"; title?: string }
  | { type: "annotate" | "action"; item: unknown }
  | { type: "errors"; errors?: RenderIssue[] }
  | { type: "runtime-error"; error?: RenderIssue }
  | { type: "state"; state: unknown }
  | { type: "scroll"; y?: number }
  | { type: "changes"; ids?: unknown }
  | { type: "toggle-mode" }
  | { type: "quick-switch" }
  | { type: "toggle-sidebar" }
  | { type: "focus"; id?: unknown }
  | { type: "writing"; on?: unknown }
  | { type: "open-url"; url: unknown }
  | { type: "history"; id?: unknown }
);

/** Messages the chrome posts to the frame. */
export type ChromeMessage =
  | { type: "init"; mode: Mode; state: unknown; scrollY: number; quickSwitch: boolean }
  | { type: "reveal"; id: string | undefined }
  | { type: "mode"; mode: Mode }
  | { type: "highlight"; ids: string[]; scroll: boolean }
  | { type: "presence"; marks: { statement: string; name: string; colour: string }[] }
  | { type: "history-counts"; counts: Record<string, number> }
  | { type: "source"; program: string };

export interface SessionInfo {
  archived?: boolean;
  unread?: number;
}

/** A copy of the page in `/archive`'s answer (ArchiveCopy in src/cli/hub.ts). */
export interface ArchiveCopy {
  file: string;
  copy: string;
  unanswered: number;
}

/** `/archive`: this copy's label, the copies archiving takes and the copies that stay open (ArchivePlan in src/cli/hub.ts). */
export interface ArchivePlan {
  copy: string;
  archived: ArchiveCopy[];
  others: ArchiveCopy[];
}

export interface SnapshotEvent {
  transcript?: Entry[];
  presence: string;
  /** While an agent has the notes: when it took them, by the server's clock (`now`). */
  since?: number;
  now: number;
  session: SessionInfo;
  more?: boolean;
  links: { remote?: string } | null;
  version?: string;
  thirdPartyPacks?: string[];
  program: string;
  revision: number;
  wake?: WakeInfo;
}

export interface PresenceEvent extends SessionInfo {
  presence: string;
  since?: number;
  now: number;
  wake?: WakeInfo;
}

/** An agent session a note would wake: now (`idle`), or once its turn ends (`busy`). WakeStatus in src/cli/wake.ts. */
export interface WakeInfo {
  harness: string;
  state: "idle" | "busy";
}

export interface ChangedEvent {
  program: string;
  revision: number;
  shellChanged?: boolean;
  thirdPartyPacks?: string[];
}

/** A run of the attached agent, as the server sums it up (RunSummary in src/cli/dispatch.ts). */
export interface RunSummary {
  id: string;
  status:
    | "queued"
    | "waiting_for_session"
    | "running"
    | "done"
    | "failed"
    | "stopped"
    | "interrupted";
  reason: string | null;
  mode: string | null;
  harness: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
}

/** The owner's `run` event. */
export interface RunEvent {
  run: RunSummary;
  message?: string;
  tail?: string[];
}

/** A run's start or end in the Conversation panel. */
export interface RunMark {
  id: string;
  at: number;
  text: string;
  tone: "start" | "done" | "failed" | "stopped";
}

export type AttachModeId = "same" | "fork" | "new";
export type Capability = { ok: true } | { ok: false; reason: string };

/** A row of attach_settings. */
export interface AttachRow {
  state: "on" | "off" | "inherit";
  mode: AttachModeId | null;
  session: string | null;
  harness: string | null;
  model: string | null;
}

/** GET /s/:id/attach (AttachInfo in src/cli/server.ts). */
export interface AttachInfo {
  effective: {
    state: "on" | "off";
    source: "page" | "project" | "default";
    mode: AttachModeId;
    session: string;
    harness: string;
    model: string | null;
  };
  page: AttachRow | null;
  project: { name: string; setting: AttachRow | null } | null;
  target: { mode: AttachModeId; harness: string; session: string | null };
  author: { id: string; harness: string; short: string } | null;
  sessions: {
    id: string;
    harness: string;
    short: string;
    roles: string[];
    lastSeen: number;
    liveness: string;
  }[];
  harnesses: Record<
    string,
    {
      found: boolean;
      capabilities: Record<AttachModeId | "model", Capability>;
      writeGrant: boolean;
      grantCommand?: string;
      models?: string[];
    }
  >;
  run: RunSummary | null;
  sessionFileSize: number | null;
  warnings: string[];
  auto: string | null;
}

/** What the popover changes: the state, or one field of the page's own row. */
export interface AttachChange {
  state?: AttachRow["state"];
  mode?: AttachModeId;
  session?: string;
  harness?: string;
  model?: string | null;
}

export interface ItemOptions {
  queued?: boolean;
  held?: boolean;
}

export interface OutboxEntry {
  m: Mutation<"addNote">;
  at: number;
  /** Who sent it (`sender()`): a note is only ever re-sent by that same reviewer. */
  as: string;
  /** Epoch ms before which it must not be sent again (a `rate_limited` answer's `retryAfter`). */
  retryAt?: number;
}

/** A revision in `/history`'s answer (revisionLog in src/cli/history.ts). */
export interface HistoryRevision {
  rev: number;
  at: number;
  source: string;
  changed: string[];
  removed: string[];
  created?: number;
  cause: { author: string; target: string | null; text: string }[];
  by?: string;
}
export interface HistoryData {
  head: number;
  viewed: number;
  revisions: HistoryRevision[];
}
/** One earlier text of a statement, in `/history?statement=`'s answer. */
export interface StatementVersion {
  rev: number;
  at: number;
  source: string;
  text: string | null;
  cause: { author: string; target: string | null; text: string }[];
}

/** What POST /share answers (ShareResponse in src/cli/server.ts). */
export interface ShareMade {
  name: string;
  link: string;
  reaches: string;
  auto: boolean;
  expiresAt: number;
}

/** What the Share dialog offers (GET /share): the project the page is in, whether a teammate could reach this machine. */
export interface ShareOffer {
  project: { id: string; name: string } | null;
  remote: boolean;
  auto?: boolean;
}

/** A question the owner is asked in a dialog. */
export type Ask =
  | {
      kind: "archive";
      plan: ArchivePlan;
      done: (every: boolean | null) => void;
      opener: HTMLElement | null;
    }
  | { kind: "share"; offer: ShareOffer; opener: HTMLElement | null };
