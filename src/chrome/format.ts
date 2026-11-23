// Text helpers for the hub: pure, no page globals, so any view or component can use them.
import type { ShellPage } from "../shared/hub-api.ts";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function when(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  const t = d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (same(d, today)) return `Today ${t}`;
  if (same(d, new Date(Date.now() - 86_400_000))) return `Yesterday ${t}`;
  return `${d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })} ${t}`;
}

/** A long path or label, shortened in the middle: the start and the end stay (`agent/agy-gemi…/c07769ee1529`). */
export function middle(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(text.length - tail)}`;
}

export const basename = (p: string): string => p.split(/[\\/]/).pop() || p;
export const titleOf = (p: ShellPage): string => p.title || basename(p.rel_path);

/** The non-empty parts, joined with a middle dot. */
export const joinText = (parts: (string | null | undefined | false)[]): string =>
  parts.filter(Boolean).join(" · ");
