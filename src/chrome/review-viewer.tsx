// What frames the artifact: the title, the mode switch, the ⋯ menu, the notice about third-party packs, the iframe
// itself, and a hosted page's footer with its report box.
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Icon } from "./icon.tsx";
import { ShapeIcon } from "./icon.tsx";
import type { Shape } from "./icons.ts";
import { BOOT, HOSTED, OWNER } from "./review-env.ts";
import { archivePage, openShare, unarchivePage } from "./review-page.ts";
import { copyAgentPrompt, copyText, loadAgentPrompt } from "./review-clipboard.ts";
import { post, setFrame } from "./review-bridge.ts";
import { loadFrame } from "./review-frame.ts";
import { downloadStandalone, getInvite } from "./review-hosted.ts";
import { openHistory } from "./review-history.ts";
import { S, set, setMode, useReview } from "./review-store.ts";
import type { Mode } from "./review-types.ts";
import { Button } from "@/chrome/ui/button";
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
      <h1 className="title">{title}</h1>
      <span className="file" title={BOOT.file || ""}>
        {OWNER ? BOOT.name : name ? `reviewing as ${name}` : ""}
      </span>
    </div>
  );
}

/** Annotate or Explore. An archived page takes no notes, so it is in Explore and the switch says so. */
export function ModeSwitch(): ReactElement {
  const mode = useReview((s) => s.mode);
  const archived = useReview((s) => s.archived);
  const shown: Mode = archived ? "explore" : mode;
  // The frame follows the switch.
  useEffect(() => post({ type: "mode", mode: shown }), [shown]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        setMode(S().mode === "annotate" ? "explore" : "annotate");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <div className="seg" role="group" aria-label="Mode">
        <button
          type="button"
          data-mode="annotate"
          className={shown === "annotate" ? "on" : undefined}
          aria-pressed={shown === "annotate"}
          disabled={archived}
          title={
            archived
              ? "The page is archived: it takes no notes"
              : "Click anything to comment on it (⌘/Ctrl+I)"
          }
          onClick={() => setMode("annotate")}
        >
          <Icon name="annotate" size={14} width={1.9} />
          <span className="seg-label">Annotate</span>
        </button>
        <button
          type="button"
          data-mode="explore"
          className={shown === "explore" ? "on" : undefined}
          aria-pressed={shown === "explore"}
          title="Use the page normally: tabs, forms, links (⌘/Ctrl+I)"
          onClick={() => setMode("explore")}
        >
          <Icon name="explore" size={14} width={1.9} />
          <span className="seg-label">Explore</span>
        </button>
      </div>
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

/** The ⋯ menu. Clicks on its items close it; the share note and a download in progress keep it open. */
export function MoreMenu(): ReactElement {
  const open = useReview((s) => s.menuOpen);
  const unlisted = useReview((s) => s.unlisted);
  const archived = useReview((s) => s.archived);
  const exporting = useReview((s) => s.exporting);
  useEffect(() => {
    const close = (): void => set({ menuOpen: false });
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const onCommand = async (e: React.MouseEvent<HTMLDivElement>): Promise<void> => {
    const cmd =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>("[data-cmd]")?.dataset.cmd
        : undefined;
    // The share note stays open so its command can be selected.
    if (!cmd) return e.stopPropagation();
    if (cmd === "copy-path") await copyText(BOOT.file, "File path");
    // Hosted, the URL without its fragment: the invite token is already out of the address bar.
    if (cmd === "copy-link")
      await copyText(
        HOSTED ? location.origin + location.pathname : S().links?.remote || location.href,
        HOSTED ? "Page link" : "Review link",
      );
    if (cmd === "copy-agent-prompt") await copyAgentPrompt();
    if (cmd === "history") openHistory();
    if (cmd === "reload") loadFrame();
    if (cmd === "export" && HOSTED) {
      // The menu stays open on "Preparing download…" until the file is saved or the banner says why not.
      e.stopPropagation();
      await downloadStandalone();
      set({ menuOpen: false });
    }
    if (cmd === "share") await openShare();
    if (cmd === "archive") await archivePage();
    if (cmd === "unarchive") await unarchivePage();
  };
  return (
    <div className="menu">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="icon-btn menu-btn"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          set({ menuOpen: !open });
          if (!open && OWNER) void loadAgentPrompt();
        }}
      >
        <ShapeIcon shapes={DOTS} size={16} />
      </Button>
      <div className="menu-pop" hidden={!open} onClick={(e) => void onCommand(e)}>
        {OWNER ? (
          <button type="button" data-cmd="copy-path">
            Copy file path
          </button>
        ) : null}
        {OWNER || HOSTED ? (
          <button type="button" data-cmd="copy-link" hidden={!!HOSTED && !unlisted}>
            {HOSTED ? "Copy page link" : "Copy review link"}
          </button>
        ) : null}
        {OWNER ? (
          <button type="button" data-cmd="share" title="A named link for one teammate's device">
            Share…
          </button>
        ) : null}
        {OWNER ? (
          <button
            type="button"
            data-cmd="copy-agent-prompt"
            title="A prompt that tells your agent to poll this page for feedback"
          >
            Copy agent prompt
          </button>
        ) : null}
        {HOSTED ? (
          <div className="menu-note" data-share-note hidden={unlisted !== false}>
            Only the owner can share this page. To invite someone, they run
            <code>austere-axi publish &lt;file&gt; --invite "Name"</code>which prints a link for
            that person.
          </div>
        ) : null}
        {OWNER ? (
          <button
            type="button"
            data-cmd="history"
            title="Every version of this page, and what changed since you last looked"
          >
            History…
          </button>
        ) : null}
        <button type="button" data-cmd="reload">
          Reload page
        </button>
        {HOSTED ? (
          <button type="button" data-cmd="export" disabled={exporting}>
            {exporting ? "Preparing download…" : "Download standalone HTML"}
          </button>
        ) : OWNER ? (
          <a data-cmd="export" href={`${BOOT.hosted?.base ?? `/s/${BOOT.id}`}/export`}>
            Download standalone HTML
          </a>
        ) : null}
        {OWNER ? (
          <button type="button" data-cmd="archive" hidden={archived}>
            Archive page
          </button>
        ) : null}
        {OWNER ? (
          <button type="button" data-cmd="unarchive" hidden={!archived}>
            Unarchive page
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Hosted: a report box that sends to the service, and the footer that opens it. */
export function HostedFoot(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState("");
  const [done, setDone] = useState(false);
  // Opening the box puts the cursor in it.
  useEffect(() => {
    if (open) document.getElementById("austere-report")?.focus();
  }, [open]);
  if (!HOSTED) return null;
  const report = HOSTED.report;
  const send = async (): Promise<void> => {
    const text = reason.trim();
    if (!text || !report) return;
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
      setOpen(false);
      setDone(true);
    } catch (err) {
      setStatus(`Not sent: ${(err as Error).message}`);
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
            <span className="report-status">{status}</span>
            <Button type="button" size="xs" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs">
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
              <span className="report-done">Reported. Thank you.</span>
            ) : (
              <button
                type="button"
                className="link-btn report-open"
                onClick={() => {
                  setOpen(true);
                  setStatus("");
                }}
              >
                Report
              </button>
            )}
          </>
        ) : null}
      </footer>
    </>
  );
}
