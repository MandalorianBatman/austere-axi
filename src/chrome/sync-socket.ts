// The reviewer's socket to a hosted page (docs/hosted-share-links.md, "WebSocket endpoints" and
// "Errors"): opens it with the given subprotocols, parses every frame with the shared module, and
// reconnects with backoff. What the frames mean is up to the listeners: the chrome's row feed and
// note queue, and presence, which adds its own onOpen/onFrame listeners to the same socket.
import "./zod-jitless.ts";
import { parseServerFrame } from "../shared/sync.ts";
import type { ClientFrame, ErrorFrame, ReceivedFrame } from "../shared/sync.ts";

export interface SyncClose {
  code: number;
  /** The handshake had succeeded. A refused handshake (403, 404, 410, 426) closes without opening. */
  opened: boolean;
  /** The last `error` frame before the close, if any. */
  error: ErrorFrame | null;
}

export interface SyncSocketOptions {
  url: string;
  /** Read on every (re)connect: `syncProtocols(...)`. */
  protocols: () => string[];
  /** Asked before reconnecting after a close that is not final; false stops. */
  mayRetry?: (close: SyncClose) => boolean | Promise<boolean>;
}

export interface SyncSocket {
  readonly connected: boolean;
  /** Sends one frame; false when the socket is not open (the caller keeps what it must re-send). */
  send(frame: ClientFrame): boolean;
  /** After every successful handshake, in the order added. */
  onOpen(fn: () => void): void;
  /** Every frame of a known type; unknown frame types are skipped. */
  onFrame(fn: (frame: ReceivedFrame) => void): void;
  /** After every close; `retrying` says whether a reconnect is scheduled. */
  onClose(fn: (close: SyncClose, retrying: boolean) => void): void;
  /** Closes the socket for good. */
  stop(): void;
}

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function openSyncSocket(options: SyncSocketOptions): SyncSocket {
  const openListeners: (() => void)[] = [];
  const frameListeners: ((frame: ReceivedFrame) => void)[] = [];
  const closeListeners: ((close: SyncClose, retrying: boolean) => void)[] = [];
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = FIRST_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    timer = undefined;
    if (stopped) return;
    let opened = false;
    let error: ErrorFrame | null = null;
    const socket = new WebSocket(options.url, options.protocols());
    ws = socket;
    socket.addEventListener("open", () => {
      opened = true;
      for (const fn of openListeners) fn();
    });
    socket.addEventListener("message", (e) => {
      const parsed = parseServerFrame(e.data);
      if (!parsed.ok) {
        console.warn(`austere: skipped a sync frame: ${parsed.error.message}`);
        return;
      }
      if (!parsed.value) return;
      // A frame arrived: the connection works, so the next drop starts the backoff over.
      delay = FIRST_DELAY_MS;
      if (parsed.value.t === "error") error = parsed.value;
      for (const fn of frameListeners) fn(parsed.value);
    });
    socket.addEventListener("close", async (e) => {
      if (ws === socket) ws = null;
      const close: SyncClose = { code: e.code, opened, error };
      // Close 1000 (the page was deleted) and 1008 (after `error` `forbidden` or `upgrade_required`)
      // are final: the server would refuse the same credential again.
      const final =
        e.code === 1000 ||
        e.code === 1008 ||
        error?.code === "forbidden" ||
        error?.code === "upgrade_required";
      let retrying = !stopped && !final;
      if (retrying && options.mayRetry) retrying = (await options.mayRetry(close)) && !stopped;
      if (retrying) {
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, MAX_DELAY_MS);
      }
      for (const fn of closeListeners) fn(close, retrying);
    });
  }

  connect();
  return {
    get connected() {
      return ws?.readyState === WebSocket.OPEN;
    },
    send(frame) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    onOpen: (fn) => void openListeners.push(fn),
    onFrame: (fn) => void frameListeners.push(fn),
    onClose: (fn) => void closeListeners.push(fn),
    stop() {
      stopped = true;
      clearTimeout(timer);
      ws?.close(1000);
      ws = null;
    },
  };
}
