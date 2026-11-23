// The way to the artifact frame: messages go to its window with `{ austere: 1 }` (the page inside is untrusted, so
// what comes back is checked where it is read). The frame element is set once the page has drawn it.
import type { ChromeMessage } from "./review-types.ts";

let frame: HTMLIFrameElement | null = null;

export function setFrame(el: HTMLIFrameElement | null): void {
  frame = el;
}

export const getFrame = (): HTMLIFrameElement | null => frame;

export function post(msg: ChromeMessage): void {
  frame?.contentWindow?.postMessage({ austere: 1, ...msg }, "*");
}
