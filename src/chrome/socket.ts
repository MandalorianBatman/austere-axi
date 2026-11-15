// The hosted chrome's one socket to the page object (`/p/:id/sync`, docs/hosted-share-links.md,
// "WebSocket endpoints"). Frames are read with the shared `parseServerFrame`. It reconnects with
// backoff up to 60 s. It stops after a 1008 close, and when a handshake fails because the page is
// gone (404 or 410): the contract says neither is retried.
import { parseServerFrame } from "../shared/sync.ts";
import type { ClientFrame, ReceivedFrame } from "austere-axi/sync";

export interface PageSocketHandlers {
  /** Connected; `send` works until `closed`. */
  open(send: (frame: ClientFrame) => void): void;
  frame(frame: ReceivedFrame): void;
  /** Disconnected. `final`: the socket stays closed (1008, or the page is gone). */
  closed(final: boolean): void;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Browsers hide a refused handshake's HTTP status, so a socket that closes before it opened asks
 * the page shell, which answers 404 or 410 exactly when the page is gone.
 */
async function pageGone(pageUrl: string): Promise<boolean> {
  try {
    // A stalled check must not hold up the next attempt: past 5 s it counts as offline.
    const r = await fetch(pageUrl, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(5_000) });
    return r.status === 404 || r.status === 410;
  } catch {
    return false; // offline: retry
  }
}

/** `pageUrl` is the page shell (`/p/:id`). */
export function openPageSocket(url: string, protocols: string[], pageUrl: string, handlers: PageSocketHandlers): void {
  let backoff = 1_000;
  const connect = () => {
    const ws = new WebSocket(url, protocols);
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      backoff = 1_000;
      handlers.open((frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      });
    });
    ws.addEventListener("message", (e) => {
      const parsed = parseServerFrame(e.data);
      // A frame this version cannot read is skipped, as is one of an unknown type (null).
      if (parsed.ok && parsed.value) handlers.frame(parsed.value);
    });
    ws.addEventListener("close", async (e) => {
      const final = e.code === 1008 || (!opened && (await pageGone(pageUrl)));
      handlers.closed(final);
      if (final) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
  };
  connect();
}
