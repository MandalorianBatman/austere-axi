// The data behind the review page's projects sidebar (review-sidebar.tsx): the hub's projects and pages, and which
// projects are folded (the same list the hub keeps, side-state.ts). Owner on the local server only.
import { create } from "zustand";
import type {
  PagesResponse,
  ProjectSummary,
  ProjectsResponse,
  ShellPage,
} from "../shared/hub-api.ts";
import { get } from "./hub-http.ts";
import { CLOSED_PROJECTS, store, stored } from "./side-state.ts";

interface SideState {
  projects: ProjectSummary[];
  pages: ShellPage[];
  closed: string[];
}

export const useSide = create<SideState>()(() => ({
  projects: [],
  pages: [],
  closed: stored<string[]>(CLOSED_PROJECTS, []),
}));

export function toggleClosed(id: string): void {
  const closed = new Set(useSide.getState().closed);
  if (!closed.delete(id)) closed.add(id);
  const next = [...closed];
  store(CLOSED_PROJECTS, next);
  useSide.setState({ closed: next });
}

/** Reads the lists again. A failure leaves the old ones: the sidebar is a convenience, the review is the page. */
export async function loadSide(signal: AbortSignal): Promise<void> {
  try {
    const [p, pg] = await Promise.all([
      get<ProjectsResponse>("/hub/api/projects", signal),
      get<PagesResponse>("/hub/api/pages", signal),
    ]);
    if (!signal.aborted) useSide.setState({ projects: p.projects, pages: pg.pages });
  } catch {
    // not signed in as the owner, or the server is gone: the sidebar stays as it was
  }
}
