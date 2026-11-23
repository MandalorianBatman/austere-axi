// The review page: the artifact frame and, beside it, the conversation panel. Panels read the store (review-store.ts).
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { Icon, ShapeIcon } from "./icon.tsx";
import type { Shape } from "./icons.ts";
import { BASE, HOSTED, OWNER } from "./review-env.ts";
import { useBanner } from "./review-banner.ts";
import { Composer } from "./review-composer.tsx";
import { Queue } from "./review-queue.tsx";
import { Button } from "@/chrome/ui/button";
import { TooltipProvider } from "@/chrome/ui/tooltip";

const DOTS: Shape[] = [5, 12, 19].map((cx): Shape => [
  "circle",
  { cx, cy: 12, r: 1.6, fill: "currentColor", stroke: "none" },
]);
const LINK: Shape[] = [
  ["path", { d: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" }],
  ["path", { d: "M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" }],
];
const LOGO: Shape[] = [
  ["rect", { x: 1.5, y: 1.5, width: 21, height: 21, rx: 5, className: "logo-box" }],
  ["path", { d: "M6.75 17.25 12 6l5.25 11.25M8.6 13.5h6.8", className: "logo-a" }],
];

// The owner's own controls: a hosted viewer, or a reviewer on the local server, has none of them (RLM-265, RLM-322).
const OWNER_BAR = OWNER && !HOSTED;

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

function App(): ReactElement {
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
            <div className="bar-title">
              <h1 className="title" />
              <span className="file" />
            </div>
          </div>
          <div className="bar-right">
            <button type="button" className="changes" aria-pressed="false" hidden />
            <span className="viewers" role="group" aria-label="On this page" hidden />
            {OWNER ? (
              <div className="attach">
                <button
                  type="button"
                  className="attach-pill"
                  aria-haspopup="dialog"
                  aria-expanded="false"
                  title="Attach an agent to this page"
                >
                  <span className="attach-dot" />
                  <span className="attach-label">
                    Agent: <span className="attach-detail">Off</span>
                    <span className="attach-short">Off</span>
                  </span>
                  <Icon name="chevronDown" size={12} width={2} cls="attach-caret" />
                </button>
                <span className="run-state" hidden />
              </div>
            ) : null}
            <span className="presence" />
            {OWNER ? (
              <button type="button" className="btn share-btn" title="A named link for one teammate's device">
                <ShapeIcon shapes={LINK} size={14} width={1.9} />
                Share
              </button>
            ) : null}
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
            <div className="menu">
              <button type="button" className="icon-btn menu-btn" aria-label="More">
                <ShapeIcon shapes={DOTS} size={16} />
              </button>
              <div className="menu-pop" hidden>
                {OWNER ? (
                  <button type="button" data-cmd="copy-path">
                    Copy file path
                  </button>
                ) : null}
                {OWNER || HOSTED ? (
                  <button type="button" data-cmd="copy-link" hidden={!!HOSTED}>
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
                  <div className="menu-note" data-share-note hidden>
                    Only the owner can share this page. To invite someone, they run
                    <code>austere-axi publish &lt;file&gt; --invite "Name"</code>which prints a link for that person.
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
                  <button type="button" data-cmd="export">
                    Download standalone HTML
                  </button>
                ) : OWNER ? (
                  <a data-cmd="export" href={`${BASE}/export`}>
                    Download standalone HTML
                  </a>
                ) : null}
                {OWNER ? (
                  <button type="button" data-cmd="archive">
                    Archive page
                  </button>
                ) : null}
                {OWNER ? (
                  <button type="button" data-cmd="unarchive">
                    Unarchive page
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </header>
        <Banner />
        <div className="notice" hidden />
        {OWNER ? (
          <div className="since" role="status" hidden>
            <span className="since-dot" aria-hidden="true" />
            <span className="since-text" />
            <button type="button" className="btn tiny" data-since="show" aria-pressed="false">
              Outline them
            </button>
            <button type="button" className="btn tiny ghost" data-since="history">
              History
            </button>
            <button type="button" className="icon-btn since-x" data-since="dismiss" aria-label="Dismiss">
              <Icon name="close" size={14} width={2} />
            </button>
          </div>
        ) : null}
        <div className="main">
          <section className="stage" id="content" tabIndex={-1} aria-label="Page under review">
            <div className="subbar">
              <div className="seg" role="group" aria-label="Mode">
                <button
                  type="button"
                  data-mode="annotate"
                  aria-pressed="false"
                  title="Click anything to comment on it (⌘/Ctrl+I)"
                >
                  <Icon name="annotate" size={14} width={1.9} />
                  <span className="seg-label">Annotate</span>
                </button>
                <button
                  type="button"
                  data-mode="explore"
                  aria-pressed="false"
                  title="Use the page normally: tabs, forms, links (⌘/Ctrl+I)"
                >
                  <Icon name="explore" size={14} width={1.9} />
                  <span className="seg-label">Explore</span>
                </button>
              </div>
              <span className="subbar-hint" />
              <div className="subbar-end">
                {OWNER ? <span className="rev" hidden /> : null}
                {OWNER ? (
                  <button
                    type="button"
                    className="btn ghost hist-btn"
                    aria-expanded="false"
                    title="Every version of this page, and what changed since you last looked"
                  >
                    <Icon name="clock" size={13} width={1.9} />
                    History
                  </button>
                ) : null}
              </div>
              <button type="button" className="dock" />
            </div>
            <iframe className="frame" title="Artifact" sandbox="allow-scripts allow-popups allow-forms" />
          </section>
          <div className="scrim" />
          <aside className="panel" aria-label="Review panel">
            <div className="panel-head">
              <div className="panel-tabs" role="group" aria-label="Review panel views">
                <button type="button" className="panel-tab" data-tab="notes" aria-current="true">
                  Notes <span className="tab-count" />
                </button>
                {OWNER ? (
                  <button type="button" className="panel-tab" data-tab="agent">
                    Agent <span className="tab-dot" role="img" aria-label="Agent not listening" />
                  </button>
                ) : null}
                {OWNER ? (
                  <button type="button" className="panel-tab" data-tab="history">
                    History
                  </button>
                ) : null}
              </div>
              <button type="button" className="icon-btn sheet-close" aria-label="Close the notes">
                <Icon name="chevronDown" size={20} width={2} />
              </button>
            </div>
            <div className="log" />
            <Queue />
            <Composer />
          </aside>
          {OWNER ? (
            <div className="hist" role="dialog" aria-label="History" hidden>
              <div className="hist-head">
                <span className="hist-title" />
                <button type="button" className="icon-btn hist-close" aria-label="Close">
                  <Icon name="close" size={16} width={1.8} />
                </button>
              </div>
              <div className="hist-body" />
            </div>
          ) : null}
          {OWNER ? <div className="attach-pop" role="dialog" aria-label="Agent on this page" hidden /> : null}
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
