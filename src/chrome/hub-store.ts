// The hub's view state in one store (zustand): which view and filters the URL names, the sidebar's data, the
// status line. URL sync is here too: `go` pushes the URL, `popstate` reads it back. Views load their own data
// in effects (hub-load.ts) and read again when `version` moves.
import { create } from "zustand";
import type { AccessRequestsResponse } from "../cli/server.ts";
import type {
  PagesResponse,
  PagesView,
  ProjectSummary,
  ProjectsResponse,
  ShellPage,
} from "../shared/hub-api.ts";
import { CLOUD_VIEWS, isView } from "./views.ts";
import type { SideStatus, View } from "./views.ts";
import { CLOUD } from "./hub-env.ts";
import { get } from "./hub-http.ts";
import { CLOSED_PROJECTS, store, stored } from "./side-state.ts";

/** The view the hub opened on last (RLM-358). */
const LAST_VIEW = "austere:hub:view";

/** The view the hub opens on with no other say: the inbox, and on austere-cloud (no inbox) the pages. */
const HOME: View = CLOUD ? "pages" : "inbox";
const views = CLOUD ? CLOUD_VIEWS : undefined;

export interface State {
  view: View;
  /** `?project=`: a project's name, id or folder; "" for every project. */
  project: string;
  pagesView: PagesView;
  /** The search (view search) or the notes filter (view notes). */
  q: string;
  status: string;
  author: string;
  device: string;
}

function fromUrl(): State {
  const p = new URLSearchParams(location.search);
  const asked = p.get("view");
  const pagesView: PagesView = p.has("all") ? "all" : p.has("archived") ? "archived" : "open";
  let view: View;
  if (asked === "search" || isView(asked, views)) view = asked;
  // Links from before the shell: `/?q=…` searched, `/?all=1` and `/?archived=1` were the page lists.
  else if (p.get("q")) view = "search";
  else if (pagesView !== "open") view = "pages";
  else {
    const last = stored<string>(LAST_VIEW, HOME);
    view = isView(last, views) ? last : HOME;
  }
  return {
    view,
    project: p.get("project") || "",
    pagesView,
    q: p.get("q") || "",
    status: p.get("status") || "",
    author: p.get("author") || "",
    device: p.get("device") || "",
  };
}

export function toUrl(s: State): string {
  const p = new URLSearchParams();
  p.set("view", s.view);
  if (s.project) p.set("project", s.project);
  if (s.view === "pages" && s.pagesView !== "open") p.set(s.pagesView, "1");
  if ((s.view === "search" || s.view === "notes") && s.q) p.set("q", s.q);
  if (s.view === "notes") {
    if (s.status) p.set("status", s.status);
    if (s.author) p.set("author", s.author);
    if (s.device) p.set("device", s.device);
  }
  return `/?${p}`;
}

interface Hub {
  state: State;
  /** The view search returns to when its box is emptied. */
  previous: View;
  projects: ProjectSummary[];
  sidePages: ShellPage[];
  /** Whether the sidebar's lists have been read, are on their way, or could not be. */
  sideStatus: SideStatus;
  /** Access requests waiting for the owner (RLM-398): a count on Settings. */
  waitingPeople: number;
  /** Projects the owner folded: they show their pages until then. */
  closedProjects: string[];
  /** Moves when every view should read again. */
  version: number;
}

const initial = fromUrl();

export const useHub = create<Hub>(() => ({
  state: initial,
  previous: initial.view === "search" ? HOME : initial.view,
  projects: [],
  sidePages: [],
  sideStatus: "loading",
  waitingPeople: 0,
  closedProjects: stored<string[]>(CLOSED_PROJECTS, []),
  version: 0,
}));

const set = useHub.setState;
const read = useHub.getState;

type ClickLike = {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  button: number;
  preventDefault(): void;
};

/** Move to another view or filter; `e`: the click that asked, whose default this replaces. */
export function go(e: ClickLike | null, next: Partial<State>, push = true): void {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return;
  e?.preventDefault();
  const now = read();
  let state = { ...now.state, ...next };
  if (next.view && next.view !== "notes" && next.view !== "search")
    state = { ...state, q: "", status: "", author: "", device: "" };
  if (state.view !== "search") store(LAST_VIEW, state.view);
  if (push) history.pushState(null, "", toUrl(state));
  else history.replaceState(null, "", toUrl(state));
  set({
    state,
    previous: now.state.view === "search" ? now.previous : now.state.view,
  });
}

export function toggleProject(id: string): void {
  const closed = new Set(read().closedProjects);
  if (closed.has(id)) closed.delete(id);
  else closed.add(id);
  const closedProjects = [...closed];
  store(CLOSED_PROJECTS, closedProjects);
  set({ closedProjects });
}

let sideLoad: AbortController | null = null;

/** The sidebar's data. A newer read drops an older one that is still on its way. */
export async function loadSide(): Promise<void> {
  sideLoad?.abort();
  const mine = (sideLoad = new AbortController());
  try {
    const [p, pages, asks] = await Promise.all([
      get<ProjectsResponse>("/hub/api/projects", mine.signal),
      get<PagesResponse>("/hub/api/pages", mine.signal),
      // Access requests are the local server's: the cloud has none.
      CLOUD
        ? { waiting: [] }
        : get<AccessRequestsResponse>("/hub/api/people/requests", mine.signal),
    ]);
    if (mine.signal.aborted) return;
    set({
      projects: p.projects,
      sidePages: pages.pages,
      sideStatus: "ready",
      waitingPeople: asks.waiting.length,
    });
  } catch {
    if (!mine.signal.aborted) set({ sideStatus: "error" });
  }
}

/** Read the open view and the sidebar again (a change was made; the owner came back to the tab). */
export function reload(): void {
  set((s) => ({ version: s.version + 1 }));
  void loadSide();
}

/** Start syncing with the URL and the tab. Returns what undoes it. */
export function start(): () => void {
  history.replaceState(null, "", toUrl(read().state));
  if (read().state.view !== "search") store(LAST_VIEW, read().state.view);
  const onPop = (): void => set({ state: fromUrl() });
  const onVisible = (): void => {
    // Pages change while the tab sits in the background.
    if (document.visibilityState === "visible") reload();
  };
  window.addEventListener("popstate", onPop);
  document.addEventListener("visibilitychange", onVisible);
  void loadSide();
  return () => {
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("visibilitychange", onVisible);
    sideLoad?.abort();
  };
}
