// What the hub says after a change: a toast (Sonner), with an optional button (Undo, Copy link).
import { toast } from "sonner";

export interface SayOptions {
  action?: { label: string; onClick: () => unknown };
  /** How long it stays, in ms; a link the owner has to copy needs longer than the default. */
  duration?: number;
}

export function say(text: string, { action, duration }: SayOptions = {}): void {
  if (!text) toast.dismiss();
  else
    toast(text, {
      // The toast stays until `onClick` has answered: a failed Undo replaces it, a good one clears it.
      action: action && {
        label: action.label,
        onClick: (e: { preventDefault(): void }) => {
          e.preventDefault();
          void action.onClick();
        },
      },
      duration,
    });
}

/** A change the server refused, or could not be asked for. */
export function fail(text: string, options: SayOptions = {}): void {
  toast.error(text, {
    action: options.action && {
      label: options.action.label,
      onClick: () => void options.action!.onClick(),
    },
    duration: options.duration,
  });
}
