// The owner's projects sidebar on the review page: the hub's list of projects and pages (projects-sidebar.tsx) with this
// page marked. Owner on the local server only: /hub/api/* answers nobody else. Open or closed is side-state.ts's.
import { useEffect } from "react";
import type { ReactElement } from "react";
import { Sidebar, SidebarContent, SidebarHeader } from "@/chrome/ui/sidebar";
import { ShapeIcon } from "./icon.tsx";
import type { Shape } from "./icons.ts";
import { ProjectsSidebar } from "./projects-sidebar.tsx";
import { SID } from "./review-env.ts";
import { openUrl } from "./review-nav.ts";
import { loadSide, toggleClosed, useSide } from "./review-side.ts";

const LOGO: Shape[] = [
  ["rect", { x: 1.5, y: 1.5, width: 21, height: 21, rx: 5, className: "logo-box" }],
  ["path", { d: "M6.75 17.25 12 6l5.25 11.25M8.6 13.5h6.8", className: "logo-a" }],
];

/** Keeps the sidebar's data current. Always mounted: the phone's sheet draws its content only while open. */
export function SideData(): null {
  useEffect(() => {
    const ctl = new AbortController();
    void loadSide(ctl.signal);
    // Pages and counts change while the tab is in the background.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void loadSide(ctl.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctl.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}

export function ReviewSidebar(): ReactElement {
  const projects = useSide((s) => s.projects);
  const pages = useSide((s) => s.pages);
  const closed = useSide((s) => s.closed);
  return (
    <Sidebar id="side" aria-label="Projects" className="side">
      <SidebarHeader className="p-3">
        <a
          href="/?view=inbox"
          className="flex items-center gap-2.5 rounded-md px-2 py-1 text-sm font-semibold text-foreground"
        >
          <ShapeIcon shapes={LOGO} size={22} />
          austere-axi
        </a>
      </SidebarHeader>
      <SidebarContent className="px-1">
        <ProjectsSidebar
          projects={projects}
          pages={pages}
          selected=""
          collapsed={closed}
          projectHref={(id) => `/?project=${encodeURIComponent(id)}`}
          allHref="/"
          onSelect={() => {}}
          onToggle={toggleClosed}
          pageHref={(p) => openUrl(p.open_id)}
          currentId={SID}
        />
      </SidebarContent>
    </Sidebar>
  );
}
