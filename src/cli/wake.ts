// Push delivery (RLM-447): a live, idle agent session that wrote, edited or listened to a page is
// woken when the owner sends notes on it. A harness client inside the session (the omp/Pi
// extension, `src/harness/omp.ts`) long-polls `POST /api/sessions/<harness>:<id>/wake-poll` while
// its session is idle, gets a claim and a prompt that points at the pages, starts a turn with it,
// and acknowledges with `wake-ack`. The server is the only place that decides who gets a wake:
// one claim per page at a time, so two processes on one session never both deliver.
//
// The client is inert until this server reports a role for its session id (`no_role` otherwise).
// The prompt names files and commands only, never note text (teammates' notes are untrusted).
import crypto from "node:crypto";
import type sqlite from "node:sqlite";
import { liveness } from "./agent-sessions.ts";
import type { Caller, CallerHarness } from "./caller.ts";
import { wakePrompt } from "./agent-prompt.ts";
import type { QueuedEntry, Session, SessionStore } from "./sessions.ts";

/** How long a session's client may hold a claim before it acknowledges; past it the pages are offered again. */
export const WAKE_CLAIM_MS = 60_000;

/** The longest a wake-poll waits; a client asks again after. */
export const WAKE_POLL_MAX_MS = 55_000;

/**
 * How long a session whose client stopped waiting counts as busy (in a turn) when its process
 * cannot be checked. A session whose harness process is known to run stays busy until it exits.
 */
export const WAKE_BUSY_MS = 15 * 60_000;

/**
 * What the review page hears about a woken session (RLM-447): `idle`, a client waits and Send wakes
 * it now; `busy`, its session is in a turn, and the notes go to it when the turn ends.
 */
export interface WakeStatus {
  harness: CallerHarness;
  state: "idle" | "busy";
}

/** One page a wake points at: its file, how many notes wait and the newest one's seq (the reply's cursor). */
export interface WakePage {
  file: string;
  notes: number;
  cursor: number;
}

/**
 * `POST /api/sessions/<harness>:<id>/wake-poll`. `no_role`: the session wrote, edited and listened to
 * no page here, so its client stays inert. `idle`: a check (`timeoutMs` 0) found nothing to deliver.
 * `timeout`: the wait ended with nothing. `interrupted`: the server stopped. `wake`: notes wait;
 * `claim` holds them for this client until it acknowledges, and `prompt` is the turn to start.
 */
export type WakePollResponse =
  | { status: "no_role" | "idle" | "timeout" | "interrupted" }
  | { status: "wake"; claim: string; prompt: string; pages: WakePage[] };

/** `POST /api/sessions/<harness>:<id>/wake-ack`: `delivered` pages; 0 when the claim was released or is gone. */
export interface WakeAckResponse {
  ok: true;
  delivered: number;
}

interface Claim {
  token: string;
  key: string;
  client: string;
  /** Page id → the newest seq the claim covers. */
  pages: Map<string, number>;
  timer: NodeJS.Timeout;
}

interface Waiter {
  key: string;
  client: string;
  pages: Set<string>;
  answer: (body: WakePollResponse) => void;
  timer?: NodeJS.Timeout;
}

/** A session whose client asked for a wake since the server started. */
interface Seen {
  harness: CallerHarness;
  sessionId: string;
  pages: Set<string>;
  /** When its client last waited (or stopped waiting). */
  at: number;
}

export interface WakeOptions {
  db: sqlite.DatabaseSync;
  store: SessionStore;
  /** Whether a poll holds the page: it gets the notes itself. */
  listening: (s: Session) => boolean;
  /** Why the page takes notes no owner sent (Q3, A17), or null. Such a page wakes nobody, as it starts no run. */
  autoConflict: (s: Session) => string | null;
  /** A woken session of `harness` got these notes: mark them delivered, tell the page, cancel a queued run. */
  delivered: (s: Session, entries: QueuedEntry[], harness: CallerHarness) => void;
  /** What `status` says about these pages may have changed: tell their open pages. */
  changed: (pageIds: Iterable<string>) => void;
  log: (...a: unknown[]) => void;
}

/** `<harness>:<id>`: the key of a session, as the route names it. */
export function sessionKey(caller: Pick<Caller, "harness" | "sessionId">): string {
  return `${caller.harness}:${caller.sessionId}`;
}

/** A client id: one per extension instance, so a second process on one session is told apart. */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function parseClientId(v: unknown): string | null {
  return typeof v === "string" && CLIENT_ID.test(v) ? v : null;
}

export class Wake {
  private o: WakeOptions;
  private waiters = new Set<Waiter>();
  /** Page id → the claim that holds it. */
  private claimed = new Map<string, Claim>();
  private claims = new Map<string, Claim>();
  /** Session key → the session, while its client keeps asking. */
  private seen = new Map<string, Seen>();

  constructor(o: WakeOptions) {
    this.o = o;
  }

  /**
   * Who would take a note on the page: a session whose client waits now (`idle`), else one in a
   * turn (`busy`: its client stopped waiting and its process still runs). Null when no session's
   * client knows the page, or the page wakes nobody (archived, `--auto`).
   */
  status(s: Session): WakeStatus | null {
    if (s.archivedAt || this.o.autoConflict(s)) return null;
    let busy: WakeStatus | null = null;
    for (const seen of this.seen.values()) {
      if (!seen.pages.has(s.id)) continue;
      const key = sessionKey(seen);
      const waiting = [...this.waiters].some((w) => w.key === key && w.pages.has(s.id));
      if (waiting || this.claimed.get(s.id)?.key === key)
        return { harness: seen.harness, state: "idle" };
      if (!busy && this.inTurn(seen)) busy = { harness: seen.harness, state: "busy" };
    }
    return busy;
  }

  /** A session not waiting is in a turn while its process runs, or for WAKE_BUSY_MS when that cannot be told. */
  private inTurn(seen: Seen): boolean {
    const row = this.o.db
      .prepare("SELECT pid, pid_start FROM agent_sessions WHERE harness = ? AND session_id = ?")
      .get(seen.harness, seen.sessionId) as
      | { pid: number | null; pid_start: string | null }
      | undefined;
    const live = row ? liveness(row) : "unknown";
    return live === "alive" || (live === "unknown" && Date.now() - seen.at < WAKE_BUSY_MS);
  }

  /** The pages this session has a role on (author, editor, listener). */
  roles(caller: Pick<Caller, "harness" | "sessionId">): string[] {
    const rows = this.o.db
      .prepare(
        `SELECT DISTINCT p.artifact_id AS id FROM page_sessions p
         JOIN agent_sessions a ON a.id = p.agent_session_id
         WHERE a.harness = ? AND a.session_id = ?`,
      )
      .all(caller.harness, caller.sessionId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** The notes on `s` a wake would deliver now: the owner's (sent or released), none a poll took, none a claim holds. */
  private pending(s: Session, client: string): QueuedEntry[] {
    if (s.archivedAt || this.o.listening(s) || this.o.autoConflict(s)) return [];
    const held = this.claimed.get(s.id);
    if (held && held.client !== client) return [];
    // An attached run on the page is answering them; the session hears its reply on the page.
    if (
      this.o.db
        .prepare("SELECT 1 FROM runs WHERE artifact_id = ? AND status = 'running' LIMIT 1")
        .get(s.id)
    )
      return [];
    return this.o.store.after(s, s.deliveredSeq).filter((e) => (e.items || []).length > 0);
  }

  /** Claim what waits on `pages` for this client, or null when nothing does. */
  private take(key: string, client: string, pages: Iterable<string>): WakePollResponse | null {
    const found: { s: Session; entries: QueuedEntry[] }[] = [];
    for (const id of pages) {
      const s = this.o.store.get(id);
      const entries = s ? this.pending(s, client) : [];
      if (s && entries.length) found.push({ s, entries });
    }
    if (!found.length) return null;
    // A client asking again did not deliver what it held: its older claims go.
    for (const c of [...this.claims.values()]) if (c.client === client) this.drop(c);
    const token = crypto.randomBytes(16).toString("base64url");
    const claim: Claim = {
      token,
      key,
      client,
      pages: new Map(),
      timer: setTimeout(() => {
        this.drop(claim);
        this.o.log("wake-claim-expired", key);
        this.offer(claim.pages.keys());
      }, WAKE_CLAIM_MS),
    };
    claim.timer.unref?.();
    const listed: WakePage[] = [];
    for (const { s, entries } of found) {
      const cursor = entries[entries.length - 1].seq;
      claim.pages.set(s.id, cursor);
      this.claimed.set(s.id, claim);
      listed.push({ file: s.file, notes: entries.length, cursor });
    }
    this.claims.set(token, claim);
    return { status: "wake", claim: token, prompt: wakePrompt(listed), pages: listed };
  }

  private drop(claim: Claim): void {
    clearTimeout(claim.timer);
    this.claims.delete(claim.token);
    for (const id of claim.pages.keys())
      if (this.claimed.get(id) === claim) this.claimed.delete(id);
    this.o.changed(claim.pages.keys());
  }

  /**
   * A session's client asks for a wake. Answers at once with `no_role`, with a claim when notes
   * wait, or with `idle` when `timeoutMs` is 0; else waits up to `timeoutMs` for notes on its pages.
   * `onClose` registers what to do when the client goes away first.
   */
  poll(
    caller: Pick<Caller, "harness" | "sessionId">,
    client: string,
    timeoutMs: number,
    answer: (body: WakePollResponse) => void,
    onClose: (fn: () => void) => void,
  ): void {
    const pages = this.roles(caller);
    if (!pages.length) return answer({ status: "no_role" });
    const key = sessionKey(caller);
    this.seen.set(key, {
      harness: caller.harness,
      sessionId: caller.sessionId,
      pages: new Set(pages),
      at: Date.now(),
    });
    const now = this.take(key, client, pages);
    if (now) return answer(now);
    if (!(timeoutMs > 0)) return answer({ status: "idle" });
    // One wait per client: a newer one from the same process replaces it (its socket is gone or about to be).
    for (const w of this.waiters) if (w.client === client) this.finish(w, { status: "timeout" });
    const waiter: Waiter = { key, client, pages: new Set(pages), answer };
    waiter.timer = setTimeout(
      () => this.finish(waiter, { status: "timeout" }),
      Math.min(timeoutMs, WAKE_POLL_MAX_MS),
    );
    this.waiters.add(waiter);
    this.o.changed(pages);
    onClose(() => {
      clearTimeout(waiter.timer);
      if (!this.waiters.delete(waiter)) return;
      // A turn started, or the process went: the page reads busy, or nothing once the process is gone.
      const seen = this.seen.get(key);
      if (seen) seen.at = Date.now();
      this.o.changed(pages);
      setTimeout(() => this.o.changed(pages), 2000).unref();
    });
  }

  private finish(w: Waiter, body: WakePollResponse): void {
    if (!this.waiters.delete(w)) return;
    clearTimeout(w.timer);
    w.answer(body);
  }

  /** New notes (or a page freed: a claim dropped, a poll gone): a waiting client on these pages gets them. */
  offer(pages: Iterable<string>): void {
    const ids = new Set(pages);
    for (const w of [...this.waiters]) {
      if (![...ids].some((id) => w.pages.has(id))) continue;
      const body = this.take(w.key, w.client, w.pages);
      if (body) this.finish(w, body);
    }
  }

  /**
   * The client acknowledges its claim: `delivered` (the turn started) marks the claimed notes
   * delivered; `released` (the session got busy first) offers them again. A claim of another
   * session, or one that expired, changes nothing.
   */
  ack(
    caller: Pick<Caller, "harness" | "sessionId">,
    token: string,
    outcome: "delivered" | "released",
  ): WakeAckResponse {
    const claim = this.claims.get(token);
    if (!claim || claim.key !== sessionKey(caller)) return { ok: true, delivered: 0 };
    this.drop(claim);
    if (outcome === "released") {
      this.offer(claim.pages.keys());
      return { ok: true, delivered: 0 };
    }
    let delivered = 0;
    // Set before any claim is made (poll), so it names the claim's session.
    const harness = this.seen.get(claim.key)?.harness ?? "omp";
    for (const [id, cursor] of claim.pages) {
      const s = this.o.store.get(id);
      if (!s) continue;
      const entries = this.o.store
        .after(s, s.deliveredSeq)
        .filter((e) => e.seq <= cursor && (e.items || []).length > 0);
      if (!entries.length) continue;
      this.o.delivered(s, entries, harness);
      delivered++;
    }
    this.o.log("wake-delivered", claim.key, delivered);
    return { ok: true, delivered };
  }

  /** The server stops: every waiting client hears it. */
  close(): void {
    for (const w of [...this.waiters]) this.finish(w, { status: "interrupted" });
    for (const c of [...this.claims.values()]) this.drop(c);
  }
}
