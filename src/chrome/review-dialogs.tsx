// The owner's two questions: archive this page (which copies go), and share it with one person (a named link).
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod/mini";
import { BASE, UNREACHABLE, failure } from "./review-env.ts";
import { copyText } from "./review-clipboard.ts";
import { set, useReview } from "./review-store.ts";
import type { ArchivePlan, ShareMade, ShareOffer } from "./review-types.ts";
import { Button } from "@/chrome/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/chrome/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/chrome/ui/form";
import { Input } from "@/chrome/ui/input";
import { Label } from "@/chrome/ui/label";
import { RadioGroup, RadioGroupItem } from "@/chrome/ui/radio-group";

const close = (): void => set({ ask: null });

/**
 * Radix gives focus back to a trigger; these dialogs have none. Focus goes to what had it when the dialog was asked for
 * (the bar's Share button); a menu item has closed by then, so it goes to the menu's button instead.
 */
function giveFocusBack(opener: HTMLElement | null): (e: Event) => void {
  return (e) => {
    e.preventDefault();
    const shown = opener?.isConnected && opener.getClientRects().length > 0;
    (shown ? opener : document.querySelector<HTMLElement>(".menu-btn"))?.focus();
  };
}

const count = (n: number): string => `${n} unanswered note${n === 1 ? "" : "s"}`;

/** Asks before archiving: which copy goes, the unanswered notes that go with it, and the copies that stay open. */
function ArchiveDialog({
  plan,
  done,
  opener,
}: {
  plan: ArchivePlan;
  done: (every: boolean | null) => void;
  opener: HTMLElement | null;
}): ReactElement {
  const several = plan.others.length > 0;
  const waiting = plan.archived[0]?.unanswered ?? 0;
  const answer = (v: boolean | null): void => {
    close();
    done(v);
  };
  return (
    <Dialog open onOpenChange={(open) => open || answer(null)}>
      <DialogContent
        className="confirm"
        showCloseButton={false}
        onCloseAutoFocus={giveFocusBack(opener)}
      >
        <DialogHeader>
          <DialogTitle>
            {several ? `Archive this copy (${plan.copy})?` : "Archive this page?"}
          </DialogTitle>
          <DialogDescription>
            {several
              ? "This copy leaves the hub's lists and no one can add notes to it until you unarchive it."
              : "It leaves the hub's lists and no one can add notes until you unarchive it."}
          </DialogDescription>
        </DialogHeader>
        {waiting ? (
          <p className="text-sm">
            {waiting === 1
              ? "1 unanswered note goes with it: it is kept, but leaves the hub's counts."
              : `${waiting} unanswered notes go with it: they are kept, but leave the hub's counts.`}
          </p>
        ) : null}
        {several ? (
          <>
            <p className="text-sm">
              {plan.others.length === 1 ? "This copy stays open:" : "These copies stay open:"}
            </p>
            <ul className="grid gap-1 pl-4 text-sm list-disc">
              {plan.others.map((c) => (
                <li key={c.file} title={c.file}>
                  {c.unanswered ? `${c.copy} · ${count(c.unanswered)}` : c.copy}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => answer(null)}>
            Cancel
          </Button>
          {several ? (
            <Button
              type="button"
              variant="outline"
              data-archive="every"
              onClick={() => answer(true)}
            >
              Archive every copy
            </Button>
          ) : null}
          <Button type="button" data-archive="this" onClick={() => answer(false)}>
            {several ? "Archive this copy" : "Archive page"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const shareSchema = z.object({
  name: z.string().check(z.trim(), z.minLength(1, "Enter their name."), z.maxLength(40)),
  scope: z.string(),
  mode: z.string(),
});

/** A choice of the Share form: a radio and what it means, as one label. */
function Choice({ value, children }: { value: string; children: string }): ReactElement {
  return (
    <Label className="share-opt font-normal">
      <RadioGroupItem value={value} />
      <span>{children}</span>
    </Label>
  );
}

/** The Share dialog: name, what it reaches, hold or auto; then the link with a Copy button. */
function ShareDialog({
  offer,
  opener,
}: {
  offer: ShareOffer;
  opener: HTMLElement | null;
}): ReactElement {
  const [made, setMade] = useState<ShareMade | null>(null);
  const [error, setError] = useState("");
  // An untouched notes choice is the saved default: leave it to the server, which holds the notes where an attached agent rules auto out.
  // A click counts too: clicking the radio that is already selected fires no change, and it is still the owner's choice.
  const touched = useRef(false);
  const form = useForm({
    resolver: zodResolver(shareSchema),
    defaultValues: { name: "", scope: "page", mode: offer.auto ? "auto" : "hold" },
  });
  const link = useRef<HTMLInputElement>(null);
  // The link is focused and selected once it is on screen (the form that had focus is gone), for a copy by hand.
  useEffect(() => {
    if (!made) return;
    link.current?.focus();
    link.current?.select();
  }, [made]);
  const { isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (v) => {
    setError("");
    const r = await fetch(`${BASE}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The project the dialog offered: the server refuses the share if the page has moved since.
      body: JSON.stringify({
        name: v.name,
        scope: v.scope,
        project: offer.project?.id,
        auto: touched.current ? v.mode === "auto" : undefined,
      }),
    }).catch(() => null);
    if (!r || !r.ok) return setError(r ? await failure(r) : UNREACHABLE);
    setMade((await r.json()) as ShareMade);
  });
  return (
    <Dialog open onOpenChange={(open) => open || close()}>
      <DialogContent
        className="confirm share"
        showCloseButton={false}
        onCloseAutoFocus={giveFocusBack(opener)}
      >
        {made ? (
          <>
            <DialogHeader>
              <DialogTitle>{`Link for ${made.name}`}</DialogTitle>
              <DialogDescription>
                {`Reaches ${made.reaches}. ${made.auto ? "Their notes go straight to the agent." : "Their notes wait for you."} Works once, until ${new Date(made.expiresAt).toLocaleString()} if nobody opens it. Send it only to ${made.name}.`}
              </DialogDescription>
            </DialogHeader>
            <Input
              ref={link}
              type="text"
              className="share-link"
              readOnly
              value={made.link}
              aria-label="Link"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                data-share="copy"
                onClick={() => void copyText(made.link, "Link")}
              >
                Copy link
              </Button>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <Form {...form}>
            <form className="share-form grid gap-4" onSubmit={submit} noValidate>
              <DialogHeader>
                <DialogTitle>Share with one person</DialogTitle>
                <DialogDescription>
                  The first browser that opens the link becomes their device, and the link stops
                  working. An unopened link expires in 7 days.
                </DialogDescription>
              </DialogHeader>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="sr-only">Name</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="text"
                        maxLength={40}
                        required
                        autoFocus
                        placeholder="Their name"
                        autoComplete="off"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="scope"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>They can review</FormLabel>
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange}>
                        <Choice value="page">This page</Choice>
                        {offer.project ? (
                          <Choice value="project">{`Every page in ${offer.project.name}`}</Choice>
                        ) : null}
                        <Choice value="all">Every page</Choice>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Their notes</FormLabel>
                    <FormControl>
                      <RadioGroup
                        value={field.value}
                        onValueChange={field.onChange}
                        onClickCapture={() => {
                          touched.current = true;
                        }}
                      >
                        <Choice value="hold">Wait for me to send them on</Choice>
                        <Choice value="auto">Go straight to the agent</Choice>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
              {offer.remote ? null : (
                <p className="share-error text-sm">
                  No tailnet address is up here, so a teammate could not open a link. Start
                  Tailscale, or set AUSTERE_AXI_HOST.
                </p>
              )}
              {error ? (
                <p className="share-error text-sm" role="alert">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  Create link
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Dialogs(): ReactElement | null {
  const ask = useReview((s) => s.ask);
  if (!ask) return null;
  return ask.kind === "archive" ? (
    <ArchiveDialog plan={ask.plan} done={ask.done} opener={ask.opener} />
  ) : (
    <ShareDialog offer={ask.offer} opener={ask.opener} />
  );
}
