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
import { ProjectsSidebar } from "./projects-sidebar.tsx";
import { SettingsView } from "./settings.tsx";
import { useSidebarOpen } from "./side-state.ts";
import { VIEWS, go, start, toUrl, toggleProject, useHub } from "./hub-store.ts";
import { Toaster } from "@/chrome/ui/sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/chrome/ui/sidebar";
import { HubDialogs } from "./hub-dialog.tsx";
import { Button } from "@/chrome/ui/button";

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

function useCounts(): { needsYou: number; waiting: number } {
  const needsYou = useHub((s) => s.projects.reduce((n, p) => n + p.needs_you, 0));
  const waiting = useHub((s) => s.waitingPeople);
  return { needsYou, waiting };
}

const needsTitle = (n: number): string => `${plural(n, "page needs", "pages need")} you`;
const waitingTitle = (n: number): string => `${plural(n, "person asks", "people ask")} for access`;

/** The views in the sidebar (hidden on a phone, where the tab bar has them). */
function ViewMenu(): ReactElement {
  const state = useHub((s) => s.state);
  const { needsYou, waiting } = useCounts();
  return (
    <SidebarMenu className="views" aria-label="Views">
      {VIEWS.map((v) => {
        const n = v.id === "inbox" ? needsYou : v.id === "settings" ? waiting : 0;
        return (
          <SidebarMenuItem key={v.id}>
            <SidebarMenuButton asChild isActive={state.view === v.id}>
              <a
                href={toUrl({ ...state, view: v.id })}
                data-view={v.id}
                aria-current={state.view === v.id ? "page" : undefined}
                onClick={(e) => go(e, { view: v.id })}
              >
                <Icon name={v.icon} />
                <span className="label">{v.label}</span>
              </a>
            </SidebarMenuButton>
            {n ? (
              <SidebarMenuBadge
                className="count need rounded-full bg-[var(--amber-pill)] px-2 text-[var(--amber)]"
                title={v.id === "inbox" ? needsTitle(n) : waitingTitle(n)}
              >
                {n}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/** Phones: the views as a tab bar along the bottom; the drawer keeps search and projects. */
function TabBar(): ReactElement {
  const state = useHub((s) => s.state);
  const { needsYou, waiting } = useCounts();
  return (
    <nav className="tabbar" aria-label="Views">
      {VIEWS.map((v) => {
        const n = v.id === "inbox" ? needsYou : v.id === "settings" ? waiting : 0;
        return (
          <a
            key={v.id}
            href={toUrl({ ...state, view: v.id })}
            data-view={v.id}
            aria-current={state.view === v.id ? "page" : undefined}
            onClick={(e) => go(e, { view: v.id })}
          >
            <Icon name={v.icon} size={20} width={1.8} />
            <span className="label">{v.label}</span>
            {n ? (
              <span
                className="count need"
                title={v.id === "inbox" ? needsTitle(n) : waitingTitle(n)}
              >
                {n}
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
      <div className="relative">
        <Icon
          name="search"
          size={15}
          width={1.8}
          cls="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
        />
        <SidebarInput
          ref={(el: HTMLInputElement | null) => {
            if (el && focusSearchNext) {
              focusSearchNext = false;
              el.focus();
            }
          }}
          type="search"
          name="q"
          className="pl-8"
          value={text}
          placeholder="Search pages, parts"
          aria-label="Search pages and parts"
          autoComplete="off"
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
      </div>
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

/**
 * The drawer follows navigation: it closes when the view or filter changes, and focus goes back to the toggle
 * (Radix has no trigger to return it to).
 */
function DrawerWatch(): null {
  const { openMobile, setOpenMobile } = useSidebar();
  const state = useHub((s) => s.state);
  const seen = useRef(state);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    setOpenMobile(false);
  }, [state, setOpenMobile]);
  useEffect(() => {
    const closed = wasOpen.current && !openMobile;
    const inside = !!document.activeElement?.closest('[data-mobile="true"]');
    wasOpen.current = openMobile;
    if (!closed) return;
    // Radix unmounts the Sheet after its exit animation, and only then does focus fall to <body>.
    // Wait for the Sheet to leave the DOM, then give focus back to the toggle (if it had been inside).
    let frame = 0;
    let tries = 0;
    const settle = (): void => {
      if (document.querySelector('[data-mobile="true"]') && tries++ < 120) {
        frame = requestAnimationFrame(settle);
        return;
      }
      if (!document.activeElement || document.activeElement === document.body)
        document.querySelector<HTMLElement>(".side-toggle")?.focus();
    };
    if (inside || !document.activeElement || document.activeElement === document.body)
      frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [openMobile]);
  return null;
}

/** The top bar: the sidebar's toggle (Ctrl+B too), and on a narrow screen a way to its search. */
function TopBar(): ReactElement {
  const { isMobile, setOpenMobile, openMobile } = useSidebar();
  return (
    <header className="top sticky top-0 z-5 flex items-center justify-between gap-2 border-b bg-background px-3 py-1.5 md:border-b-0">
      <SidebarTrigger
        className="side-toggle"
        aria-controls="side"
        aria-label="Toggle the sidebar"
      />
      {isMobile ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="top-search"
          aria-label="Search pages and parts"
          onClick={() => {
            focusSearchNext = !openMobile;
            setOpenMobile(true);
          }}
        >
          <Icon name="search" size={20} width={1.8} />
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
  const side = useSidebarOpen();

  useEffect(() => {
    const label =
      state.view === "search" ? "Search" : VIEWS.find((v) => v.id === state.view)?.label;
    document.title = `${label} · austere-axi hub`;
  }, [state.view]);

  return (
    <SidebarProvider className="hub" {...side}>
      <Sidebar id="side" aria-label="Projects and views" className="side">
        <SidebarHeader className="gap-3 p-3">
          <div className="brand flex items-center gap-2.5 px-2">
            <LogoMark />
            <a href="/?view=inbox" className="flex-1 text-sm font-semibold text-foreground">
              austere-axi
            </a>
            <small className="font-mono text-[11px] text-[var(--faint)]">{BOOT.version}</small>
          </div>
          <SearchBox />
        </SidebarHeader>
        <SidebarContent className="px-1">
          <ViewMenu />
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
        </SidebarContent>
      </Sidebar>
      <DrawerWatch />
      <SidebarInset className="main min-w-0">
        <TopBar />
        <div className="content" id="content" tabIndex={-1}>
          <Content />
        </div>
        <TabBar />
      </SidebarInset>
      <Toaster theme="dark" position="bottom-right" />
      <HubDialogs />
    </SidebarProvider>
  );
}

const container = document.createElement("div");
container.style.display = "contents";
document.body.append(container);
start();
createRoot(container).render(<Hub />);
