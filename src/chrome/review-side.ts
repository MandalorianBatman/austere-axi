// The data behind the review page's projects sidebar (review-sidebar.tsx): the hub's projects and pages, and which
// projects are folded (the same list the hub keeps, side-state.ts). Owner on the local server only.
import { create } from "zustand";
import type {
  PagesResponse,
  ProjectSummary,
  ProjectsResponse,
  SharedPage,
  SharedResponse,
  ShellPage,
} from "../shared/hub-api.ts";
import { ACCOUNT } from "./review-env.ts";
import { get } from "./hub-http.ts";
import type { SideStatus } from "./views.ts";
import { CLOSED_PROJECTS, store, stored } from "./side-state.ts";

interface SideState {
  projects: ProjectSummary[];
  pages: ShellPage[];
  closed: string[];
  status: SideStatus;
}

export const useSide = create<SideState>()(() => ({
  projects: [],
  pages: [],
  closed: stored<string[]>(CLOSED_PROJECTS, []),
  status: "loading",
}));

export function toggleClosed(id: string): void {
  const closed = new Set(useSide.getState().closed);
  if (!closed.delete(id)) closed.add(id);
  const next = [...closed];
  store(CLOSED_PROJECTS, next);
  useSide.setState({ closed: next });
}

/** The group of pages other accounts granted this one: a project in the sidebar, as the cloud's Shared view lists them. */
export const SHARED = "~shared";

function sharedPage(p: SharedPage): ShellPage {
  return {
    id: p.id,
    project_id: SHARED,
    project: "Shared with you",
    rel_path: p.title ? "" : p.id,
    title: p.title,
    updated_at: 0,
    activity: 0,
    open_id: p.id,
    copies: [],
    unanswered: 0,
    addressed: 0,
    held: 0,
    attach: "off",
    needs_you: false,
    changed: 0,
    failed: 0,
    waiting_on_agent: false,
    taker: null,
    run_active: false,
    group: "quiet",
  };
}

/** The pages shared with the signed-in account. A failure shows none: the account's own pages still list. */
async function loadShared(signal: AbortSignal): Promise<ShellPage[]> {
  if (!ACCOUNT) return [];
  try {
    return (await get<SharedResponse>("/hub/api/shared", signal)).pages.map(sharedPage);
  } catch {
    return [];
  }
}

/** Reads the lists again. A failure leaves the old ones and says so in `status`: the sidebar is a convenience, the review is the page. */
export async function loadSide(signal: AbortSignal): Promise<void> {
  try {
    const [p, pg, shared] = await Promise.all([
      get<ProjectsResponse>("/hub/api/projects", signal),
      get<PagesResponse>("/hub/api/pages", signal),
      loadShared(signal),
    ]);
    const group: ProjectSummary[] = shared.length
      ? [
          {
            id: SHARED,
            name: "Shared with you",
            roots: [],
            same_as: null,
            pages: shared.length,
            unanswered: 0,
            needs_you: 0,
          },
        ]
      : [];
    if (!signal.aborted)
      useSide.setState({
        projects: [...p.projects, ...group],
        pages: [...pg.pages, ...shared],
        status: "ready",
      });
  } catch {
    // not signed in as the owner, or the server is gone: the sidebar keeps what it had
    if (!signal.aborted) useSide.setState({ status: "error" });
  }
}
