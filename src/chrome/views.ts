// The hub's views, and how the projects sidebar's lists stand: shared by the hub and the review page's sidebar.
import type { IconName } from "./icons.ts";

export type View = "inbox" | "pages" | "notes" | "runs" | "settings" | "shared" | "search";
export type NavView = Exclude<View, "search">;
export const VIEWS: { id: NavView; label: string; icon: IconName }[] = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "pages", label: "Pages", icon: "file" },
  { id: "notes", label: "Notes", icon: "message" },
  { id: "runs", label: "Runs", icon: "terminal" },
  { id: "settings", label: "Settings", icon: "sliders" },
];
/** The views on austere-cloud (RLM-458): what D1 holds. No Inbox, Notes, Runs or Settings: those are machine data. */
export const CLOUD_VIEWS: typeof VIEWS = [
  { id: "pages", label: "Pages", icon: "file" },
  { id: "shared", label: "Shared", icon: "person" },
];
export const isView = (v: string | null, views: typeof VIEWS = VIEWS): v is NavView =>
  views.some((x) => x.id === v);

/** Whether the sidebar's lists are on their way, read, or could not be read. */
export type SideStatus = "loading" | "ready" | "error";
