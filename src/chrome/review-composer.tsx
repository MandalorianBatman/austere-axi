// The note box at the foot of the panel: the whole-page note, Send, and what Send does now.
import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod/mini";
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
import { Alert } from "@/chrome/ui/alert";
import { Badge } from "@/chrome/ui/badge";
import { Button } from "@/chrome/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/chrome/ui/form";
import { Input } from "@/chrome/ui/input";
import { Textarea } from "@/chrome/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/chrome/ui/tooltip";

const UNSAVED_WARNING =
  "This browser could not keep a copy of your note: keep this tab open until it shows “Sent to the page owner”.";

const nameSchema = z.object({
  name: z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "Enter your name so the owner knows who wrote these notes."),
      z.maxLength(NAME_MAX),
    ),
});

/** Hosted, unlisted page without an invite: the reviewer names themself once, before the first send. */
function NameAsk(): ReactElement | null {
  const asking = useReview((s) => s.askName);
  const form = useForm({ resolver: zodResolver(nameSchema), defaultValues: { name: "" } });
  if (!HOSTED || !asking) return null;
  return (
    <Form {...form}>
      <form
        className="name-ask"
        noValidate
        onSubmit={form.handleSubmit(({ name }) => {
          LS.set("austere:name", name);
          set({ viewerName: name, askName: false });
          getRoster()?.rename();
          void sendAll(false);
        })}
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Your name, shown with your notes (required)</FormLabel>
              <div className="name-row">
                <FormControl>
                  <Input
                    {...field}
                    autoFocus
                    required
                    aria-required="true"
                    maxLength={NAME_MAX}
                    autoComplete="name"
                    placeholder="Name"
                  />
                </FormControl>
                <Button type="submit">Continue</Button>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
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

function hint(viewerName: string, hostedOwner: boolean): string {
  if (OWNER) return "Enter sends · Shift+Enter newline";
  if (hostedOwner) return "Enter sends to the agent · Shift+Enter newline";
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
      composerRetry: r.composerRetry,
      outboxUnsaved: r.outboxUnsaved,
      rateLimit: r.rateLimit,
      connected: r.connected,
      presence: r.presence,
      since: r.since,
      wake: r.wake,
      unread: r.unread,
      attachInfo: r.attachInfo,
      hostedOwner: r.hostedOwner,
    })),
  );
  const now = useNow();
  const n = s.queued;
  const view = presenceView(s, now);
  // While a send is in flight the controls stay in the tab order (readOnly, aria-disabled): `disabled` would drop focus to <body>.
  const locked = s.archived || !!s.lockout;
  const empty = !n && !s.draft.trim();
  const alreadyDone = empty && !!s.lastNote?.end && !s.lastNote.items?.length;
  // The store holds the draft (Send, Done and the dock read it); the form follows it, so a send that clears it clears the box.
  const form = useForm<{ note: string }>({
    values: { note: s.draft },
    resetOptions: { keepErrors: true },
  });
  const send = form.handleSubmit(() => sendAll(false));
  // Nobody listens: what Send does now, and for the owner the way to start an agent.
  const showSaved = view.cls === "idle" && !view.attached && notesGoToAgent(s.hostedOwner);
  useEffect(() => {
    if (showSaved && OWNER) void loadAgentPrompt();
  }, [showSaved]);
  const error = [s.composerError, s.outboxUnsaved ? UNSAVED_WARNING : ""].filter(Boolean).join(" ");
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
                    className="composer-input min-h-[60px] max-h-40 resize-y bg-[var(--bg-3)] text-[length:var(--fs)] md:text-[length:var(--fs)] max-xs:text-[16px]"
                    disabled={locked}
                    readOnly={s.sending}
                    aria-disabled={s.sending || undefined}
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
              </FormItem>
            )}
          />
          {/* A refused send is the form's, not the note's: the text is fine, the service was not. */}
          {error ? (
            <Alert variant="destructive" className="composer-error">
              <div className="col-start-2 flex items-center justify-between gap-2">
                <span>{error}</span>
                {s.composerRetry ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void sendAll(false)}
                  >
                    Try again
                  </Button>
                ) : null}
              </div>
            </Alert>
          ) : null}
          <div className="composer-row">
            {OWNER ? (
              <Button
                type="button"
                variant="outline"
                className="send-end"
                disabled={s.archived || alreadyDone}
                aria-disabled={s.sending || undefined}
                title={
                  alreadyDone
                    ? "You already told the agent you have no more notes"
                    : empty
                      ? "Tell the agent you have no more notes"
                      : "Send these notes and tell the agent it can stop listening. You can still add notes later."
                }
                onClick={() => {
                  if (!s.sending) void sendAll(true);
                }}
              >
                {empty ? "Done" : "Send & finish"}
              </Button>
            ) : null}
            <Button
              type="submit"
              className="send"
              disabled={locked || (!!HOSTED && s.inviteName === undefined)}
              aria-disabled={s.sending || undefined}
              onClick={(e) => {
                if (s.sending) e.preventDefault();
              }}
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
          <span className="composer-hint">{hint(s.viewerName, s.hostedOwner)}</span>
          {s.rateLimit ? <RetryBadge until={s.rateLimit} /> : null}
          {/* Said once, when the wait starts; the countdown in the Badge is not announced every second. */}
          <p className="sr-only" role="status">
            {s.rateLimit ? "Too many notes. Sending again soon." : ""}
          </p>
          <div
            className="composer-listen"
            hidden={view.cls !== "listening" || !notesGoToAgent(s.hostedOwner)}
          >
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
