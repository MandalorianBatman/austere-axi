// The hub's views, and how the projects sidebar's lists stand: shared by the hub and the review page's sidebar.
import type { IconName } from "./icons.ts";

export type View = "inbox" | "pages" | "notes" | "runs" | "settings" | "search";
export const VIEWS: { id: Exclude<View, "search">; label: string; icon: IconName }[] = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "pages", label: "Pages", icon: "file" },
  { id: "notes", label: "Notes", icon: "message" },
  { id: "runs", label: "Runs", icon: "terminal" },
  { id: "settings", label: "Settings", icon: "sliders" },
];
export const isView = (v: string | null): v is Exclude<View, "search"> =>
  VIEWS.some((x) => x.id === v);

/** Whether the sidebar's lists are on their way, read, or could not be read. */
export type SideStatus = "loading" | "ready" | "error";
