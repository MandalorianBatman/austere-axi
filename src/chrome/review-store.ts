// The review page's state in one store (zustand), as the hub's is in hub-store.ts. The panels read the slices they
// draw; the server events, the frame and the hosted socket write them through `set`. Anything that needs a
// cleanup (timers, requests that may arrive late) is an effect in the component that owns it.
import { create } from "zustand";
import type {
  Ask,
  AttachInfo,
  Entry,
  HistoryData,
  Mode,
  OutboxEntry,
  QueueItem,
  RenderIssue,
  RunMark,
  RunSummary,
  WakeInfo,
} from "./review-types.ts";
import { BOOT, HOSTED, LS, SID, SS, VIEWER } from "./review-env.ts";

export interface ReviewState {
  /** The page's title: the shell's, then the frame's or (hosted) the asset-token answer's. */
  title: string;
  /** The third-party packs the page runs: their code could forge notes and errors, so the reviewer is told. */
  packs: string[];
  /** Hosted: whether the page is unlisted (anyone with the plain link may open it); null until the service says. */
  unlisted: boolean | null;
  /** Hosted: "Download standalone HTML" is being built. */
  exporting: boolean;
  /** The ⋯ menu is open. */
  menuOpen: boolean;
  mode: Mode;
  queue: QueueItem[];
  /** The text of the whole-page note box. */
  draft: string;
  /** The qid of the queued note being edited. */
  editing: string | null;
  sending: boolean;
  /** The composer's error line: a refused send, the outbox's rate limit and unsaved-copy notices. */
  composerError: string;
  /** Hosted: the notes still waiting for their ack, for the reviewer this page is now. */
  pending: OutboxEntry[];
  /** Hosted: when a note refused with `rate_limited` is sent again, epoch ms. */
  rateLimit: number | null;
  /** Hosted: the outbox could not be saved, so a reload would lose its notes. */
  outboxUnsaved: boolean;
  /** False until the server's first answer: the Conversation shows a skeleton, not "Nothing sent yet". */
  loaded: boolean;
  transcript: Entry[];
  /** The owner's Conversation entries for agent runs (RLM-346), by `<run id>:start|end`: from the `run` events and `/runs`, never stored. */
  runMarks: Record<string, RunMark>;
  presence: string;
  /** When the agent took the notes it works on, by this browser's clock; null when no agent has them. */
  since: number | null;
  /** An agent session a note would wake; null when none would. */
  wake: WakeInfo | null;
  archived: boolean;
  unread: number;
  more: boolean;
  program: string | null;
  revision: number;
  /** The revision the current render errors belong to, and whether the agent got them. */
  errorsRevision: number;
  renderReport: "sent" | "failed" | null;
  /** The page uses third-party packs: their code could forge errors, so none are sent on their own. */
  thirdParty: boolean;
  frameReady: boolean;
  scrollY: number;
  parserErrors: RenderIssue[];
  runtimeErrors: RenderIssue[];
  changes: string[];
  /** The owner's: statements changed by the revisions since they last looked (RLM-352). */
  sinceChanges: string[];
  highlight: boolean;
  sheetOpen: boolean;
  connected: boolean;
  links: { remote?: string } | null;
  /** The Agent pill's setting (GET /attach); null until the first answer. */
  attachInfo: AttachInfo | null;
  /** The newest run of the attached agent, from the `run` events and the setting. */
  run: RunSummary | null;
  /** The reason that came with the run's last event. */
  runMessage: string;
  /** The failed run's log, once asked for. */
  runLog: string[] | null;
  /** How many `run` events came: an answer that was asked before one holds an older run. */
  runEvents: number;
  /** Moves when something asks for the setting again. */
  attachTick: number;
  /** A change of the setting is on its way to the server. */
  attachBusy: boolean;
  attachError: string;
  /** Which view the panel shows: the notes, or the Agent or History panel that opens over them. */
  panel: "notes" | "agent" | "history";
  /** The History panel: one statement's earlier texts, or (null) every revision. */
  historyFor: string | null;
  /** The owner's history, kept current by useHistoryFeed; null until the first answer. */
  hist: HistoryData | null;
  /** The last ask for the history failed. */
  histError: boolean;
  /** Moves when something asks for a fresh history. */
  historyTick: number;
  /** Revisions the owner has not seen since they last looked, and whether they dismissed the strip about them. */
  sinceCount: number;
  sinceDismissed: boolean;
  /** When the reader last opened the notes, for "new reply" on the dock. */
  seenAt: number;
  /** Moves when the frame sends a note-worthy action: the dock pulses once. */
  dockPulse: number;
  /** The dialog the owner is answering, if any. */
  ask: Ask | null;
  /** Hosted: why nothing more can be sent (the page is gone, or the invite no longer works). */
  lockout: string | null;
  /** Hosted: the invite's name; null on an unlisted page without a valid invite; undefined until the service answers. */
  inviteName: string | null | undefined;
  /** Who the notes are from: the invite's name, a name typed once, or (local) the viewer's. */
  viewerName: string;
  /** Hosted: the reviewer is asked for a name before the first send. */
  askName: boolean;
}

const initial: ReviewState = {
  title: BOOT.title,
  packs: [],
  unlisted: null,
  exporting: false,
  menuOpen: false,
  mode: LS.get<Mode>("austere:mode", "annotate"),
  queue: LS.get<QueueItem[]>(`austere:queue:${SID}`, []),
  draft: "",
  editing: null,
  sending: false,
  composerError: "",
  pending: [],
  rateLimit: null,
  outboxUnsaved: false,
  loaded: false,
  transcript: [],
  runMarks: {},
  presence: "idle",
  since: null,
  wake: null,
  archived: false,
  unread: 0,
  more: false,
  program: null,
  revision: 0,
  errorsRevision: 0,
  renderReport: null,
  thirdParty: false,
  frameReady: false,
  scrollY: 0,
  parserErrors: [],
  runtimeErrors: [],
  changes: [],
  sinceChanges: [],
  highlight: false,
  sheetOpen: SS.get(`austere:sheet:${SID}`) === true,
  connected: false,
  links: null,
  attachInfo: null,
  run: null,
  runMessage: "",
  runLog: null,
  runEvents: 0,
  attachTick: 0,
  attachBusy: false,
  attachError: "",
  panel: "notes",
  historyFor: null,
  hist: null,
  histError: false,
  historyTick: 0,
  sinceCount: 0,
  sinceDismissed: false,
  seenAt: SS.get<number>(`austere:seen:${SID}`) || 0,
  dockPulse: 0,
  ask: null,
  lockout: null,
  inviteName: undefined,
  viewerName: HOSTED ? "" : VIEWER.name,
  askName: false,
};

export const useReview = create<ReviewState>()(() => initial);
/** The current state, for code outside React (the frame bridge, the server events, the outbox). */
export const S = useReview.getState;
export const set = useReview.setState;

export const isNarrow = (): boolean => window.matchMedia("(width <= 860px)").matches;

/** The notes sheet on a narrow screen: open or closed, kept for the tab. */
export function setSheet(open: boolean): void {
  set({ sheetOpen: open });
  SS.set(`austere:sheet:${SID}`, open);
}

/** The queue changed: keep a copy in this browser, so a reload does not lose it. */
export function setQueue(queue: QueueItem[]): void {
  set({ queue });
  LS.set(`austere:queue:${SID}`, queue);
}

/**
 * Explore uses the page alone: the conversation panel (and, on narrow screens, its sheet and dock) steps aside. The class
 * is on <html> before the panels draw, so a panel that comes back already has its layout.
 */
function explore(mode: Mode): void {
  document.documentElement.classList.toggle("exploring", mode === "explore");
}
explore(initial.mode);

/** Annotate (click a part to comment on it) or Explore (use the page normally); kept for the browser. */
export function setMode(mode: string | undefined): void {
  const next: Mode = mode === "explore" ? "explore" : "annotate";
  explore(next);
  set({ mode: next });
  LS.set("austere:mode", next);
}
