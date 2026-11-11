// Where the runtime was loaded from, and a tiny channel for runtime errors
// (e.g. a Mermaid parse failure) that the review bridge forwards to the chrome.
import type { RuntimeError } from "../../types/pack.d.ts";

/** A reported runtime error, stamped with when it happened. */
export type RuntimeErrorEntry = RuntimeError & { at: number };

const current = typeof document !== "undefined" ? document.currentScript : null;
const scriptSrc = current && "src" in current && current.src ? current.src : "";

/** Base URL of the runtime script's directory, or "" when inlined (export). */
export const RUNTIME_BASE = scriptSrc ? scriptSrc.replace(/[^/]*$/, "") : "";

export function assetUrl(name: string): string {
  return RUNTIME_BASE ? RUNTIME_BASE + name : "";
}

const listeners = new Set<(entry: RuntimeErrorEntry) => void>();
const pending: RuntimeErrorEntry[] = [];

export function reportRuntimeError(err: RuntimeError): void {
  const entry = { ...err, at: Date.now() };
  if (!listeners.size) pending.push(entry);
  for (const fn of listeners) fn(entry);
  // eslint-disable-next-line no-console
  console.warn(`[austere] ${err.source} error in ${err.statementId || "?"}: ${err.message}`);
}

export function onRuntimeError(fn: (entry: RuntimeErrorEntry) => void): () => boolean {
  listeners.add(fn);
  let next: RuntimeErrorEntry | undefined;
  while ((next = pending.shift())) fn(next);
  return () => listeners.delete(fn);
}
