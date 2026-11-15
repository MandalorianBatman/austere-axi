// The local server as a sync peer of the owner's hosted pages (docs/hosted-share-links.md,
// "CLI side" and "Sync, access and presence"). For each page in cloud.json it opens the owner
// socket (cloud.ts) while it has a reason to: once at start, for a `feedback` read, while a poll
// listens on the page's session, and while mutations wait in the queue. Offline, it retries
// with backoff up to 60 s; local review goes on as before.
//
// It pulls the rows after its cursor and applies `note` rows to the file's session: a new note
// becomes a held remote note unless its row arrives released (the page object releases at once
// on an --auto page, so the page's current mode decides, not a copy of it in cloud.json),
// and a note released or discarded on another machine is released or discarded here. The
// cursor is saved only after the notes are on disk, so a crash between the two re-delivers,
// and the row id (notes.remote_id) keeps a re-delivered note from being added twice.
//
// Send and Discard on a remote note, and agent replies, go out as mutations from one queue in
// hub.db with its own clientId and n, re-sent after a reconnect until acknowledged.
//
// Presence (Q17): while the owner has the file's review page open, the socket stays open and
// joins as a viewer (role owner, name `Owner`) unless the page was published --no-presence. The
// presence frames it receives go to the local page unchanged (the server's `viewer` SSE event),
// and the local page's status and focus go on to the page object. Nothing of it is stored.
import crypto from "node:crypto";
import WebSocket from "ws";
import { cloudUrl, onRefusal, ownerSocket, readCloud } from "./cloud.ts";
import type { CloudError } from "./cloud.ts";
import { reviewerItem } from "./items.ts";
import { msEnv } from "./paths.ts";
import { newId } from "./sessions.ts";
import type { NoteItem, Session, SessionStore, UserEntry } from "./sessions.ts";
import { SYNC_VERSION, mutation, parseServerFrame } from "../shared/sync.ts";
import type { AckFrame, ClientPresence, MutationArgs, MutationName, NoteRow, PresenceStatus, PullFrame, ReceivedChanges, ServerPresence, ViewerHello } from "../shared/sync.ts";

/** How long a new socket may take to open and finish its pull. */
const PULL_TIMEOUT_MS = 30_000;
const MAX_RETRY_MS = 60_000;
/** How long `reply` waits for the service's ack before it reports the reply as queued. */
const REPLY_WAIT_MS = 5_000;

/** What the server gives the peer. */
export interface PeerHost {
  store: SessionStore;
  log: (...a: unknown[]) => void;
  /** Whether a poll listens on this session. */
  listening: (s: Session) => boolean;
  /** Rows from the service added, released or discarded these notes. */
  changed: (s: Session, entries: UserEntry[]) => void;
  /** Whether the owner has this session's review page open. */
  viewing: (s: Session) => boolean;
  /** A presence frame from the page object, for the owner's review page. */
  relay: (s: Session, frame: ServerPresence) => void;
}

/** One hosted page and its owner socket. */
interface Link {
  page: string;
  /** The session's file (canonical path). */
  file: string;
  ws: WebSocket | null;
  /** The socket's pull is done: rows arrive as they change. */
  live: boolean;
  /** A pull is owed: at start and for `feedback`. */
  pullWanted: boolean;
  /** Called when a pull finishes, or the socket fails before it does. */
  pulls: (() => void)[];
  /** Queue numbers sent on this socket and not acknowledged yet. */
  sent: Set<number>;
  retry: NodeJS.Timeout | null;
  delay: number;
  /** Why the socket last failed. */
  lastError: string;
  /** Why the service will not sync this page (refused, closed with 1008, deleted); null while it does. */
  stopped: string | null;
  /** The page row's `presence`; true until a row says otherwise. */
  presence: boolean;
  /** The socket has sent `hello`: it is a viewer. */
  joined: boolean;
  /** Who is on the page, as their latest `hello` (our own marked `self`), with status and focus kept current. */
  roster: Map<string, ViewerHello>;
}

interface QueueRow {
  n: number;
  page_id: string;
  file: string;
  name: MutationName;
  args: string;
}

/** `<pageId>/<noteId>`: notes.remote_id. Page ids are base64url, so the first `/` splits it. */
export function remoteKey(page: string, note: string): string {
  return `${page}/${note}`;
}

export class Peer {
  host: PeerHost;
  links = new Map<string, Link>();
  /** Answers to queued mutations someone waits for: undefined when applied, else a warning. */
  waiters = new Map<number, (warning: string | undefined) => void>();
  clientId: string;
  firstDelay = msEnv("AUSTERE_AXI_SYNC_RETRY_MS", 1000) || 1000;
  closed = false;
  /** The owner's own status and focus, per file, from the local review page. */
  local = new Map<string, { status: PresenceStatus; focus: string | null }>();

  constructor(host: PeerHost) {
    this.host = host;
    const { store } = host;
    // The cached rows are only as good as the version that read them (Q14): drop and pull again.
    if (this.meta("sync_version") !== String(SYNC_VERSION)) {
      store.tx(() => {
        store.db.exec("DELETE FROM cloud_rows; DELETE FROM cloud_pages;");
        this.setMeta("sync_version", String(SYNC_VERSION));
      });
    }
    let clientId = this.meta("client_id");
    if (!clientId) {
      clientId = crypto.randomBytes(16).toString("base64url");
      this.setMeta("client_id", clientId);
    }
    this.clientId = clientId;
  }

  // ── what the server calls ──

  /** Server start: one pull for every published page, and the queue left from last time. */
  start(): void {
    const state = readCloud();
    if (!state.token) return;
    for (const [file, e] of Object.entries(state.pages)) this.kick(this.link(e.id, file), { pull: true });
    for (const q of this.queued()) this.kick(this.link(q.page_id, q.file));
  }

  /** A poll started listening on `s`, or the owner opened its review page: keep its page's socket open. */
  watch(s: Session): void {
    const link = this.linkFor(s.file);
    if (!link) return;
    this.kick(link);
    // A socket already open for a poll joins now (join opens one otherwise).
    this.join(link);
  }

  /** A poll on `s` ended, or a review page closed: its socket closes once nothing else needs it. */
  unwatch(s: Session): void {
    for (const link of this.links.values()) {
      if (link.file !== s.file) continue;
      if (link.joined && !this.host.viewing(s)) {
        this.sendFrame(link, { v: SYNC_VERSION, t: "bye" });
        // Once it has left, the service sends no more presence: whoever leaves meanwhile would stay in the roster.
        this.forget(link);
      }
      this.settle(link);
    }
  }

  /** The hosted viewers of `s`'s page, as `hello` frames for a review page that just connected. */
  roster(s: Session): ViewerHello[] {
    const link = this.linkFor(s.file);
    return link ? [...link.roster.values()] : [];
  }

  /**
   * The owner's review page sent its own presence. `hello` and `status` carry its status, `focus`
   * its last click; they go on when the socket has joined. `bye` is not passed on: another tab may
   * still be open, and the last page to close leaves the page (unwatch).
   */
  presenceFrom(s: Session, frame: ClientPresence): void {
    const link = this.linkFor(s.file);
    if (!link) return;
    const mine = this.local.get(s.file) ?? { status: "viewing", focus: null };
    if (frame.t === "hello" || frame.t === "status") mine.status = frame.status;
    else if (frame.t === "focus") mine.focus = frame.statement;
    else return;
    this.local.set(s.file, mine);
    if (!link.joined) return this.join(link);
    // A local hello on a joined socket is a status: the service keeps the viewer id either way.
    if (frame.t === "focus") this.sendFrame(link, frame);
    else this.sendFrame(link, { v: SYNC_VERSION, t: "status", status: mine.status });
  }

  /** Catch up before `feedback` reads `file`: wait (at most `ms`) for a pull of its page. */
  async pull(file: string, ms = REPLY_WAIT_MS): Promise<void> {
    const link = this.linkFor(file);
    if (!link || link.stopped) return;
    if (link.live) return; // a listening socket is already up to date
    const { promise, resolve } = Promise.withResolvers<void>();
    link.pulls.push(resolve);
    this.kick(link, { pull: true });
    const timer = setTimeout(resolve, ms);
    await promise;
    clearTimeout(timer);
  }

  /**
   * The owner sent on or discarded these notes locally: tell the page, so other machines follow.
   * Call it in the transaction that changed them, so the change and its mutation commit together.
   */
  settled(entries: UserEntry[], name: "releaseNote" | "discardNote", s: Session): void {
    for (const e of entries) {
      if (!e.remoteId) continue;
      const cut = e.remoteId.indexOf("/");
      const page = e.remoteId.slice(0, cut);
      const link = this.link(page, s.file);
      // A page that is gone takes nothing more: its queue was dropped with it.
      if (link.stopped) continue;
      this.flush(link, this.enqueue(page, s.file, name, { note: e.remoteId.slice(cut + 1) }));
    }
  }

  /**
   * The agent replied on `s`: send `addReply` to the file's hosted page. With `wait`, resolves with
   * a warning when the service has not applied it within REPLY_WAIT_MS (it stays queued) or refused it.
   */
  async reply(s: Session, text: string, { wait = false }: { wait?: boolean } = {}): Promise<string | undefined> {
    const link = this.linkFor(s.file);
    if (!link) return undefined;
    if (link.stopped) return `the hosted page did not get the reply: ${link.stopped}`;
    let q: QueueRow;
    try {
      q = this.enqueue(link.page, s.file, "addReply", { text });
    } catch (err) {
      return `the hosted page did not get the reply: ${(err as Error).message}`;
    }
    if (!wait) {
      this.flush(link, q);
      return undefined;
    }
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    this.waiters.set(q.n, resolve);
    const timer = setTimeout(() => this.answer(q.n, this.queuedWarning(link)), REPLY_WAIT_MS);
    this.flush(link, q);
    const warning = await promise;
    clearTimeout(timer);
    return warning;
  }

  /**
   * A new queued mutation goes out on an open socket, else the socket opens and sends the queue.
   * After the current transaction: a mutation whose change rolled back is not in the queue.
   */
  private flush(link: Link, q: QueueRow): void {
    setImmediate(() => {
      if (!this.queued(link.page).some((x) => x.n === q.n)) return;
      if (link.ws?.readyState === WebSocket.OPEN) this.send(link, q);
      else this.kick(link);
    });
  }

  close(): void {
    this.closed = true;
    for (const link of this.links.values()) {
      clearTimeout(link.retry ?? undefined);
      if (link.ws) this.drop(link, link.ws);
    }
  }

  // ── links and sockets ──

  /** The link for a published file (cloud.json is read again: `publish` may have run since). */
  private linkFor(file: string): Link | null {
    const state = readCloud();
    const e = state.token ? state.pages[file] : undefined;
    return e ? this.link(e.id, file) : null;
  }

  private link(page: string, file: string): Link {
    let link = this.links.get(page);
    if (!link) {
      link = {
        page,
        file,
        ws: null,
        live: false,
        pullWanted: false,
        pulls: [],
        sent: new Set(),
        retry: null,
        delay: this.firstDelay,
        lastError: "",
        stopped: null,
        presence: this.cachedPresence(page),
        joined: false,
        roster: new Map(),
      };
      this.links.set(page, link);
    }
    return link;
  }

  private wanted(link: Link): boolean {
    if (link.stopped || this.closed) return false;
    if (link.pullWanted || link.pulls.length) return true;
    const s = this.host.store.byFile(link.file);
    if (s && this.host.listening(s)) return true;
    if (s && link.presence && this.host.viewing(s)) return true;
    return this.queued(link.page).length > 0;
  }

  /** Connect now if the link is wanted; a pending retry is cut short. */
  private kick(link: Link, { pull = false }: { pull?: boolean } = {}): void {
    if (pull) link.pullWanted = true;
    if (link.ws || !this.wanted(link)) return;
    clearTimeout(link.retry ?? undefined);
    link.retry = null;
    this.connect(link);
  }

  private connect(link: Link): void {
    const state = readCloud();
    if (!state.token) return this.stop(link, "cloud.json holds no owner token");
    const base = state.url || cloudUrl();
    let ws: WebSocket;
    try {
      ws = ownerSocket(base, state.token, link.page);
    } catch (err) {
      return this.stop(link, (err as Error).message);
    }
    link.ws = ws;
    link.live = false;
    link.sent.clear();
    // A socket that opens but never finishes its pull would hold the link forever: drop it and retry.
    setTimeout(() => {
      if (link.ws !== ws || link.live) return;
      link.lastError = `${base} did not answer within ${PULL_TIMEOUT_MS / 1000}s`;
      this.drop(link, ws);
      this.down(link);
    }, PULL_TIMEOUT_MS).unref();
    ws.on("open", () => {
      const pull: PullFrame = { v: SYNC_VERSION, t: "pull", after: this.cursor(link.page) };
      ws.send(JSON.stringify(pull));
      for (const q of this.queued(link.page)) this.send(link, q);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary || link.ws !== ws) return;
      try {
        this.message(link, data.toString());
      } catch (err) {
        // Nothing from the service may stop the server: drop the socket and pull again later.
        this.host.log("sync-failed", link.page, String((err as Error)?.stack || err));
        link.lastError = String((err as Error)?.message || err);
        this.drop(link, ws);
        this.down(link);
      }
    });
    onRefusal(ws, base, (err, retryAfter) => this.refused(link, ws, err, retryAfter));
    ws.on("error", (err) => {
      link.lastError = `could not reach ${base}: ${err.message}`;
    });
    ws.on("close", (code, reason) => this.lost(link, ws, code, reason.toString()));
  }

  private send(link: Link, q: QueueRow): void {
    if (!link.ws || link.ws.readyState !== WebSocket.OPEN) return;
    const frame = mutation(q.name, JSON.parse(q.args) as MutationArgs[MutationName], { clientId: this.clientId, n: q.n });
    link.sent.add(q.n);
    link.ws.send(JSON.stringify(frame));
  }

  /** Stop listening to `ws` and close it. */
  private drop(link: Link, ws: WebSocket): void {
    ws.removeAllListeners();
    ws.on("error", () => {}); // a late error while closing is not ours to report
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    if (link.ws === ws) {
      link.ws = null;
      link.live = false;
      link.sent.clear();
      this.forget(link);
    }
  }

  /** The socket failed or closed: whoever waits on it hears now; reconnect later if still wanted. */
  private down(link: Link, retryMs?: number): void {
    for (const resolve of link.pulls.splice(0)) resolve();
    for (const q of this.queued(link.page)) this.answer(q.n, this.queuedWarning(link));
    if (link.stopped || !this.wanted(link)) return;
    const ms = retryMs ?? link.delay;
    link.delay = Math.min(link.delay * 2, MAX_RETRY_MS);
    link.retry = setTimeout(() => {
      link.retry = null;
      if (this.wanted(link) && !link.ws) this.connect(link);
    }, ms);
    link.retry.unref();
  }

  private refused(link: Link, ws: WebSocket, err: CloudError, retryAfter?: number): void {
    if (link.ws !== ws) return;
    this.drop(link, ws);
    link.lastError = err.message;
    // 429 waits for Retry-After; 403, 404, 410 and 426 are not retried on our own (docs: WebSocket endpoints).
    if (err.status === 429) return this.down(link, (retryAfter ?? 60) * 1000);
    if (err.status === 403 || err.status === 404 || err.status === 410 || err.status === 426) return this.stop(link, err.message, err.status === 404 || err.status === 410);
    this.down(link);
  }

  private lost(link: Link, ws: WebSocket, code: number, reason: string): void {
    if (link.ws !== ws) return;
    link.ws = null;
    link.live = false;
    link.sent.clear();
    this.forget(link);
    // After a 1008 close a client does not reconnect on its own.
    if (code === 1008) return this.stop(link, `the service closed the page's socket: ${reason || "policy violation"}`);
    if (code !== 1000 && code !== 1005) link.lastError ||= `the connection closed (${code}${reason ? `: ${reason}` : ""})`;
    this.down(link);
  }

  /** The service will not sync this page: say why in the log. A page that is `gone` takes its queue with it. */
  private stop(link: Link, why: string, gone = false): void {
    if (link.ws) this.drop(link, link.ws);
    clearTimeout(link.retry ?? undefined);
    link.retry = null;
    link.stopped = why;
    this.host.log("sync-stopped", link.page, why);
    for (const q of this.queued(link.page)) {
      this.answer(q.n, `the hosted page did not get it: ${why}`);
      if (gone) this.host.store.db.prepare("DELETE FROM cloud_queue WHERE n = ?").run(q.n);
    }
    for (const resolve of link.pulls.splice(0)) resolve();
  }

  /** Close the socket once nothing needs it. */
  private settle(link: Link): void {
    if (link.ws && link.live && !link.sent.size && !this.wanted(link)) this.drop(link, link.ws);
  }

  // ── presence ──

  /** Join as a viewer when the owner's review page is open, the socket has pulled, and the page has presence. */
  private join(link: Link): void {
    const s = this.host.store.byFile(link.file);
    if (link.joined || !link.presence || !s || !this.host.viewing(s)) return;
    if (!link.live || link.ws?.readyState !== WebSocket.OPEN) return this.kick(link);
    const mine = this.local.get(link.file) ?? { status: "viewing", focus: null };
    link.joined = true;
    this.sendFrame(link, { v: SYNC_VERSION, t: "hello", status: mine.status });
    if (mine.focus) this.sendFrame(link, { v: SYNC_VERSION, t: "focus", statement: mine.focus });
  }

  private sendFrame(link: Link, frame: ClientPresence): void {
    if (link.ws?.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify(frame));
  }

  /** A presence frame from the page object: kept in the roster, and passed on unchanged. */
  private presenceTo(link: Link, f: ServerPresence): void {
    if (f.t === "hello") link.roster.set(f.viewer.id, f);
    else if (f.t === "bye") {
      const gone = link.roster.get(f.viewer);
      link.roster.delete(f.viewer);
      // Our own bye: the page turned presence off.
      if (gone?.self) link.joined = false;
    } else {
      const p = link.roster.get(f.viewer);
      if (p && f.t === "status") p.status = f.status;
      else if (p && f.t === "focus") p.focus = f.statement;
    }
    const s = this.host.store.byFile(link.file);
    if (s) this.host.relay(s, f);
  }

  /** The socket is gone, or presence is off: the local page drops everyone it showed. */
  private forget(link: Link): void {
    link.joined = false;
    const s = this.host.store.byFile(link.file);
    for (const id of link.roster.keys()) if (s) this.host.relay(s, { v: SYNC_VERSION, t: "bye", viewer: id });
    link.roster.clear();
  }

  /** The cached page row's `presence` (true when there is none yet). */
  private cachedPresence(page: string): boolean {
    const row = this.host.store.db.prepare("SELECT body FROM cloud_rows WHERE page_id = ? AND type = 'page' AND id = ?").get(page, page) as { body: string } | undefined;
    if (!row) return true;
    const parsed = JSON.parse(row.body) as { presence?: unknown };
    return parsed.presence !== false;
  }

  /**
   * Whether the page releases notes at once, as its cached page row has it; `fallback` (cloud.json's
   * copy, from the last publish on this machine) until the first pull has cached one.
   */
  liveAuto(page: string, fallback: boolean): boolean {
    const row = this.host.store.db.prepare("SELECT body FROM cloud_rows WHERE page_id = ? AND type = 'page' AND id = ?").get(page, page) as { body: string } | undefined;
    if (!row) return fallback;
    const parsed = JSON.parse(row.body) as { auto?: unknown };
    return typeof parsed.auto === "boolean" ? parsed.auto : fallback;
  }

  // ── frames ──

  private message(link: Link, text: string): void {
    const parsed = parseServerFrame(text);
    if (!parsed.ok) {
      this.host.log("sync-frame", link.page, parsed.error.code, parsed.error.message);
      if (parsed.error.code === "upgrade_required") this.stop(link, parsed.error.message);
      return;
    }
    const f = parsed.value;
    if (!f) return; // a frame type this version does not know
    if (f.t === "changes") return this.changes(link, f);
    if (f.t === "ack") return this.acked(link, f);
    if (f.t === "error") {
      link.lastError = `${f.code}: ${f.message}`;
      this.host.log("sync-error", link.page, f.code, f.message);
    }
    if (f.t === "hello" || f.t === "status" || f.t === "focus" || f.t === "bye") this.presenceTo(link, f);
  }

  private changes(link: Link, f: ReceivedChanges): void {
    const { store } = this.host;
    const touched: UserEntry[] = [];
    let s: Session | null = null;
    for (const row of f.rows) {
      if (row.type === "note") {
        s ??= store.ensure(link.file);
        touched.push(...this.applyNote(link, s, row));
      }
    }
    // After the notes are on disk: a crash before this line pulls them again, and remote_id keeps them single.
    store.tx(() => {
      if (f.reset) store.db.prepare("DELETE FROM cloud_rows WHERE page_id = ?").run(link.page);
      const put = store.db.prepare(
        "INSERT INTO cloud_rows (page_id, type, id, seq, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (page_id, type, id) DO UPDATE SET seq = excluded.seq, body = excluded.body",
      );
      for (const row of [...f.rows, ...f.skipped]) put.run(link.page, row.type, row.id, row.seq, JSON.stringify(row));
      store.db.prepare("INSERT INTO cloud_pages (page_id, cursor) VALUES (?, ?) ON CONFLICT (page_id) DO UPDATE SET cursor = excluded.cursor").run(link.page, f.cursor);
    });
    link.lastError = "";
    const deleted = f.rows.some((r) => r.type === "page" && r.id === link.page && r.deleted);
    const page = f.rows.find((r) => r.type === "page" && r.id === link.page);
    if (page?.type === "page" && page.presence !== link.presence) {
      link.presence = page.presence;
      // A publish turned presence off: the service has sent `bye` for everyone and sends no more.
      if (!page.presence) this.forget(link);
    }
    if (!link.live && !f.more) {
      link.live = true;
      link.pullWanted = false;
      link.delay = this.firstDelay;
      for (const resolve of link.pulls.splice(0)) resolve();
    }
    if (link.live) this.join(link);
    if (s && touched.length) this.host.changed(s, touched);
    if (deleted) return this.stop(link, "the page was deleted on the service", true);
    this.settle(link);
  }

  /** One note row: added, or the held local copy released or discarded. Returns the notes it changed. */
  private applyNote(link: Link, s: Session, row: NoteRow): UserEntry[] {
    const { store } = this.host;
    const key = remoteKey(link.page, row.id);
    const known = store.byRemote(s, key);
    if (known) {
      // The hold is decided here: only a row that left `held` lets a held note go, and never into a closed review.
      if (!known.held || row.state === "held") return [];
      if (row.state === "released") return s.closedAt ? [] : store.release(s, [known.id]);
      return store.discard(s, [known.id]);
    }
    // Untrusted: rebuilt like a tailnet reviewer's note, with ids of our own.
    const items: NoteItem[] = row.items.map((it) => ({ ...reviewerItem({ ...it }), id: newId("i") }));
    // A closed review takes no notes straight to the agent, as /send refuses a tailnet reviewer's: it holds them for the owner.
    const hold = row.state !== "released" || !!s.closedAt;
    const entry = store.addUserBatch(s, items, { author: row.author || "Reviewer", hold, remote: key, at: Math.min(row.at, Date.now()) });
    if (row.state === "discarded") store.discard(s, [entry.id]);
    return [entry];
  }

  private acked(link: Link, f: AckFrame): void {
    if (f.clientId !== this.clientId || !link.sent.delete(f.n)) return;
    const q = this.queued(link.page).find((x) => x.n === f.n);
    if (f.error?.code === "rate_limited") {
      // Not stored by the service: send the same mutation again after retryAfter.
      const ws = link.ws;
      setTimeout(() => {
        if (q && link.ws === ws && this.queued(link.page).some((x) => x.n === q.n)) this.send(link, q);
      }, (f.error.retryAfter ?? 60) * 1000).unref();
      return;
    }
    this.host.store.db.prepare("DELETE FROM cloud_queue WHERE n = ?").run(f.n);
    if (f.error) {
      this.host.log("sync-rejected", link.page, q?.name ?? f.n, f.error.code, f.error.message);
      this.answer(f.n, `the hosted page refused it: ${f.error.code}: ${f.error.message}`);
    } else this.answer(f.n, undefined);
    this.settle(link);
  }

  private answer(n: number, warning: string | undefined): void {
    const resolve = this.waiters.get(n);
    this.waiters.delete(n);
    resolve?.(warning);
  }

  private queuedWarning(link: Link): string {
    const why = link.lastError || "no answer yet";
    return `the hosted page has not got the reply yet (${why}); it is queued and goes out when the service answers`;
  }

  // ── hub.db: cursor, queue, meta ──

  private meta(key: string): string | undefined {
    const row = this.host.store.db.prepare("SELECT value FROM cloud_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.host.store.db.prepare("INSERT INTO cloud_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private cursor(page: string): number {
    const row = this.host.store.db.prepare("SELECT cursor FROM cloud_pages WHERE page_id = ?").get(page) as { cursor: number } | undefined;
    return Number(row?.cursor ?? 0);
  }

  private queued(page?: string): QueueRow[] {
    const db = this.host.store.db;
    const rows = page === undefined ? db.prepare("SELECT * FROM cloud_queue ORDER BY n").all() : db.prepare("SELECT * FROM cloud_queue WHERE page_id = ? ORDER BY n").all(page);
    return rows as unknown as QueueRow[];
  }

  /** Queue a mutation under the next n. Throws when it could never be sent (over the frame limit). */
  private enqueue<N extends MutationName>(page: string, file: string, name: N, args: MutationArgs[N]): QueueRow {
    const { store } = this.host;
    return store.tx(() => {
      const n = Number(this.meta("next_n") ?? 1);
      mutation(name, args, { clientId: this.clientId, n });
      store.db.prepare("INSERT INTO cloud_queue (n, page_id, file, name, args, at) VALUES (?, ?, ?, ?, ?, ?)").run(n, page, file, name, JSON.stringify(args), Date.now());
      this.setMeta("next_n", String(n + 1));
      return { n, page_id: page, file, name, args: JSON.stringify(args) };
    });
  }
}
