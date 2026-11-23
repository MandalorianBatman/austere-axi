// What the hub and the review page share about the projects sidebar: whether it is open (Ctrl/Cmd+B, the trigger)
// and which projects are folded. Both live in localStorage under one key each, so a choice made on one page holds
// on the other. (shadcn's own `sidebar_state` cookie is gone: ui/sidebar.tsx does not write it.)
import { useCallback, useState } from "react";

export const SIDEBAR_OPEN = "austere:sidebar-open";
export const CLOSED_PROJECTS = "austere:hub:closed-projects";

export function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or full: the page still works, it just forgets
  }
}

/** The props for a `<SidebarProvider>`: open as the owner left it (open the first time), and kept when it changes. */
export function useSidebarOpen(): {
  open: boolean;
  onOpenChange(open: boolean): void;
} {
  const [open, setOpen] = useState(() => stored<boolean>(SIDEBAR_OPEN, true) !== false);
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    store(SIDEBAR_OPEN, next);
  }, []);
  return { open, onOpenChange };
}
