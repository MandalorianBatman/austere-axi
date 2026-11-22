// The hub shell (RLM-357): the owner's home page, a small client app over /hub/api (src/cli/hub-api.ts).
// A sidebar of projects and their pages; the views Inbox (default) · Pages · Notes · Runs · Settings (settings.tsx);
// search over pages and parts. React over one store (hub-store.ts); every text is a React text node. The
// server answers only the owner (the cookie); this page holds no secret of its own.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement, RefObject } from "react";
import { createRoot } from "react-dom/client";
import { plural } from "./format.ts";
import { BOOT } from "./hub-env.ts";
import { InboxView, NotesView, PagesView, RunsView, SearchView } from "./hub-views.tsx";
import { Icon } from "./icon.tsx";
import { ProjectsSidebar } from "./projects-sidebar.tsx";
import { SettingsView } from "./settings.tsx";
import { VIEWS, go, setSide, start, toUrl, toggleProject, useHub } from "./hub-store.ts";
import type { Status } from "./hub-store.ts";

/** The austere-axi mark beside the name: decorative, the name beside it is the link's text. */
function LogoMark(): ReactElement {
  return (
    <svg className="logo" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
      <rect className="logo-ground" width="32" height="32" rx="7" />
      <rect className="logo-edge" x="1" y="1" width="30" height="30" rx="6" />
      <path className="logo-a" d="M9 23 16 8l7 15M11.5 18h9" />
    </svg>
  );
}

const narrowQuery = window.matchMedia("(max-width: 860px)");
const subscribeNarrow = (cb: () => void): (() => void) => {
  narrowQuery.addEventListener("change", cb);
  return () => narrowQuery.removeEventListener("change", cb);
};
const isNarrow = (): boolean => narrowQuery.matches;

/** The views, for the sidebar (`tab` false) or the phone tab bar. */
function ViewLinks({ tab }: { tab: boolean }): ReactElement {
  const state = useHub((s) => s.state);
  const needsYou = useHub((s) => s.projects.reduce((n, p) => n + p.needs_you, 0));
  const waiting = useHub((s) => s.waitingPeople);
  return (
    <>
      {VIEWS.map((v) => (
        <a
          key={v.id}
          href={toUrl({ ...state, view: v.id })}
          data-view={v.id}
          aria-current={state.view === v.id ? "page" : undefined}
          onClick={(e) => go(e, { view: v.id })}
        >
          <Icon name={v.icon} {...(tab ? { size: 20, width: 1.8 } : {})} />
          <span className="label">{v.label}</span>
          {v.id === "inbox" && needsYou ? (
            <span
              className="count need"
              title={`${plural(needsYou, "page needs", "pages need")} you`}
            >
              {needsYou}
            </span>
          ) : null}
          {v.id === "settings" && waiting ? (
            <span
              className="count need"
              title={`${plural(waiting, "person asks", "people ask")} for access`}
            >
              {waiting}
            </span>
          ) : null}
        </a>
      ))}
    </>
  );
}

/** The sidebar's search: a pause in typing searches; emptying the box goes back to the view before it. */
function SearchBox({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }): ReactElement {
  const searching = useHub((s) => s.state.view === "search");
  const q = useHub((s) => s.state.q);
  const shown = searching ? q : "";
  const [text, setText] = useState(shown);
  const [seen, setSeen] = useState(shown);
  const timer = useRef(0);
  // The URL decides what the box shows (a click on another view, Back).
  if (seen !== shown) {
    setSeen(shown);
    setText(shown);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        clearTimeout(timer.current);
        const asked = text.trim();
        if (asked) go(null, { view: "search", q: asked }, !searching);
      }}
    >
      <label className="search-box">
        <Icon name="search" size={15} width={1.8} />
        <input
          ref={inputRef}
          type="search"
          name="q"
          value={text}
          placeholder="Search pages and parts"
          aria-label="Search pages and parts"
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            const asked = e.target.value.trim();
            clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
              const { state, previous } = useHub.getState();
              if (asked) go(null, { view: "search", q: asked }, state.view !== "search");
              else if (state.view === "search") go(null, { view: previous, q: "" });
            }, 200);
          }}
        />
      </label>
    </form>
  );
}

/** A button of the status line: off while its request runs. */
function StatusAction({ action }: { action: NonNullable<Status["action"]> }): ReactElement {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn tiny"
      disabled={busy}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await action.onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {action.label}
    </button>
  );
}

function StatusLine(): ReactElement {
  const status = useHub((s) => s.status);
  return (
    <div className="status" role="status" aria-live="polite">
      {status ? (
        <>
          <span>{status.text}</span>
          {status.action ? <StatusAction action={status.action} /> : null}
        </>
      ) : null}
    </div>
  );
}

function Content(): ReactElement | null {
  const view = useHub((s) => s.state.view);
  switch (view) {
    case "inbox":
      return <InboxView />;
    case "pages":
      return <PagesView />;
    case "notes":
      return <NotesView />;
    case "runs":
      return <RunsView />;
    case "settings":
      return <SettingsView />;
    case "search":
      return <SearchView />;
  }
}

function Hub(): ReactElement {
  const state = useHub((s) => s.state);
  const projects = useHub((s) => s.projects);
  const sidePages = useHub((s) => s.sidePages);
  const closedProjects = useHub((s) => s.closedProjects);
  const sideOpen = useHub((s) => s.sideOpen);
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);
  const searchInput = useRef<HTMLInputElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const aside = useRef<HTMLElement>(null);
  const wantSearch = useRef(false);

  useEffect(() => {
    const label =
      state.view === "search" ? "Search" : VIEWS.find((v) => v.id === state.view)?.label;
    document.title = `${label} · austere-axi hub`;
  }, [state.view]);

  // The drawer: `html.side-open` is what hub-narrow.css reads; closed on a narrow screen it is out of Tab order too.
  useEffect(() => {
    document.documentElement.classList.toggle("side-open", sideOpen);
    if (!sideOpen) return;
    if (wantSearch.current) searchInput.current?.focus();
    else {
      // On a phone the views live in the tab bar, not the drawer: then focus starts at the top of the drawer.
      const view = aside.current?.querySelector<HTMLElement>(".views a");
      (view && view.getClientRects().length
        ? view
        : aside.current?.querySelector<HTMLElement>(".brand a")
      )?.focus();
    }
    wantSearch.current = false;
  }, [sideOpen]);
  useEffect(() => {
    if (!sideOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setSide(false);
      toggleButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sideOpen]);

  return (
    <div className="hub">
      <aside
        ref={aside}
        className="side"
        id="side"
        aria-label="Projects and views"
        inert={narrow && !sideOpen}
      >
        <div className="brand">
          <LogoMark />
          <a href="/?view=inbox">austere-axi</a>
          <small>{BOOT.version}</small>
        </div>
        <SearchBox inputRef={searchInput} />
        <nav className="views" aria-label="Views">
          <ViewLinks tab={false} />
        </nav>
        <ProjectsSidebar
          projects={projects}
          pages={sidePages}
          selected={state.project}
          collapsed={closedProjects}
          projectHref={(id) => toUrl({ ...state, project: id })}
          allHref={toUrl({ ...state, project: "" })}
          onSelect={(e, id) => go(e, { project: id })}
          onToggle={toggleProject}
        />
      </aside>
      <div className="scrim" onClick={() => setSide(false)} />
      <div className="main">
        {/* Narrow screens only: the drawer's toggle, and a way to its search. */}
        <header className="top">
          <button
            ref={toggleButton}
            type="button"
            className="side-toggle"
            aria-controls="side"
            aria-expanded={sideOpen}
            onClick={() => setSide(!sideOpen)}
          >
            <Icon name="menu" size={18} />
            <span className="side-toggle-text">Projects</span>
          </button>
          <button
            type="button"
            className="top-search"
            aria-label="Search pages and parts"
            onClick={() => {
              wantSearch.current = true;
              if (sideOpen) {
                searchInput.current?.focus();
                wantSearch.current = false;
              } else setSide(true);
            }}
          >
            <Icon name="search" size={20} width={1.8} />
          </button>
        </header>
        <StatusLine />
        <main className="content" id="content" tabIndex={-1}>
          <Content />
        </main>
        {/* Phones: the views as a tab bar along the bottom; the drawer keeps search and projects. */}
        <nav className="tabbar" aria-label="Views">
          <ViewLinks tab />
        </nav>
      </div>
    </div>
  );
}

const container = document.createElement("div");
container.style.display = "contents";
document.body.append(container);
start();
createRoot(container).render(<Hub />);
