// The projects sidebar: every project with its pages, foldable, with the counts that need the owner.
// shadcn's Sidebar parts, so it must sit inside a <SidebarProvider>; the rest is props (data in, callbacks
// out; no store, no page globals), so the hub mounts it today and the review page can mount it later.
import type { MouseEvent, ReactElement } from "react";
import type { ProjectSummary, ShellPage } from "../shared/hub-api.ts";
import { ChevronRight } from "lucide-react";
import { middle, plural, titleOf } from "./format.ts";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
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
}

const NeedsDot = (): ReactElement => (
  <span
    className="size-[7px] shrink-0 rounded-full bg-[var(--amber)]"
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
                    className="ml-7 w-[calc(100%-1.75rem)] pl-2"
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
                    <SidebarMenuBadge
                      className={p.needs_you ? "text-[var(--amber)]" : undefined}
                      title={plural(p.unanswered, "unanswered note")}
                    >
                      {p.unanswered}
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
                                  <span
                                    className="ml-auto text-[11px] text-muted-foreground"
                                    title={plural(pg.unanswered, "unanswered note")}
                                  >
                                    {pg.unanswered}
                                  </span>
                                ) : null}
                              </a>
                            </SidebarMenuSubButton>
                            {pg.copies.length > 1 ? (
                              <div className="mini-chips flex flex-wrap gap-1 py-0.5">
                                {pg.copies.map((c) => (
                                  <a
                                    key={c.id}
                                    className={`mini-chip rounded-full border px-2 font-mono text-[11px] leading-[18px] ${c.unanswered ? "waiting border-[var(--amber-pill)] text-[var(--amber)]" : "text-muted-foreground"}`}
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
          ) : (
            <li className="side-empty px-2 py-1 text-sm text-muted-foreground">No projects yet.</li>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
