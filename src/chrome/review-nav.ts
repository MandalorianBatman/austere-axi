// The owner's way between pages and the hub (RLM-358), in the review header only: the data and actions behind the
// breadcrumb, the copy switcher, the quick switcher (Ctrl/Cmd+K) and "Next page with unanswered notes". The markup is
// review-nav.tsx. Reviewers and hosted pages never load it; its routes (/hub/api/*) answer the owner only.
import { create } from "zustand";
import type { CopySummary, InboxResponse, SearchResponse, ShellPage } from "../shared/hub-api.ts";
import { flash } from "./review-banner.ts";
import { openAttach } from "./review-attach.ts";
import { post } from "./review-bridge.ts";
import { SID } from "./review-env.ts";

interface NavState {
  /** This page and its copies in other worktrees; null until the hub answers. */
  page: CopySummary | null;
  /** The quick switcher is open. */
  switcher: boolean;
}

export const useNav = create<NavState>()(() => ({ page: null, switcher: false }));

/** What had focus when the switcher opened: the dialog has no trigger, so it gives focus back to this. */
let returnFocus: Element | null = null;

export function openSwitcher(from?: Element | null): void {
  if (useNav.getState().switcher) return;
  returnFocus = from ?? document.activeElement;
  useNav.setState({ switcher: true });
}
export const closeSwitcher = (): void => useNav.setState({ switcher: false });
export const toggleSwitcher = (): void =>
  useNav.getState().switcher ? closeSwitcher() : openSwitcher();

/** The switcher has closed: focus what had it (the frame, a button, the ⋯ menu's button). */
export function restoreFocus(event: Event): void {
  event.preventDefault();
  if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  returnFocus = null;
}

/** The statement a search hit opened this page at, outlined once the frame has rendered. */
let part: string | null = null;

/** Read what the address says to do (`#part=` outlines a statement, `#attach` opens the agent popover), then drop it. */
export function startNav(): void {
  const fragment = new URLSearchParams(location.hash.slice(1));
  part = fragment.get("part");
  if (!fragment.has("part") && !fragment.has("attach")) return;
  const attach = fragment.has("attach");
  fragment.delete("part");
  fragment.delete("attach");
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ""}`,
  );
  if (attach) setTimeout(openAttach, 0);
}

/** The frame has rendered: outline the part a search hit named, once. */
export function frameReady(): void {
  if (!part) return;
  post({ type: "highlight", ids: [part], scroll: true });
  part = null;
}

/** A page the owner opened lately, newest first: what the quick switcher lists before anything is typed. */
export interface Recent {
  id: string;
  title: string;
  project: string;
  rel_path: string;
}

const RECENT = "austere:recent-pages";
export const RECENT_MAX = 12;

export function recents(): Recent[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT) || "[]");
    return Array.isArray(raw)
      ? raw
          .filter(
            (r): r is Recent =>
              !!r &&
              typeof r === "object" &&
              typeof r.id === "string" &&
              typeof r.title === "string",
          )
          .slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function remember(r: Recent): void {
  // One entry a page: a copy in another worktree replaces it.
  const list = [
    r,
    ...recents().filter(
      (x) => x.id !== r.id && !(x.project === r.project && x.rel_path === r.rel_path),
    ),
  ].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
    // private mode: no recents
  }
}

export const openUrl = (id: string, extra = ""): string => `/hub/open/${id}${extra}`;

/** Reads this page's summary from the hub, for the breadcrumb and the copy switcher, and files it under "opened lately". */
export async function loadPage(signal: AbortSignal): Promise<void> {
  try {
    const r = await fetch(`/hub/api/page/${SID}`, { signal });
    if (!r.ok) return;
    const page = (await r.json()) as CopySummary;
    useNav.setState({ page });
    remember({
      id: page.id,
      title: page.title || page.rel_path,
      project: page.project?.name ?? "",
      rel_path: page.rel_path,
    });
  } catch {
    // the server is gone: the crumb still links to the hub
  }
}

/** One row of the quick switcher. */
export interface Item {
  href: string;
  title: string;
  sub: string;
  kind: "recent" | "page" | "part";
  /** A part's statement id, shown as a mono chip before it. */
  chip?: string;
  /** A page's inbox group, as a dot before it. */
  state?: { tone: "needs" | "working" | "waiting" | "quiet"; label: string };
  /** What a page holds for the owner, on the row's right. */
  meta?: { text: string; changed?: boolean };
}

/** The switcher's groups, in the order its items come. */
export const GROUPS: [Item["kind"], string][] = [
  ["recent", "Opened lately"],
  ["page", "Pages"],
  ["part", "Parts of pages"],
];

function pageState(p: ShellPage): Item["state"] {
  if (p.group === "needs_you") return { tone: "needs", label: "Needs you" };
  // As the hub's Inbox: green only while an agent has the notes or is there to take them.
  if (p.group === "waiting_on_agent")
    return p.run_active
      ? { tone: "working", label: "Agent working" }
      : p.taker === "listening"
        ? { tone: "working", label: "Agent listening" }
        : { tone: "waiting", label: "Waiting on an agent" };
  return { tone: "quiet", label: "Quiet" };
}

function pageMeta(p: ShellPage): Item["meta"] {
  if (p.changed > 0) return { text: "Changed since you looked", changed: true };
  if (p.unanswered > 0) return { text: `${p.unanswered} unanswered` };
  return undefined;
}

/** What the switcher lists before anything is typed: the pages opened lately, this one left out. */
export function recentItems(): Item[] {
  return recents()
    .filter((r) => r.id !== SID)
    .map((r) => ({
      href: openUrl(r.id),
      title: r.title,
      sub: [r.project, r.rel_path].filter(Boolean).join(" / "),
      kind: "recent" as const,
    }));
}

/** Searches every page and part; null when the hub cannot be reached (the banner says so). */
export async function search(q: string, signal: AbortSignal): Promise<Item[] | null> {
  let data: SearchResponse;
  try {
    const r = await fetch(`/hub/api/search?q=${encodeURIComponent(q)}`, { signal });
    if (!r.ok) throw new Error(String(r.status));
    data = (await r.json()) as SearchResponse;
  } catch {
    if (!signal.aborted) flash("Could not reach austere-axi to search.");
    return null;
  }
  // Pages opened lately come first among the pages that match.
  const order = new Map(recents().map((r, i) => [`${r.project}\0${r.rel_path}`, i]));
  const rank = (key: string): number => order.get(key) ?? RECENT_MAX;
  const pages = [...data.pages].sort(
    (a, b) => rank(`${a.project}\0${a.rel_path}`) - rank(`${b.project}\0${b.rel_path}`),
  );
  return [
    ...pages.map((p): Item => ({
      href: openUrl(p.open_id),
      title: p.title || p.rel_path,
      sub: [p.project, p.rel_path].filter(Boolean).join(" / "),
      kind: "page",
      state: pageState(p),
      meta: pageMeta(p),
    })),
    ...data.parts.map((x): Item => {
      const page = x.title || x.file.split(/[\\/]/).pop() || x.file;
      return {
        href: openUrl(x.artifact_id, `?part=${encodeURIComponent(x.statement)}`),
        title: x.snippet || page,
        sub: [x.component, `in ${page}`, x.copy].filter(Boolean).join(" · "),
        kind: "part",
        chip: x.statement,
      };
    }),
  ];
}

/** Opens the next page in the hub's inbox with notes no agent answered, at the copy that has them. */
export async function nextUnanswered(): Promise<void> {
  let inbox: InboxResponse;
  try {
    const r = await fetch("/hub/api/inbox");
    if (!r.ok) throw new Error(String(r.status));
    inbox = (await r.json()) as InboxResponse;
  } catch {
    return flash("Could not reach austere-axi.");
  }
  // The inbox's order: pages that need the owner, then pages waiting on an agent.
  const pages = [...inbox.needs_you, ...inbox.waiting_on_agent].filter((p) => p.unanswered > 0);
  const here = pages.findIndex((p) => p.copies.some((c) => c.id === SID));
  const next = here < 0 ? pages[0] : pages.slice(here + 1).concat(pages.slice(0, here))[0];
  if (!next)
    return flash(
      here < 0 ? "No page has unanswered notes." : "No other page has unanswered notes.",
    );
  // The copy with the notes: chips come with unanswered copies first.
  location.href = openUrl(next.copies.find((c) => c.unanswered > 0)?.id ?? next.open_id);
}
