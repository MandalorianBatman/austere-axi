// The review page: the artifact frame and, beside it, the conversation panel. Panels read the store (review-store.ts).
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { ShapeIcon } from "./icon.tsx";
import type { Shape } from "./icons.ts";
import { HOSTED, OWNER } from "./review-env.ts";
import { AttachPill } from "./review-attach.tsx";
import { useAttachFeed } from "./review-attach.ts";
import { useBanner } from "./review-banner.ts";
import { PanelBoundary } from "./review-boundary.tsx";
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
import { useNarrow, useRootClass } from "./review-hooks.ts";
import { Log } from "./review-log.tsx";
import { GotoButton, OwnerNav } from "./review-nav.tsx";
import { setViewers } from "./review-presence.ts";
import { Queue } from "./review-queue.tsx";
import { Dock, PanelHead, useCovered } from "./review-tabs.tsx";
import { setSheet, useReview } from "./review-store.ts";
import { Frame, HostedFoot, ModeSwitch, MoreMenu, Notice, TitleBlock } from "./review-viewer.tsx";
import { ReviewSidebar, SideData } from "./review-sidebar.tsx";
import { useSidebarOpen } from "./side-state.ts";
import { Button } from "@/chrome/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/chrome/ui/sheet";
import { SidebarProvider, SidebarTrigger } from "@/chrome/ui/sidebar";
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

/** The review header needs about 900 px of its own: under this width the sidebar is a sheet over the page, not a column. */
const SHEET_BELOW = 1100;

/** The owner's page sits beside the projects sidebar (wide: it pushes the page; narrow: a sheet over it). */
function WithSidebar({ children }: { children: ReactElement }): ReactElement {
  const side = useSidebarOpen(false);
  return (
    <SidebarProvider className="review-shell min-h-0" breakpoint={SHEET_BELOW} {...side}>
      <PanelBoundary name="The projects sidebar">
        <SideData />
        <ReviewSidebar />
      </PanelBoundary>
      {children}
    </SidebarProvider>
  );
}

function App(): ReactElement {
  useRootClass(
    "is-archived",
    useReview((s) => s.archived),
  );
  useHighlightSync();
  useFrameMessages();
  // On a wide screen History lies over the notes, the queue and the composer: what is covered takes no focus.
  const covered = useCovered();
  const narrow = useNarrow();
  // Explore hides the conversation, and so the sheet with it.
  const sheetOpen = useReview((s) => s.sheetOpen && s.mode !== "explore");
  const history = OWNER ? (
    <PanelBoundary name="The history">
      <HistoryPanel />
    </PanelBoundary>
  ) : null;
  const panel = (
    <>
      <PanelBoundary name="The panel tabs">
        <PanelHead />
      </PanelBoundary>
      <PanelBoundary name="The conversation">
        <Log inert={covered} />
      </PanelBoundary>
      <PanelBoundary name="The queue">
        <Queue inert={covered} />
      </PanelBoundary>
      <PanelBoundary name="The note box">
        <Composer inert={covered} />
      </PanelBoundary>
      <PanelBoundary name="The page footer">
        <HostedFoot />
      </PanelBoundary>
    </>
  );
  const page = (
    <>
      <div className="app">
        <header className="bar">
          <div className="bar-start">
            {OWNER_BAR ? (
              <SidebarTrigger
                className="side-toggle size-9 flex-none"
                aria-controls="side"
                aria-label="Toggle the projects sidebar (Ctrl/⌘ B)"
                title="Toggle the projects sidebar (Ctrl/⌘ B)"
              />
            ) : null}
            {OWNER_BAR ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="bar-home size-9 flex-none [&_svg]:size-6"
                title="Back to the hub"
              >
                <a href="/" aria-label="Back to the hub">
                  <ShapeIcon shapes={LOGO} size={24} />
                </a>
              </Button>
            ) : null}
            <PanelBoundary name="The page title">
              <TitleBlock />
            </PanelBoundary>
          </div>
          <div className="bar-right">
            <PanelBoundary name="The page bar">
              <ChangesButton />
              <span
                className="viewers"
                role="group"
                aria-label="On this page"
                ref={setViewers}
                hidden
              />
              {OWNER ? <AttachPill /> : null}
              <PresencePill />
              {OWNER ? <ShareButton /> : null}
              {OWNER_BAR ? <GotoButton /> : null}
              <MoreMenu />
            </PanelBoundary>
          </div>
        </header>
        <PanelBoundary name="The banner">
          <Banner />
        </PanelBoundary>
        {OWNER ? (
          <PanelBoundary name="The page's live feeds">
            <OwnerEffects />
          </PanelBoundary>
        ) : null}
        {OWNER ? (
          <PanelBoundary name="The dialogs">
            <Dialogs />
          </PanelBoundary>
        ) : null}
        {OWNER_BAR ? (
          <PanelBoundary name="The page switcher">
            <OwnerNav />
          </PanelBoundary>
        ) : null}
        <PanelBoundary name="The pack notice">
          <Notice />
        </PanelBoundary>
        {OWNER ? (
          <PanelBoundary name="The changes since you looked">
            <SinceBar />
          </PanelBoundary>
        ) : null}
        <div className="main">
          <section className="stage" id="content" tabIndex={-1} aria-label="Page under review">
            <div className="subbar">
              <PanelBoundary name="The mode switch">
                <ModeSwitch />
                <div className="subbar-end">
                  {OWNER ? <Revision /> : null}
                  {OWNER ? <HistoryButton /> : null}
                </div>
              </PanelBoundary>
              <PanelBoundary name="The dock">
                <Dock />
              </PanelBoundary>
            </div>
            <PanelBoundary name="The page">
              <Frame />
            </PanelBoundary>
          </section>
          {narrow ? (
            // A phone: the notes are a bottom sheet. Closed, it is not in the page at all; open, it holds focus.
            <Sheet open={sheetOpen} onOpenChange={setSheet}>
              <SheetContent
                side="bottom"
                showCloseButton={false}
                id="notes-sheet"
                className="panel"
                aria-describedby={undefined}
                onCloseAutoFocus={(ev) => {
                  ev.preventDefault();
                  document.querySelector<HTMLElement>(".dock")?.focus();
                }}
              >
                <SheetTitle className="sr-only">Review notes</SheetTitle>
                {panel}
                {/* History is a popover over the page: while the sheet holds focus it has to live inside it. */}
                {sheetOpen ? history : null}
              </SheetContent>
            </Sheet>
          ) : (
            <aside className="panel" aria-label="Review panel">
              {panel}
            </aside>
          )}
          {narrow && sheetOpen ? null : history}
        </div>
      </div>
    </>
  );
  return (
    <TooltipProvider>
      {/* First in the document, so it is the first Tab stop whatever the sidebar holds. */}
      <a className="skip-link" href="#content">
        Skip to the page
      </a>
      {OWNER_BAR ? <WithSidebar>{page}</WithSidebar> : page}
    </TooltipProvider>
  );
}

/** Draws the page into the body, at once: the code that boots after this finds the markup there. */
export function mountApp(): void {
  const root = createRoot(document.body);
  // The panels have their own boundaries; this one is for what is left (the hooks of App, the tooltip provider).
  flushSync(() =>
    root.render(
      <PanelBoundary name="The review page">
        <App />
      </PanelBoundary>,
    ),
  );
}
