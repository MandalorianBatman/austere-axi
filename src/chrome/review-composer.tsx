// The note box at the foot of the panel: the whole-page note, Send, and what Send does now.
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useShallow } from "zustand/react/shallow";
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
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/chrome/ui/form";
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
  const s = useReview(
    useShallow((r) => ({
      queued: r.queue.length,
      draft: r.draft,
      archived: r.archived,
      lockout: r.lockout,
      sending: r.sending,
      lastNote: r.transcript.findLast((e) => e.role === "user" && !e.held),
      inviteName: r.inviteName,
      viewerName: r.viewerName,
      composerError: r.composerError,
      outboxUnsaved: r.outboxUnsaved,
      rateLimit: r.rateLimit,
      connected: r.connected,
      presence: r.presence,
      since: r.since,
      wake: r.wake,
      unread: r.unread,
      attachInfo: r.attachInfo,
    })),
  );
  const now = useNow();
  const n = s.queued;
  const view = presenceView(s, now);
  const locked = s.archived || !!s.lockout || s.sending;
  const empty = !n && !s.draft.trim();
  const alreadyDone = empty && !!s.lastNote?.end && !s.lastNote.items?.length;
  // The store holds the draft (Send, Done and the dock read it); the form follows it, so a send that clears it clears the box.
  const form = useForm<{ note: string }>({
    values: { note: s.draft },
    resetOptions: { keepErrors: true },
  });
  const send = form.handleSubmit(() => sendAll(false));
  // Nobody listens: what Send does now, and for the owner the way to start an agent.
  const showSaved = view.cls === "idle" && !view.attached && notesGoToAgent();
  useEffect(() => {
    if (showSaved && OWNER) void loadAgentPrompt();
  }, [showSaved]);
  const error = [s.composerError, s.outboxUnsaved ? UNSAVED_WARNING : ""].filter(Boolean).join(" ");
  // A refused send or an outbox notice is the note's error.
  useEffect(() => {
    if (error) form.setError("note", { type: "server", message: error });
    else form.clearErrors("note");
  }, [error, form]);
  return (
    <>
      <NameAsk />
      <Form {...form}>
        <form
          className="composer"
          aria-label="Send notes"
          aria-busy={s.sending}
          inert={inert}
          onSubmit={(e) => void send(e)}
        >
          <FormField
            control={form.control}
            name="note"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    {...field}
                    ref={(el) => {
                      field.ref(el);
                      composerInput.current = el;
                    }}
                    rows={2}
                    aria-label="A note about the whole page"
                    placeholder={s.archived ? "Page archived" : "Add a note about the whole page"}
                    className="composer-input min-h-[60px] max-h-40 resize-y bg-[var(--bg-3)] text-[length:var(--fs)] md:text-[length:var(--fs)]"
                    disabled={locked}
                    onChange={(e) => {
                      field.onChange(e);
                      set({ draft: e.target.value });
                    }}
                    onFocus={() => getRoster()?.setWriting("composer", true)}
                    onBlur={() => {
                      field.onBlur();
                      getRoster()?.setWriting("composer", false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                </FormControl>
                <FormMessage className="composer-error" role="alert" />
              </FormItem>
            )}
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
          {/* Said once, when the wait starts; the countdown in the Badge is not announced every second. */}
          <p className="sr-only" role="status">
            {s.rateLimit ? "Too many notes. Sending again soon." : ""}
          </p>
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
      </Form>
    </>
  );
}
