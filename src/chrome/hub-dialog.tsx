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
      title: string;
      action: string;
      opener: Element | null;
      heading: Element | null;
      done: (ok: boolean) => void;
    }
  | {
      kind: "prompt";
      text: string;
      value: string;
      maxLength: number;
      opener: Element | null;
      heading: Element | null;
      done: (value: string | null) => void;
    };

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** What the ask's own heading looks like, when the opener has gone and focus needs a landmark. */
function headingOf(opener: Element | null): Element | null {
  const section = opener?.closest("section[aria-labelledby]");
  const id = section?.getAttribute("aria-labelledby");
  return id ? document.getElementById(id) : null;
}

/** `title` and `action` name the question and its yes button; the default is a plain "Are you sure?" / "Continue". */
export function confirmDialog(
  text: string,
  danger = false,
  { title = "Are you sure?", action = "Continue" }: { title?: string; action?: string } = {},
): Promise<boolean> {
  const opener = document.activeElement;
  return new Promise((resolve) =>
    useAsk.setState({
      ask: {
        kind: "confirm",
        text,
        danger,
        title,
        action,
        opener,
        heading: headingOf(opener),
        done: resolve,
      },
    }),
  );
}

/** A name to type; an empty one is refused in the dialog, and `maxLength` caps what can be typed. */
export function promptDialog(
  text: string,
  value: string,
  { maxLength = 80 }: { maxLength?: number } = {},
): Promise<string | null> {
  const opener = document.activeElement;
  return new Promise((resolve) =>
    useAsk.setState({
      ask: {
        kind: "prompt",
        text,
        value,
        maxLength,
        opener,
        heading: headingOf(opener),
        done: resolve,
      },
    }),
  );
}

export function HubDialogs(): ReactElement | null {
  const ask = useAsk((s) => s.ask);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Ask | null>(null);
  if (ask !== seen) {
    setSeen(ask);
    setError(null);
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
    else if (!text.trim()) {
      setError("Enter a name.");
      return;
    } else ask.done(text);
    useAsk.setState({ ask: null });
  };
  return (
    <Dialog open onOpenChange={(open) => open || close()}>
      <DialogContent
        showCloseButton={false}
        // Radix returns focus to a trigger; there is none here, so it goes back to what asked, else to the
        // heading of the section it sat in, else to the view.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const back = [ask.opener, ask.heading].find((el) => el?.isConnected);
          const target = back ?? document.getElementById("content");
          if (target instanceof HTMLElement) {
            if (target !== ask.opener) target.tabIndex = -1;
            target.focus();
          }
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
            <DialogTitle>{ask.kind === "confirm" ? ask.title : "Rename"}</DialogTitle>
            <DialogDescription>{ask.text}</DialogDescription>
          </DialogHeader>
          {ask.kind === "prompt" ? (
            <div className="grid gap-2">
              <Input
                autoFocus
                aria-label={ask.text}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "prompt-error" : undefined}
                maxLength={ask.maxLength}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
              />
              {error ? (
                <p id="prompt-error" role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={ask.kind === "confirm" && ask.danger ? "destructive" : "default"}
            >
              {ask.kind === "confirm" ? ask.action : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
