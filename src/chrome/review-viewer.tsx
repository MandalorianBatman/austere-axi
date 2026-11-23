// What frames the artifact: the title, the mode switch, the ⋯ menu, the notice about third-party packs, the iframe
// itself, and a hosted page's footer with its report box.
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Icon } from "./icon.tsx";
import { ShapeIcon } from "./icon.tsx";
import type { Shape } from "./icons.ts";
import { BOOT, HOSTED, OWNER, shortcut } from "./review-env.ts";
import { archivePage, openShare, unarchivePage } from "./review-page.ts";
import { copyAgentPrompt, copyText, loadAgentPrompt } from "./review-clipboard.ts";
import { post, setFrame } from "./review-bridge.ts";
import { loadFrame } from "./review-frame.ts";
import { downloadStandalone, getInvite } from "./review-hosted.ts";
import { openHistory } from "./review-history.ts";
import { CopySwitcher, Crumbs } from "./review-nav.tsx";
import { nextUnanswered, openSwitcher } from "./review-nav.ts";
import { S, set, setMode, useReview } from "./review-store.ts";
import type { Mode } from "./review-types.ts";
import { Button } from "@/chrome/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/chrome/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/chrome/ui/dropdown-menu";
import { Label } from "@/chrome/ui/label";
import { Textarea } from "@/chrome/ui/textarea";

const DOTS: Shape[] = [5, 12, 19].map((cx): Shape => [
  "circle",
  { cx, cy: 12, r: 1.6, fill: "currentColor", stroke: "none" },
]);

/** The page's title and, beside it, its file (the owner's) or who the reviewer is. */
export function TitleBlock(): ReactElement {
  const title = useReview((s) => s.title);
  const name = useReview((s) => s.viewerName);
  useEffect(() => {
    document.title = `${title} · austere`;
  }, [title]);
  return (
    <div className="bar-title">
      {OWNER ? <Crumbs /> : null}
      <h1 className="title">{title}</h1>
      <span className="file" title={BOOT.file || ""}>
        {OWNER ? BOOT.name : name ? `reviewing as ${name}` : ""}
      </span>
      {OWNER ? <CopySwitcher /> : null}
    </div>
  );
}

/** Annotate or Explore. An archived page takes no notes, so it is in Explore and the switch says so. */
export function ModeSwitch(): ReactElement {
  const mode = useReview((s) => s.mode);
  const archived = useReview((s) => s.archived);
  const shown: Mode = archived ? "explore" : mode;
  // The frame follows the switch.
  useEffect(() => {
    post({ type: "mode", mode: shown });
  }, [shown]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
        // Typing: Ctrl/⌘+I is the field's (italic, or nothing), not the page mode's.
        const t = e.target;
        if (
          t instanceof HTMLElement &&
          (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
        )
          return;
        e.preventDefault();
        setMode(S().mode === "annotate" ? "explore" : "annotate");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const item =
    "h-6 gap-1.5 !rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-secondary data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:[&_svg]:text-primary max-xs:size-[var(--touch)] max-xs:px-0 max-xs:[&_svg]:size-5";
  return (
    <>
      <ToggleGroup
        type="single"
        aria-label="Mode"
        value={shown}
        // Clicking the chosen item again would clear it: a mode is always on.
        onValueChange={(next) => next && setMode(next as Mode)}
        className="gap-0.5 rounded-lg border bg-card p-0.5 max-xs:flex-none max-xs:bg-muted max-xs:p-0.5"
      >
        <ToggleGroupItem
          value="annotate"
          data-mode="annotate"
          disabled={archived}
          title={
            archived
              ? "The page is archived: it takes no notes"
              : `Click anything to comment on it (${shortcut("I")})`
          }
          className={item}
        >
          <Icon name="annotate" size={14} width={1.9} />
          <span className="max-xs:sr-only">Annotate</span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="explore"
          data-mode="explore"
          title={`Use the page normally: tabs, forms, links (${shortcut("I")})`}
          className={item}
        >
          <Icon name="explore" size={14} width={1.9} />
          <span className="max-xs:sr-only">Explore</span>
        </ToggleGroupItem>
      </ToggleGroup>
      <span className="subbar-hint">
        {archived
          ? "The page is archived: it takes no notes"
          : shown === "explore"
            ? "Use the page normally: tabs, forms, links"
            : "Click any part of the page to comment on it"}
      </span>
    </>
  );
}

/** Third-party packs run their own code inside the page, which is also where annotations and button presses come from. */
export function Notice(): ReactElement {
  const packs = useReview((s) => s.packs);
  // Lead with what to do: on a phone the line is cut to fit.
  const text = `Third-party pack code runs in this page: check queued items before you send (${packs.join(", ")}).`;
  return (
    <div className="notice" hidden={!packs.length} title={packs.length ? text : undefined}>
      {packs.length ? text : null}
    </div>
  );
}

/** The artifact, in a sandboxed frame (the bridge talks to it, review-frame.ts). */
export function Frame(): ReactElement {
  return (
    <iframe
      className="frame"
      title="Artifact"
      ref={setFrame}
      sandbox="allow-scripts allow-popups allow-forms"
    />
  );
}

const ITEM = "max-xs:min-h-[var(--touch)]";

/** The ⋯ menu. Choosing an item closes it; the share note and a download in progress keep it open. */
export function MoreMenu(): ReactElement {
  const open = useReview((s) => s.menuOpen);
  const unlisted = useReview((s) => s.unlisted);
  const archived = useReview((s) => s.archived);
  const exporting = useReview((s) => s.exporting);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu
      // Not modal: the page stays live behind the menu, and a click on it both closes the menu and does its work.
      modal={false}
      open={open}
      onOpenChange={(next) => {
        set({ menuOpen: next });
        if (next && OWNER) void loadAgentPrompt();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="icon"
          className="icon-btn menu-btn"
          aria-label="More"
        >
          <ShapeIcon shapes={DOTS} size={16} />
        </Button>
      </DropdownMenuTrigger>
      {/* No exit animation: the menu is gone when a choice is made, so a click on ⋯ right after a choice opens it again (during an exit animation the menu still counts that click as outside). */}
      <DropdownMenuContent align="end" className="min-w-55 data-[state=closed]:animate-none!">
        {OWNER ? (
          <>
            <DropdownMenuItem
              data-cmd="goto"
              className={ITEM}
              title={`Pages and parts of every project (${shortcut("K")})`}
              // After the menu has closed and given its focus back, as the dialog takes focus.
              onSelect={() => setTimeout(() => openSwitcher(trigger.current), 0)}
            >
              Go to page…
              <DropdownMenuShortcut>{shortcut("K")}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-cmd="next-unanswered"
              className={ITEM}
              title="The next page in the hub's inbox with notes no agent answered"
              onSelect={() => void nextUnanswered()}
            >
              Next page with unanswered notes
            </DropdownMenuItem>
            <DropdownMenuItem
              data-cmd="copy-path"
              className={ITEM}
              onSelect={() => void copyText(BOOT.file, "File path")}
            >
              Copy file path
            </DropdownMenuItem>
          </>
        ) : null}
        {(OWNER || HOSTED) && !(HOSTED && !unlisted) ? (
          <DropdownMenuItem
            data-cmd="copy-link"
            className={ITEM}
            // Hosted, the URL without its fragment: the invite token is already out of the address bar.
            onSelect={() =>
              void copyText(
                HOSTED ? location.origin + location.pathname : S().links?.remote || location.href,
                HOSTED ? "Page link" : "Review link",
              )
            }
          >
            {HOSTED ? "Copy page link" : "Copy review link"}
          </DropdownMenuItem>
        ) : null}
        {OWNER ? (
          <DropdownMenuItem
            data-cmd="share"
            className={ITEM}
            title="A named link for one teammate's device"
            onSelect={() => void openShare()}
          >
            Share…
          </DropdownMenuItem>
        ) : null}
        {OWNER ? (
          <DropdownMenuItem
            data-cmd="copy-agent-prompt"
            className={ITEM}
            title="A prompt that tells your agent to poll this page for feedback"
            onSelect={() => void copyAgentPrompt()}
          >
            Copy agent prompt
          </DropdownMenuItem>
        ) : null}
        {HOSTED && unlisted === false ? (
          <div
            data-share-note
            className="max-w-75 cursor-text px-2.5 py-2 text-[length:var(--fs-sm)] leading-[1.45] text-muted-foreground"
          >
            Only the owner can share this page. To invite someone, they run
            <code className="my-1 block text-2xs whitespace-nowrap text-foreground select-all">
              austere-axi publish &lt;file&gt; --invite "Name"
            </code>
            which prints a link for that person.
          </div>
        ) : null}
        {OWNER ? (
          <DropdownMenuItem
            data-cmd="history"
            className={ITEM}
            title="Every version of this page, and what changed since you last looked"
            onSelect={() => openHistory()}
          >
            History…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem data-cmd="reload" className={ITEM} onSelect={() => loadFrame()}>
          Reload page
        </DropdownMenuItem>
        {HOSTED ? (
          <DropdownMenuItem
            data-cmd="export"
            className={ITEM}
            disabled={exporting}
            // The menu stays open on "Preparing download…" until the file is saved or the banner says why not.
            onSelect={(e) => {
              e.preventDefault();
              void downloadStandalone().then(() => set({ menuOpen: false }));
            }}
          >
            {exporting ? "Preparing download…" : "Download standalone HTML"}
          </DropdownMenuItem>
        ) : OWNER ? (
          <DropdownMenuItem asChild className={ITEM}>
            <a data-cmd="export" href={`${BOOT.hosted?.base ?? `/s/${BOOT.id}`}/export`}>
              Download standalone HTML
            </a>
          </DropdownMenuItem>
        ) : null}
        {OWNER && !archived ? (
          <DropdownMenuItem data-cmd="archive" className={ITEM} onSelect={() => void archivePage()}>
            Archive page
          </DropdownMenuItem>
        ) : null}
        {OWNER && archived ? (
          <DropdownMenuItem
            data-cmd="unarchive"
            className={ITEM}
            onSelect={() => void unarchivePage()}
          >
            Unarchive page
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Hosted: a report box that sends to the service, and the footer that opens it. */
export function HostedFoot(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("");
  const [done, setDone] = useState(false);
  const [sending, setSending] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const doneText = useRef<HTMLSpanElement>(null);
  const wasOpen = useRef(false);
  // Opening the box puts the cursor in it; closing it (Cancel) gives the keyboard back to Report.
  useEffect(() => {
    if (open) document.getElementById("austere-report")?.focus();
    else if (wasOpen.current) openButton.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // A sent report replaces the Report button: the keyboard goes to the thanks, which is announced.
  useEffect(() => {
    if (done) doneText.current?.focus();
  }, [done]);
  if (!HOSTED) return null;
  const report = HOSTED.report;
  const send = async (): Promise<void> => {
    const text = reason.trim();
    if (!text || !report || sending) return;
    setSending(true);
    setStatus("Sending…");
    try {
      const invite = getInvite();
      const r = await fetch(report, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(invite ? { "X-Austere-Invite": invite } : {}),
        },
        body: JSON.stringify({ reason: text }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReason("");
      setStatus("");
      setOpen(false);
      setDone(true);
    } catch (err) {
      setStatus(
        err instanceof Error && err.message.startsWith("HTTP ")
          ? `The service answered ${err.message.slice(5)}. Your report is still here: try again.`
          : "Couldn't reach the service. Your report is still here: try again.",
      );
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      {report ? (
        <form
          className="report-box"
          hidden={!open}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Label htmlFor="austere-report">What is wrong with this page?</Label>
          <Textarea
            id="austere-report"
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="report-row">
            <span className="report-status" role="status">
              {status}
            </span>
            <Button type="button" size="xs" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!reason.trim() || sending}>
              Send report
            </Button>
          </div>
        </form>
      ) : null}
      <footer className="hosted-foot">
        <a
          href="https://github.com/MandalorianBatman/austere-axi"
          target="_blank"
          rel="noopener noreferrer"
        >
          Made with austere-axi
        </a>
        {report ? (
          <>
            <span aria-hidden="true">·</span>
            {done ? (
              <span className="report-done" role="status" tabIndex={-1} ref={doneText}>
                Reported. Thank you.
              </span>
            ) : (
              <Button
                type="button"
                variant="link"
                size="xs"
                ref={openButton}
                className="report-open h-auto p-0 font-[inherit] text-muted-foreground no-underline hover:text-foreground hover:underline"
                onClick={() => {
                  setOpen(true);
                  setStatus("");
                }}
              >
                Report
              </Button>
            )}
          </>
        ) : null}
      </footer>
    </>
  );
}
