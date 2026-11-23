// The review page's state in one store (zustand), as the hub's is in hub-store.ts. The panels read the slices they
// draw; the server events, the frame and the hosted socket write them through `set`. Anything that needs a
// cleanup (timers, requests that may arrive late) is an effect in the component that owns it.
import { create } from "zustand";
import type { Entry, Mode, OutboxEntry, QueueItem, RenderIssue, WakeInfo } from "./review-types.ts";
import { LS, SID, SS, HOSTED, VIEWER } from "./review-env.ts";

export interface ReviewState {
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
  transcript: Entry[];
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
  /** Whether an agent is attached to this page (the Agent pill's setting), for the presence label. */
  attachOn: boolean;
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
  mode: LS.get<Mode>("austere:mode", "annotate"),
  queue: LS.get<QueueItem[]>(`austere:queue:${SID}`, []),
  draft: "",
  editing: null,
  sending: false,
  composerError: "",
  pending: [],
  rateLimit: null,
  outboxUnsaved: false,
  transcript: [],
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
  attachOn: false,
  lockout: null,
  inviteName: undefined,
  viewerName: HOSTED ? "" : VIEWER.name,
  askName: false,
};

export const useReview = create<ReviewState>()(() => initial);
/** The current state, for code outside React (the frame bridge, the server events, the outbox). */
export const S = useReview.getState;
export const set = useReview.setState;

export const isNarrow = (): boolean => window.matchMedia("(max-width: 860px)").matches;

/** The notes sheet on a narrow screen: open or closed, kept for the tab. */
export function setSheet(open: boolean): void {
  set({ sheetOpen: open });
  SS.set(`austere:sheet:${SID}`, open);
  document.documentElement.classList.toggle("sheet-open", open);
}

/** The queue changed: keep a copy in this browser, so a reload does not lose it. */
export function setQueue(queue: QueueItem[]): void {
  set({ queue });
  LS.set(`austere:queue:${SID}`, queue);
}
