// The hosted chrome's one socket to the page object (`/p/:id/sync`, docs/hosted-share-links.md,
// "WebSocket endpoints"). Frames are read with the shared `parseServerFrame`. It reconnects with
// backoff up to 60 s, except after a 1008 close, which the contract says not to retry.
import { parseServerFrame } from "../shared/sync.ts";
import type { ClientFrame, ReceivedFrame } from "austere-axi/sync";

export interface PageSocketHandlers {
  /** Connected; `send` works until `closed`. */
  open(send: (frame: ClientFrame) => void): void;
  frame(frame: ReceivedFrame): void;
  /** Disconnected. `final`: the server closed with 1008 and the socket stays closed. */
  closed(final: boolean): void;
}

const MAX_BACKOFF_MS = 60_000;

export function openPageSocket(url: string, protocols: string[], handlers: PageSocketHandlers): void {
  let backoff = 1_000;
  const connect = () => {
    const ws = new WebSocket(url, protocols);
    ws.addEventListener("open", () => {
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
    ws.addEventListener("close", (e) => {
      const final = e.code === 1008;
      handlers.closed(final);
      if (final) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
  };
  connect();
}
