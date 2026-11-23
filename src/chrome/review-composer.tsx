// The note box at the foot of the panel: the whole-page note, Send, and what Send does now.
import { useEffect } from "react";
import type { ReactElement } from "react";
import { LoaderCircle } from "lucide-react";
import { Icon } from "./icon.tsx";
import { HOSTED, LS, NAME_MAX, OWNER, VIEWER } from "./review-env.ts";
import { copyAgentPrompt, loadAgentPrompt } from "./review-clipboard.ts";
import { useNow } from "./review-hooks.ts";
import { sendAll, composerInput } from "./review-send.ts";
import { notesGoToAgent, presenceView, getRoster } from "./review-presence.ts";
import { set, useReview } from "./review-store.ts";
import { Badge } from "@/chrome/ui/badge";
import { Button } from "@/chrome/ui/button";
import { Input } from "@/chrome/ui/input";
import { Label } from "@/chrome/ui/label";
import { Textarea } from "@/chrome/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/chrome/ui/tooltip";

const UNSAVED_WARNING =
  "This browser could not keep a copy of your note: keep this tab open until it shows “Sent to the page owner”.";

/** Hosted, unlisted page without an invite: the reviewer names themself once, before the first send. */
function NameAsk(): ReactElement | null {
  const asking = useReview((s) => s.askName);
  if (!HOSTED || !asking) return null;
  return (
    <form
      className="name-ask"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("name") as HTMLInputElement;
        const name = input.value.trim().slice(0, NAME_MAX);
        if (!name) return input.focus();
        LS.set("austere:name", name);
        set({ viewerName: name, askName: false });
        getRoster()?.rename();
        void sendAll(false);
      }}
    >
      <Label htmlFor="austere-name">Your name, shown with your notes</Label>
      <div className="name-row">
        <Input
          id="austere-name"
          name="name"
          autoFocus
          maxLength={NAME_MAX}
          autoComplete="name"
          placeholder="Name"
        />
        <Button type="submit">Continue</Button>
      </div>
    </form>
  );
}

/** A note the service refused for now (`rate_limited`) stays in the outbox and goes again by itself. */
function RetryBadge({ until }: { until: number }): ReactElement {
  const now = useNow(1000);
  const left = Math.ceil((until - now) / 1000);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="composer-retry" tabIndex={0}>
          Too many notes · {left > 0 ? `sending again in ${left} s` : "sending again…"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>This note is kept and goes out again by itself.</TooltipContent>
    </Tooltip>
  );
}

function hint(viewerName: string): string {
  if (OWNER) return "Enter sends · Shift+Enter newline";
  const base =
    HOSTED || VIEWER.auto ? "Enter sends" : "the owner sends your notes on · Enter sends";
  return viewerName ? `Posting as ${viewerName} · ${base}` : base;
}

export function Composer({ inert }: { inert?: boolean }): ReactElement {
  const s = useReview();
  const now = useNow();
  const n = s.queue.length;
  const view = presenceView(s, now);
  const locked = s.archived || !!s.lockout || s.sending;
  const empty = !n && !s.draft.trim();
  const lastNote = s.transcript.findLast((e) => e.role === "user" && !e.held);
  const alreadyDone = empty && !!lastNote?.end && !lastNote.items?.length;
  // Nobody listens: what Send does now, and for the owner the way to start an agent.
  const showSaved = view.cls === "idle" && !view.attached && notesGoToAgent();
  useEffect(() => {
    if (showSaved && OWNER) void loadAgentPrompt();
  }, [showSaved]);
  const error = [s.composerError, s.outboxUnsaved ? UNSAVED_WARNING : ""].filter(Boolean).join(" ");
  return (
    <>
      <NameAsk />
      <form
        className="composer"
        aria-label="Send notes"
        inert={inert}
        onSubmit={(e) => {
          e.preventDefault();
          void sendAll(false);
        }}
      >
        <Textarea
          ref={(el) => {
            composerInput.current = el;
          }}
          rows={2}
          aria-label="A note about the whole page"
          placeholder={s.archived ? "Page archived" : "Add a note about the whole page"}
          className="composer-input min-h-[60px] max-h-40 resize-y bg-[var(--bg-3)] text-[length:var(--fs)] md:text-[length:var(--fs)]"
          value={s.draft}
          disabled={locked}
          onChange={(e) => set({ draft: e.target.value })}
          onFocus={() => getRoster()?.setWriting("composer", true)}
          onBlur={() => getRoster()?.setWriting("composer", false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void sendAll(false);
            }
          }}
        />
        <div className="composer-row">
          {OWNER ? (
            <Button
              type="button"
              variant="outline"
              className="send-end"
              disabled={s.archived || s.sending || alreadyDone}
              title={
                alreadyDone
                  ? "You already told the agent you have no more notes"
                  : empty
                    ? "Tell the agent you have no more notes"
                    : "Send these notes and tell the agent it can stop listening. You can still add notes later."
              }
              onClick={() => void sendAll(true)}
            >
              {empty ? "Done" : "Send & finish"}
            </Button>
          ) : null}
          <Button
            type="submit"
            className="send"
            disabled={locked || (!!HOSTED && s.inviteName === undefined)}
            aria-busy={s.sending}
          >
            {s.sending ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden="true" />
                Sending…
              </>
            ) : (
              <>
                {n ? `Send ${n} note${n === 1 ? "" : "s"}` : "Send"}
                <Icon name="arrowRight" size={14} width={2.1} />
              </>
            )}
          </Button>
        </div>
        <span className="composer-hint">{hint(s.viewerName)}</span>
        {s.rateLimit ? <RetryBadge until={s.rateLimit} /> : null}
        <div className="composer-error" role="alert" hidden={!error}>
          {error}
        </div>
        <div className="composer-listen" hidden={view.cls !== "listening" || !notesGoToAgent()}>
          <span className="composer-dot" aria-hidden="true" />
          <span>An agent is listening and takes your notes as soon as you send</span>
        </div>
        <div className="composer-presence" hidden={!showSaved}>
          <span>Saved. The agent gets them the next time it checks.</span>
          {OWNER ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="copy-prompt"
              onClick={() => void copyAgentPrompt()}
            >
              Copy agent prompt
            </Button>
          ) : null}
        </div>
      </form>
    </>
  );
}
