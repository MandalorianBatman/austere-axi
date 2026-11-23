// The projects sidebar: every project with its pages, foldable, with the counts that need the owner.
// shadcn's Sidebar parts, so it must sit inside a <SidebarProvider>; the rest is props (data in, callbacks
// out; no store, no page globals). `AppSidebar` is the whole sidebar (name, search, views, projects): the hub and
// the review page both mount it.
import type { ComponentProps, MouseEvent, ReactElement, ReactNode } from "react";
import type { ProjectSummary, ShellPage } from "../shared/hub-api.ts";
import { ChevronRight } from "lucide-react";
import { middle, plural, titleOf } from "./format.ts";
import { Icon } from "./icon.tsx";
import { VIEWS } from "./views.ts";
import type { SideStatus, View } from "./views.ts";
import { Alert, AlertDescription, AlertTitle } from "@/chrome/ui/alert";
import { Button } from "@/chrome/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/chrome/ui/sidebar";

export interface ProjectsSidebarProps {
  projects: readonly ProjectSummary[];
  /** Every page of every project: each project lists its own. */
  pages: readonly ShellPage[];
  /** The project the owner narrowed to: its id, name or folder; "" for every project. */
  selected: string;
  /** Ids of the projects the owner folded. */
  collapsed: readonly string[];
  /** Where a project's link goes (a real URL: it still works with a modifier key held). */
  projectHref(id: string): string;
  /** Where "All" goes. */
  allHref: string;
  /** The owner chose a project (`id`) or all of them (""). */
  onSelect(e: MouseEvent, id: string): void;
  onToggle(id: string): void;
  /** Where a page opens; the default is the hub's. */
  pageHref?(page: { open_id: string }): string;
  /** The page open now (the review page): the id of any of its copies. It is marked, and its project too while folded. */
  currentId?: string;
  /** Whether the lists are on their way or could not be read; with projects already shown, an error is not shown. */
  status?: SideStatus;
  /** Read the lists again (the error's Retry). */
  onRetry?(): void;
}

const NeedsDot = (): ReactElement => (
  <span
    className="size-2 shrink-0 rounded-full bg-[var(--amber)]"
    role="img"
    aria-label="Needs you"
  />
);

const isCurrent = (p: ShellPage, id: string | undefined): boolean =>
  !!id && (p.id === id || p.open_id === id || p.copies.some((c) => c.id === id));

const hubOpen = (p: { open_id: string }): string => `/hub/open/${p.open_id}`;

export function ProjectsSidebar({
  projects,
  pages,
  selected,
  collapsed,
  projectHref,
  allHref,
  onSelect,
  onToggle,
  pageHref = hubOpen,
  currentId,
  status = "ready",
  onRetry,
}: ProjectsSidebarProps): ReactElement {
  const byProject = new Map<string, ShellPage[]>();
  for (const p of pages) {
    let list = byProject.get(p.project_id);
    if (!list) byProject.set(p.project_id, (list = []));
    list.push(p);
  }
  const shown = projects.filter((p) => p.pages > 0 || selected === p.id || selected === p.name);
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="justify-between">
        <span className="tracking-wider uppercase">Projects</span>
        <a
          className="all-projects text-primary normal-case tracking-normal"
          href={allHref}
          hidden={!selected}
          onClick={(e) => onSelect(e, "")}
        >
          All
        </a>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="projects">
          {shown.length ? (
            shown.map((p) => {
              const isSelected = selected === p.id || selected === p.name;
              const expanded = !collapsed.includes(p.id);
              const list = byProject.get(p.id) ?? [];
              const holdsCurrent = !expanded && list.some((pg) => isCurrent(pg, currentId));
              return (
                <SidebarMenuItem key={p.id} className="proj">
                  <SidebarMenuButton
                    asChild
                    isActive={isSelected || holdsCurrent}
                    className="ml-7 w-[calc(100%-1.75rem)] pl-2 text-sidebar-foreground"
                  >
                    <a
                      className="proj-link"
                      href={projectHref(p.id)}
                      title={p.roots.join("\n")}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={(e) => onSelect(e, p.id)}
                    >
                      <span className="truncate">{p.name}</span>
                    </a>
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    className="proj-toggle top-1 left-0.5 right-auto size-6 w-6 after:hidden"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} the pages of ${p.name}`}
                    onClick={() => onToggle(p.id)}
                  >
                    <ChevronRight
                      className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                    />
                  </SidebarMenuAction>
                  {p.unanswered ? (
                    <SidebarMenuBadge className={p.needs_you ? "text-[var(--amber)]" : undefined}>
                      <span aria-hidden="true">{p.unanswered}</span>
                      <span className="sr-only">{plural(p.unanswered, "unanswered note")}</span>
                    </SidebarMenuBadge>
                  ) : p.needs_you ? (
                    <SidebarMenuBadge>
                      <NeedsDot />
                    </SidebarMenuBadge>
                  ) : null}
                  {expanded && list.length ? (
                    <SidebarMenuSub className="proj-pages">
                      {list.map((pg) => {
                        const here = isCurrent(pg, currentId);
                        return (
                          <SidebarMenuSubItem key={pg.id}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={here}
                              className={pg.needs_you ? "need text-foreground" : undefined}
                            >
                              <a
                                href={pageHref(pg)}
                                title={pg.rel_path}
                                aria-current={here ? "page" : undefined}
                              >
                                <span className="pg-title truncate">{titleOf(pg)}</span>
                                {pg.needs_you ? (
                                  <NeedsDot />
                                ) : pg.unanswered ? (
                                  <span className="ml-auto text-2xs text-muted-foreground">
                                    <span aria-hidden="true">{pg.unanswered}</span>
                                    <span className="sr-only">
                                      {plural(pg.unanswered, "unanswered note")}
                                    </span>
                                  </span>
                                ) : null}
                              </a>
                            </SidebarMenuSubButton>
                            {pg.copies.length > 1 ? (
                              <div className="mini-chips flex flex-wrap gap-1.5 py-0.5">
                                {pg.copies.map((c) => (
                                  <a
                                    key={c.id}
                                    className={`mini-chip inline-flex min-h-6 items-center rounded-sm border px-2 font-mono text-2xs ${c.unanswered ? "waiting border-[var(--amber-pill)] text-[var(--amber)]" : "text-muted-foreground"}`}
                                    href={pageHref({ open_id: c.id })}
                                    title={`${c.label} · ${c.file}`}
                                  >
                                    {middle(c.label, 18)}
                                  </a>
                                ))}
                              </div>
                            ) : null}
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
              );
            })
          ) : status === "loading" ? (
            <li role="status" aria-busy="true" className="flex flex-col gap-1">
              <span className="sr-only">Loading projects</span>
              {[0, 1, 2].map((i) => (
                <SidebarMenuSkeleton key={i} />
              ))}
            </li>
          ) : status === "error" ? (
            <li>
              <Alert variant="destructive" className="px-3 py-2">
                <AlertTitle>Could not load projects</AlertTitle>
                <AlertDescription>
                  <p>Could not reach austere-axi.</p>
                  {onRetry ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      onClick={onRetry}
                    >
                      Retry
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            </li>
          ) : (
            <li className="side-empty px-2 py-1 text-sm text-muted-foreground">
              No projects yet. Open a page with <code>austere-axi open &lt;file&gt;</code>.
            </li>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** The austere-axi mark: decorative, the name beside it is the link's text. */
function LogoMark(): ReactElement {
  return (
    <svg className="logo shrink-0" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
      <rect className="fill-[var(--surface)]" width="32" height="32" rx="7" />
      <rect
        className="fill-none stroke-[var(--line-3)]"
        x="1"
        y="1"
        width="30"
        height="30"
        rx="6"
      />
      <path
        className="fill-none stroke-[var(--accent)] stroke-[2.6] [stroke-linecap:round] [stroke-linejoin:round]"
        d="M9 23 16 8l7 15M11.5 18h9"
      />
    </svg>
  );
}

/** The sidebar's search box; the page decides what typing and submitting do. */
export function SearchField(props: ComponentProps<typeof SidebarInput>): ReactElement {
  return (
    <div className="relative">
      <Icon
        name="search"
        size={15}
        width={1.8}
        cls="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
      />
      <SidebarInput
        type="search"
        name="q"
        className="pl-8"
        placeholder="Search pages, parts"
        aria-label="Search pages and parts"
        autoComplete="off"
        {...props}
      />
    </div>
  );
}

export interface AppSidebarProps {
  /** The build's version, shown beside the name; "" where the page does not know it. */
  version: string;
  /** The view the page is on; "" where there is none (the review page). */
  view: View | "";
  viewHref(view: Exclude<View, "search">): string;
  onView?(e: MouseEvent, view: Exclude<View, "search">): void;
  /** Pages that need the owner (Inbox) and people waiting for access (Settings). */
  counts: { inbox: number; settings: number };
  /** The search box: a live one on the hub, a form to the hub's search on the review page. */
  search: ReactNode;
  projects: ProjectsSidebarProps;
}

const needsTitle = (n: number): string => `${plural(n, "page needs", "pages need")} you`;
const waitingTitle = (n: number): string => `${plural(n, "person asks", "people ask")} for access`;

/** The one sidebar of both surfaces: name and search, the views, then the projects. */
export function AppSidebar({
  version,
  view,
  viewHref,
  onView,
  counts,
  search,
  projects,
}: AppSidebarProps): ReactElement {
  return (
    <Sidebar id="side" aria-label="Projects" role="complementary" className="side">
      <SidebarHeader className="gap-3 p-3">
        <div className="brand flex items-center gap-2 px-2">
          <LogoMark />
          <a href="/?view=inbox" className="flex-1 text-sm font-semibold text-foreground">
            austere-axi
          </a>
          {version ? (
            <small className="font-mono text-2xs text-[var(--faint)]">{version}</small>
          ) : null}
        </div>
        {search}
      </SidebarHeader>
      <SidebarContent className="px-1">
        {/* A phone has the views in its tab bar (the hub); the drawer keeps search and projects. */}
        <SidebarMenu className="views max-xs:hidden" aria-label="Views">
          {VIEWS.map((v) => {
            const n = v.id === "inbox" ? counts.inbox : v.id === "settings" ? counts.settings : 0;
            return (
              <SidebarMenuItem key={v.id}>
                <SidebarMenuButton
                  asChild
                  isActive={view === v.id}
                  className="text-sidebar-foreground"
                >
                  <a
                    href={viewHref(v.id)}
                    data-view={v.id}
                    aria-current={view === v.id ? "page" : undefined}
                    onClick={onView && ((e) => onView(e, v.id))}
                  >
                    <Icon name={v.icon} />
                    <span className="label">{v.label}</span>
                  </a>
                </SidebarMenuButton>
                {n ? (
                  <SidebarMenuBadge className="count need rounded-full bg-[var(--amber-pill)] px-2 text-[var(--amber)]">
                    <span aria-hidden="true">{n}</span>
                    <span className="sr-only">
                      {v.id === "inbox" ? needsTitle(n) : waitingTitle(n)}
                    </span>
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
        <ProjectsSidebar {...projects} />
      </SidebarContent>
    </Sidebar>
  );
}
