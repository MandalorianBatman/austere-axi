// What the page knows from the start: the boot object the server (or, hosted, the shell's JSON) hands it, who is
// looking, and the browser storage helpers. Nothing here changes while the page runs.
//
// The local server inlines the boot object as window.__AUSTERE__. The hosted service's CSP forbids inline
// scripts, so it ships the same object as JSON in <script type="application/json" id="austere-boot">.
import { LIMITS } from "../shared/sync.ts";
import type { Boot } from "./review-types.ts";

export const BOOT: Boot =
  (window as Window & { __AUSTERE__?: Boot }).__AUSTERE__ ??
  JSON.parse(document.getElementById("austere-boot")?.textContent || "{}");
export const SID = BOOT.id;
// Hosted mode (austere-cloud, docs/sync-protocol.md): a reviewer page that syncs over the
// page's WebSocket instead of the local event stream and has no owner controls.
export const HOSTED = BOOT.hosted || null;
export const BASE = BOOT.hosted?.base ?? `/s/${SID}`;
export const VIEWER = BOOT.viewer || { role: "owner", name: "" };
export const OWNER = !HOSTED && VIEWER.role === "owner";
export const NAME_MAX = LIMITS.nameChars;
export const LS = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or blocked; state stays in memory
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // blocked storage
    }
  },
};
export const SS = {
  get<T = unknown>(key: string): T | null {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  },
  /** False when the write failed (blocked storage, quota). */
  set(key: string, value: unknown): boolean {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export const UNREACHABLE = "Could not reach austere-axi. Check that it is still running.";

/** The server's reason for a failed request, else its status. */
export async function failure(r: Response): Promise<string> {
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return d.error || `error ${r.status}`;
}

/** Apple platforms write the shortcut modifier as ⌘, the rest as Ctrl. */
const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
/** A shortcut as this platform writes it: `shortcut("K")` is "⌘K" on a Mac, "Ctrl K" elsewhere. */
export const shortcut = (key: string): string => (APPLE ? `⌘${key}` : `Ctrl ${key}`);
