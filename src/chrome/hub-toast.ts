// What the hub says after a change: a toast (Sonner), with an optional button (Undo, Copy link).
import { toast } from "sonner";

export interface SayOptions {
  action?: { label: string; onClick: () => unknown };
  /** How long it stays, in ms; a link the owner has to copy needs longer than the default. A toast with a button stays 10 s: the keyboard reaches it only with Alt+T. */
  duration?: number;
}

/** One toast at a time, as the status line was: a newer message takes the older one's place. */
const STATUS = "hub-status";

/** Which message is on screen now; `say` and `fail` return the number of the one they drew. */
let latest = 0;

const asToast = ({ action, duration }: SayOptions) => ({
  id: STATUS,
  duration: duration ?? (action ? 10_000 : undefined),
  // The toast stays until `onClick` has answered: a failed Undo replaces it, a good one clears it.
  action: action && {
    label: action.label,
    onClick: (e: { preventDefault(): void }) => {
      e.preventDefault();
      void action.onClick();
    },
  },
});

/** Show `text`; returns its number for `clearSay`. */
export function say(text: string, options: SayOptions = {}): number {
  if (!text) {
    toast.dismiss(STATUS);
    return ++latest;
  }
  toast(text, asToast(options));
  return ++latest;
}

/** A change the server refused, or could not be asked for. */
export function fail(text: string, options: SayOptions = {}): number {
  toast.error(text, asToast(options));
  return ++latest;
}

/** Clear the toast only while it is still one of `numbers`: a newer message (another page's Undo) stays. */
export function clearSay(numbers: readonly number[]): void {
  if (numbers.includes(latest)) say("");
}
