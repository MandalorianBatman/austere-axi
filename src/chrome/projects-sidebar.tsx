// The projects sidebar: every project with its pages, foldable, with the counts that need the owner.
// Props only (data in, callbacks out; no store, no page globals), so the hub mounts it today and the
// review page can mount it later. Class names are the hub's (hub.css).
import type { MouseEvent, ReactElement } from "react";
import type { ProjectSummary, ShellPage } from "../shared/hub-api.ts";
import { middle, plural, titleOf } from "./format.ts";
import { Icon } from "./icon.tsx";

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
  /** Where "All" goes, and what it asks for once the owner clicks it. */
  allHref: string;
  /** The owner chose a project (`id`) or all of them (""). */
  onSelect(e: MouseEvent, id: string): void;
  onToggle(id: string): void;
  /** Where a page opens; the default is the hub's. */
  pageHref?(page: { open_id: string }): string;
}

const NeedsDot = (): ReactElement => (
  <span className="dot need" role="img" aria-label="Needs you" />
);

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
}: ProjectsSidebarProps): ReactElement {
  const byProject = new Map<string, ShellPage[]>();
  for (const p of pages) {
    let list = byProject.get(p.project_id);
    if (!list) byProject.set(p.project_id, (list = []));
    list.push(p);
  }
  const shown = projects.filter((p) => p.pages > 0 || selected === p.id || selected === p.name);
  return (
    <>
      <div className="side-h">
        <span>Projects</span>
        <a
          className="all-projects"
          href={allHref}
          hidden={!selected}
          onClick={(e) => onSelect(e, "")}
        >
          All
        </a>
      </div>
      <ul className="projects">
        {shown.length ? (
          shown.map((p) => {
            const isSelected = selected === p.id || selected === p.name;
            const expanded = !collapsed.includes(p.id);
            return (
              <li key={p.id} className={`proj${isSelected ? " selected" : ""}`}>
                <div className="proj-head">
                  <button
                    type="button"
                    className="proj-toggle"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} the pages of ${p.name}`}
                    onClick={() => onToggle(p.id)}
                  >
                    <Icon name="chevronRight" size={14} width={2} />
                  </button>
                  <a
                    className="proj-link"
                    href={projectHref(p.id)}
                    title={p.roots.join("\n")}
                    aria-current={isSelected ? "true" : undefined}
                    onClick={(e) => onSelect(e, p.id)}
                  >
                    {p.name}
                  </a>
                  {p.unanswered ? (
                    <span
                      className={`count${p.needs_you ? " need" : ""}`}
                      title={plural(p.unanswered, "unanswered note")}
                    >
                      {p.unanswered}
                    </span>
                  ) : p.needs_you ? (
                    <NeedsDot />
                  ) : null}
                </div>
                {expanded ? (
                  <ul className="proj-pages">
                    {(byProject.get(p.id) ?? []).map((pg) => (
                      <li key={pg.id}>
                        <a
                          href={pageHref(pg)}
                          title={pg.rel_path}
                          className={pg.needs_you ? "need" : ""}
                        >
                          <span className="pg-title">{titleOf(pg)}</span>
                          {pg.needs_you ? (
                            <NeedsDot />
                          ) : pg.unanswered ? (
                            <span
                              className="count"
                              title={plural(pg.unanswered, "unanswered note")}
                            >
                              {pg.unanswered}
                            </span>
                          ) : null}
                        </a>
                        {pg.copies.length > 1 ? (
                          <div className="mini-chips">
                            {pg.copies.map((c) => (
                              <a
                                key={c.id}
                                className={`mini-chip${c.unanswered ? " waiting" : ""}`}
                                href={pageHref({ open_id: c.id })}
                                title={`${c.label} · ${c.file}`}
                              >
                                {middle(c.label, 18)}
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })
        ) : (
          <li className="side-empty">No projects yet.</li>
        )}
      </ul>
    </>
  );
}
