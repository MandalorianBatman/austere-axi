// The hub shell (RLM-357): the owner's home page, a small client app over /hub/api (src/cli/hub-api.ts).
// A sidebar of projects and their pages; the views Inbox (default) · Pages · Notes · Runs · Settings (settings.tsx);
// search over pages and parts. React over one store (hub-store.ts), shadcn's Sidebar for the frame, toasts
// for what a change says. The server answers only the owner (the cookie); this page holds no secret of its own.
import "./zod-jitless.ts";
import { useEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import { createRoot } from "react-dom/client";
import { plural } from "./format.ts";
import { BOOT } from "./hub-env.ts";
import { InboxView, NotesView, PagesView, RunsView, SearchView } from "./hub-views.tsx";
import { Icon } from "./icon.tsx";
import { AppSidebar, SearchField } from "./projects-sidebar.tsx";
import { SettingsView } from "./settings.tsx";
import { useSidebarOpen } from "./side-state.ts";
import { go, loadSide, start, toUrl, toggleProject, useHub } from "./hub-store.ts";
import { VIEWS } from "./views.ts";
import { Toaster } from "@/chrome/ui/sonner";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/chrome/ui/sidebar";
import { HubDialogs } from "./hub-dialog.tsx";
import { Button } from "@/chrome/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/chrome/ui/tooltip";

function useCounts(): { needsYou: number; waiting: number } {
  const needsYou = useHub((s) => s.projects.reduce((n, p) => n + p.needs_you, 0));
  const waiting = useHub((s) => s.waitingPeople);
  return { needsYou, waiting };
}

const needsTitle = (n: number): string => `${plural(n, "page needs", "pages need")} you`;
const waitingTitle = (n: number): string => `${plural(n, "person asks", "people ask")} for access`;

/** Phones: the views as a tab bar along the bottom; the drawer keeps search and projects. */
function TabBar(): ReactElement {
  const state = useHub((s) => s.state);
  const { needsYou, waiting } = useCounts();
  return (
    <nav
      aria-label="Views"
      className="fixed inset-x-0 bottom-0 z-15 hidden border-t border-[var(--line)] bg-[var(--bg-2)] px-1.5 pt-1.5 pb-[calc(var(--spacing)*2.5+env(safe-area-inset-bottom))] max-xs:flex"
    >
      {VIEWS.map((v) => {
        const n = v.id === "inbox" ? needsYou : v.id === "settings" ? waiting : 0;
        return (
          <a
            key={v.id}
            href={toUrl({ ...state, view: v.id })}
            data-view={v.id}
            aria-current={state.view === v.id ? "page" : undefined}
            onClick={(e) => go(e, { view: v.id })}
            className="group relative flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md text-2xs font-medium text-muted-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
          >
            <Icon
              name={v.icon}
              size={20}
              width={1.8}
              cls="group-aria-[current=page]:text-primary"
            />
            <span className="label">{v.label}</span>
            {n ? (
              <span className="count need absolute top-1 left-[calc(50%+var(--spacing)*1.5)] min-w-5 rounded-full bg-[var(--amber-pill)] px-1 text-center text-2xs leading-4 font-semibold text-[var(--amber)]">
                <span aria-hidden="true">{n}</span>
                <span className="sr-only">
                  {v.id === "inbox" ? needsTitle(n) : waitingTitle(n)}
                </span>
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

/** Set by the top bar's search button: the search box takes focus once the drawer has drawn it. */
let focusSearchNext = false;

/** The sidebar's search: a pause in typing searches; emptying the box goes back to the view before it. */
function SearchBox(): ReactElement {
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
      <SearchField
        ref={(el: HTMLInputElement | null) => {
          if (el && focusSearchNext) {
            focusSearchNext = false;
            el.focus();
          }
        }}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const asked = e.target.value.trim();
          clearTimeout(timer.current);
          // A move to another view (a click, Back) before the pause is over cancels this search.
          const typedAt = useHub.getState().state;
          timer.current = window.setTimeout(() => {
            const { state, previous } = useHub.getState();
            if (state !== typedAt) return;
            if (asked) go(null, { view: "search", q: asked }, state.view !== "search");
            else if (state.view === "search") go(null, { view: previous, q: "" });
          }, 200);
        }}
      />
    </form>
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

/** The drawer follows navigation: it closes when the view or filter changes. (Focus goes back to the toggle: ui/sidebar.tsx.) */
function DrawerWatch(): null {
  const { setOpenMobile } = useSidebar();
  const state = useHub((s) => s.state);
  const seen = useRef(state);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    setOpenMobile(false);
  }, [state, setOpenMobile]);
  return null;
}

/** Apple platforms say ⌘ for the sidebar's shortcut; the others Ctrl. */
const SIDEBAR_KEYS =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    ? "⌘B"
    : "Ctrl+B";

/** The top bar: the sidebar's toggle (Ctrl+B too), and on a narrow screen a way to its search. */
function TopBar(): ReactElement {
  const { isMobile, setOpenMobile, openMobile } = useSidebar();
  return (
    <header className="top sticky top-0 z-5 flex items-center justify-between gap-2 border-b bg-background px-3 py-1.5 md:border-b-0">
      {/* No tooltip on a phone: the trigger is the drawer's toggle and the tooltip layer swallows the first Esc. */}
      <Tooltip open={isMobile ? false : undefined}>
        <TooltipTrigger asChild>
          <SidebarTrigger
            className="side-toggle"
            aria-controls="side"
            aria-label="Toggle the sidebar"
          />
        </TooltipTrigger>
        <TooltipContent>{`Toggle sidebar (${SIDEBAR_KEYS})`}</TooltipContent>
      </Tooltip>
      {isMobile ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="hover:bg-[var(--surface)]"
          aria-label="Search pages and parts"
          onClick={() => {
            focusSearchNext = !openMobile;
            setOpenMobile(true);
          }}
        >
          <Icon name="search" size={16} width={1.8} />
        </Button>
      ) : null}
    </header>
  );
}

function Hub(): ReactElement {
  const state = useHub((s) => s.state);
  const projects = useHub((s) => s.projects);
  const sidePages = useHub((s) => s.sidePages);
  const closedProjects = useHub((s) => s.closedProjects);
  const sideStatus = useHub((s) => s.sideStatus);
  const counts = useCounts();
  const side = useSidebarOpen(true);

  useEffect(() => {
    const label =
      state.view === "search" ? "Search" : VIEWS.find((v) => v.id === state.view)?.label;
    document.title = `${label} · austere-axi hub`;
  }, [state.view]);

  return (
    <SidebarProvider className="hub" {...side}>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <AppSidebar
        version={BOOT.version}
        view={state.view}
        viewHref={(v) => toUrl({ ...state, view: v })}
        onView={(e, v) => go(e, { view: v })}
        counts={{ inbox: counts.needsYou, settings: counts.waiting }}
        search={<SearchBox />}
        projects={{
          projects,
          pages: sidePages,
          selected: state.project,
          collapsed: closedProjects,
          projectHref: (id) => toUrl({ ...state, project: id }),
          allHref: toUrl({ ...state, project: "" }),
          onSelect: (e, id) => go(e, { project: id }),
          onToggle: toggleProject,
          status: sideStatus,
          onRetry: () => void loadSide(),
        }}
      />
      <DrawerWatch />
      <SidebarInset className="main min-w-0">
        <TopBar />
        <div
          className="content mx-auto w-full max-w-(--content-w) min-w-0 px-8 pt-8 pb-12 focus:outline-none max-md:px-4 max-md:pt-4 max-md:pb-12 max-xs:px-3 max-xs:pt-1 max-xs:pb-[calc(var(--tabbar-h)+var(--spacing)*6)]"
          id="content"
          tabIndex={-1}
        >
          <Content />
        </div>
        <TabBar />
      </SidebarInset>
      <Toaster
        theme="dark"
        position="bottom-right"
        mobileOffset={{ bottom: "calc(var(--tabbar-h) + var(--spacing) * 2)" }}
      />
      <HubDialogs />
    </SidebarProvider>
  );
}

const container = document.createElement("div");
container.style.display = "contents";
document.body.append(container);
start();
createRoot(container).render(<Hub />);
