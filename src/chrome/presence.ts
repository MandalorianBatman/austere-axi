// Presence v1 in the review chrome (docs/hosted-share-links.md, "Presence (Q17)"): roster chips
// in the header, other viewers' last click outlined in the frame, and this viewer's own status
// and focus sent on. Transport-neutral: the hosted chrome feeds it the page socket, the local
// review page the server's relay. Frames arrive already parsed (`parseServerFrame`).
import type { ClientPresence, PresenceStatus, ServerPresence, SYNC_VERSION, Viewer } from "austere-axi/sync";

/** Other viewers' last click, as the frame draws it (`presence` bridge message). */
export interface FocusMark {
  statement: string;
  name: string;
  colour: string;
}

export interface PresenceHost {
  /** The chips go here. */
  chips: HTMLElement;
  /** Draws these marks in the frame, replacing the previous ones. */
  showFocus(marks: FocusMark[]): void;
  /** Scrolls the frame to a statement. */
  reveal(statement: string): void;
  /**
   * The name to join under, from the chrome's name prompt. The server reads it only on an
   * unlisted page without an invite; an invited reviewer's name is the invite name.
   */
  name(): string | undefined;
}

interface Present {
  viewer: Viewer;
  status: PresenceStatus;
  focus: string | null;
}

const V: typeof SYNC_VERSION = 1;
/** `status` doubles as the heartbeat; the server drops a viewer after 60 s of silence. */
const HEARTBEAT_MS = 25_000;
const STATUS_TEXT: Record<PresenceStatus, string> = { viewing: "viewing", away: "away", writing: "writing a note" };

export class Presence {
  private readonly roster = new Map<string, Present>();
  private self: string | null = null;
  private send: ((frame: ClientPresence) => void) | null = null;
  private heartbeat: number | undefined;
  private writing = false;
  private focus: string | null = null;
  private readonly host: PresenceHost;

  constructor(host: PresenceHost) {
    this.host = host;
    document.addEventListener("visibilitychange", () => this.sendStatus());
  }

  private status(): PresenceStatus {
    if (document.visibilityState === "hidden") return "away";
    return this.writing ? "writing" : "viewing";
  }

  /** The socket is open: join as a viewer. */
  connect(send: (frame: ClientPresence) => void): void {
    this.send = send;
    const name = this.host.name();
    send(name ? { v: V, t: "hello", status: this.status(), name } : { v: V, t: "hello", status: this.status() });
    if (this.focus) send({ v: V, t: "focus", statement: this.focus });
    window.clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(() => this.send?.({ v: V, t: "status", status: this.status() }), HEARTBEAT_MS);
  }

  /** The socket closed: its roster goes with it. */
  disconnect(): void {
    this.send = null;
    window.clearInterval(this.heartbeat);
    this.self = null;
    this.roster.clear();
    this.render();
  }

  /** Leaving the page (`pagehide`). */
  leave(): void {
    this.send?.({ v: V, t: "bye" });
  }

  handle(frame: ServerPresence): void {
    if (frame.t === "hello") {
      this.roster.set(frame.viewer.id, { viewer: frame.viewer, status: frame.status, focus: frame.focus });
      if (frame.self) this.self = frame.viewer.id;
    } else if (frame.t === "bye") {
      this.roster.delete(frame.viewer);
      // Our own bye: presence was turned off for the page (`publish --no-presence`).
      if (frame.viewer === this.self) this.self = null;
    } else {
      const p = this.roster.get(frame.viewer);
      if (!p) return;
      if (frame.t === "status") p.status = frame.status;
      else p.focus = frame.statement;
    }
    this.render();
  }

  /** This viewer clicked a statement in the frame. */
  setFocus(statement: string | null): void {
    if (statement === this.focus) return;
    this.focus = statement;
    this.send?.({ v: V, t: "focus", statement });
  }

  /** The composer is open (focused) or closed. */
  setWriting(writing: boolean): void {
    if (writing === this.writing) return;
    this.writing = writing;
    this.sendStatus();
  }

  /** A reloaded frame starts without marks. */
  redraw(): void {
    this.host.showFocus(this.marks());
  }

  private sendStatus(): void {
    this.send?.({ v: V, t: "status", status: this.status() });
  }

  /** Everyone else, in join order. */
  private others(): Present[] {
    return [...this.roster.values()].filter((p) => p.viewer.id !== this.self);
  }

  private marks(): FocusMark[] {
    return this.others().flatMap((p) => (p.focus ? [{ statement: p.focus, name: p.viewer.name, colour: p.viewer.colour }] : []));
  }

  private render(): void {
    const chips = this.others().map((p) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `viewer ${p.status}`;
      chip.style.setProperty("--viewer", p.viewer.colour);
      chip.textContent = [...p.viewer.name][0]?.toUpperCase() ?? "?";
      const label = `${p.viewer.name} · ${STATUS_TEXT[p.status]}${p.focus ? " · click to see where" : ""}`;
      chip.title = label;
      chip.setAttribute("aria-label", label);
      chip.disabled = !p.focus;
      chip.addEventListener("click", () => p.focus && this.host.reveal(p.focus));
      return chip;
    });
    this.host.chips.replaceChildren(...chips);
    this.host.chips.hidden = !chips.length;
    this.redraw();
  }
}
