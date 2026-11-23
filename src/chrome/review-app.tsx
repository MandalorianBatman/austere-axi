// The review page: the artifact frame and, beside it, the conversation panel. Panels read the store (review-store.ts).
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { Icon, ShapeIcon } from "./icon.tsx";
import type { Shape } from "./icons.ts";
import { HOSTED, OWNER } from "./review-env.ts";
import { AttachPill } from "./review-attach.tsx";
import { useAttachFeed } from "./review-attach.ts";
import { useBanner } from "./review-banner.ts";
import {
  ChangesButton,
  HistoryButton,
  PresencePill,
  Revision,
  ShareButton,
  SinceBar,
} from "./review-bar.tsx";
import { useHighlightSync } from "./review-changes.ts";
import { Composer } from "./review-composer.tsx";
import { Dialogs } from "./review-dialogs.tsx";
import { useFrameMessages } from "./review-frame.ts";
import { useHistoryFeed } from "./review-history.ts";
import { HistoryPanel } from "./review-history-panel.tsx";
import { useRootClass } from "./review-hooks.ts";
import { Log } from "./review-log.tsx";
import { Queue } from "./review-queue.tsx";
import { Dock, PanelHead, Scrim, useCovered, useSheetEscape } from "./review-tabs.tsx";
import { useReview } from "./review-store.ts";
import { Frame, HostedFoot, ModeSwitch, MoreMenu, Notice, TitleBlock } from "./review-viewer.tsx";
import { Button } from "@/chrome/ui/button";
import { TooltipProvider } from "@/chrome/ui/tooltip";

const LOGO: Shape[] = [
  ["rect", { x: 1.5, y: 1.5, width: 21, height: 21, rx: 5, className: "logo-box" }],
  ["path", { d: "M6.75 17.25 12 6l5.25 11.25M8.6 13.5h6.8", className: "logo-a" }],
];

// The owner's own controls: a hosted viewer, or a reviewer on the local server, has none of them (RLM-265, RLM-322).
const OWNER_BAR = OWNER && !HOSTED;

/** What the page says above the frame: a notice with its buttons, and short confirmations. */
function Banner(): ReactElement {
  const { text, actions } = useBanner();
  return (
    <div className="banner" hidden={!text}>
      <span>{text}</span>
      {actions.map((a) =>
        a.href ? (
          <Button asChild size="xs" variant="outline" key={a.label}>
            <a href={a.href}>{a.label}</a>
          </Button>
        ) : (
          <Button type="button" size="xs" variant="outline" key={a.label} onClick={a.onClick}>
            {a.label}
          </Button>
        ),
      )}
    </div>
  );
}

/** What the owner's page does on its own while it is open: keeps the history and the agent setting current. */
function OwnerEffects(): null {
  useHistoryFeed();
  useAttachFeed();
  return null;
}

function App(): ReactElement {
  useRootClass("is-archived", useReview((s) => s.archived));
  useRootClass("sheet-open", useReview((s) => s.sheetOpen));
  useSheetEscape();
  useHighlightSync();
  useFrameMessages();
  // On a wide screen History lies over the notes, the queue and the composer: what is covered takes no focus.
  const covered = useCovered();
  return (
    <TooltipProvider>
      <a className="skip-link" href="#content">
        Skip to the page
      </a>
      <div className="app">
        <header className="bar">
          <div className="bar-start">
            {OWNER_BAR ? (
              <a className="bar-home" href="/" aria-label="Back to the hub" title="Back to the hub">
                <ShapeIcon shapes={LOGO} size={24} />
              </a>
            ) : null}
            <TitleBlock />
          </div>
          <div className="bar-right">
            <ChangesButton />
            <span className="viewers" role="group" aria-label="On this page" hidden />
            {OWNER ? <AttachPill /> : null}
            <PresencePill />
            {OWNER ? <ShareButton /> : null}
            {OWNER_BAR ? (
              <button
                type="button"
                className="icon-btn goto-btn"
                aria-label="Go to page (Ctrl K)"
                title="Go to page (Ctrl K)"
              >
                <Icon name="search" size={16} width={1.8} />
              </button>
            ) : null}
            <MoreMenu />
          </div>
        </header>
        <Banner />
        {OWNER ? <OwnerEffects /> : null}
        {OWNER ? <Dialogs /> : null}
        <Notice />
        {OWNER ? <SinceBar /> : null}
        <div className="main">
          <section className="stage" id="content" tabIndex={-1} aria-label="Page under review">
            <div className="subbar">
              <ModeSwitch />
              <div className="subbar-end">
                {OWNER ? <Revision /> : null}
                {OWNER ? <HistoryButton /> : null}
              </div>
              <Dock />
            </div>
            <Frame />
          </section>
          <Scrim />
          <aside className="panel" aria-label="Review panel">
            <PanelHead />
            <Log inert={covered} />
            <Queue inert={covered} />
            <Composer inert={covered} />
            <HostedFoot />
          </aside>
          {OWNER ? <HistoryPanel /> : null}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Draws the page into the body, at once: the code that boots after this finds the markup there. */
export function mountApp(): void {
  const root = createRoot(document.body);
  flushSync(() => root.render(<App />));
}
