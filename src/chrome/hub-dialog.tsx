// confirm() and prompt() as shadcn dialogs: `confirmDialog(text)` and `promptDialog(text, value)` return a promise
// that settles when the owner answers; <HubDialogs /> (mounted once) draws them. Escape and the close button answer "no".
import { useState } from "react";
import type { ReactElement } from "react";
import { create } from "zustand";
import { Button } from "@/chrome/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/chrome/ui/dialog";
import { Input } from "@/chrome/ui/input";

/** `opener`: what had focus when the question was asked; it gets focus back when the dialog closes. */
type Ask =
  | {
      kind: "confirm";
      text: string;
      danger: boolean;
      opener: Element | null;
      done: (ok: boolean) => void;
    }
  | {
      kind: "prompt";
      text: string;
      value: string;
      opener: Element | null;
      done: (value: string | null) => void;
    };

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function confirmDialog(text: string, danger = false): Promise<boolean> {
  return new Promise((resolve) =>
    useAsk.setState({
      ask: { kind: "confirm", text, danger, opener: document.activeElement, done: resolve },
    }),
  );
}

export function promptDialog(text: string, value: string): Promise<string | null> {
  return new Promise((resolve) =>
    useAsk.setState({
      ask: { kind: "prompt", text, value, opener: document.activeElement, done: resolve },
    }),
  );
}

export function HubDialogs(): ReactElement | null {
  const ask = useAsk((s) => s.ask);
  const [text, setText] = useState("");
  const [seen, setSeen] = useState<Ask | null>(null);
  if (ask !== seen) {
    setSeen(ask);
    if (ask?.kind === "prompt") setText(ask.value);
  }
  if (!ask) return null;
  const close = (): void => {
    if (ask.kind === "confirm") ask.done(false);
    else ask.done(null);
    useAsk.setState({ ask: null });
  };
  const accept = (): void => {
    if (ask.kind === "confirm") ask.done(true);
    else ask.done(text);
    useAsk.setState({ ask: null });
  };
  return (
    <Dialog open onOpenChange={(open) => open || close()}>
      <DialogContent
        showCloseButton={false}
        // Radix returns focus to a trigger; there is none here, so it goes back to what asked.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (ask.opener instanceof HTMLElement && ask.opener.isConnected) ask.opener.focus();
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            accept();
          }}
        >
          <DialogHeader>
            <DialogTitle>{ask.kind === "confirm" ? "Are you sure?" : "Rename"}</DialogTitle>
            <DialogDescription>{ask.text}</DialogDescription>
          </DialogHeader>
          {ask.kind === "prompt" ? (
            <Input
              autoFocus
              aria-label={ask.text}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={ask.kind === "confirm" && ask.danger ? "destructive" : "default"}
            >
              {ask.kind === "confirm" ? "Continue" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
