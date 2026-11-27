// The owner's sidebar on the review page: the hub's own (projects-sidebar.tsx AppSidebar: name, search, views, projects
// and pages) with this page marked. The owner on the local server, or a hosted viewer signed in to an account (then the
// cloud's views and its own pages, as the cloud hub draws them): /hub/api/* answers nobody else. Open or closed is side-state.ts's.
import { useEffect } from "react";
import type { ReactElement } from "react";
import { AppSidebar, SearchField } from "./projects-sidebar.tsx";
import { ACCOUNT, SID } from "./review-env.ts";
import { AccountFooter, pageHref } from "./cloud-views.tsx";
import { openUrl } from "./review-nav.ts";
import { loadSide, toggleClosed, useSide } from "./review-side.ts";
import { CLOUD_VIEWS } from "./views.ts";

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
  const status = useSide((s) => s.status);
  return (
    <AppSidebar
      version=""
      view=""
      {...(ACCOUNT
        ? {
            views: CLOUD_VIEWS,
            brand: { name: "austere cloud", href: "/" },
            footer: <AccountFooter account={ACCOUNT} />,
          }
        : {})}
      viewHref={(v) => `/?view=${v}`}
      counts={{ inbox: projects.reduce((n, p) => n + p.needs_you, 0), settings: 0 }}
      search={
        // The hub's search is a page of the hub: this form goes there.
        <form className="search" role="search" action="/" method="get">
          <input type="hidden" name="view" value="search" />
          <SearchField />
        </form>
      }
      projects={{
        projects,
        pages,
        selected: "",
        collapsed: closed,
        projectHref: (id) => `/?project=${encodeURIComponent(id)}`,
        allHref: "/",
        onSelect: () => {},
        onToggle: toggleClosed,
        pageHref: (p) => openUrl(p.open_id),
        currentId: SID,
        status,
        onRetry: () => void loadSide(new AbortController().signal),
        ...(ACCOUNT
          ? {
              pageHref,
              service: "austere cloud",
              empty: (
                <>
                  No pages yet. Run <code>austere-axi publish &lt;file&gt;</code>.
                </>
              ),
            }
          : {}),
      }}
    />
  );
}
