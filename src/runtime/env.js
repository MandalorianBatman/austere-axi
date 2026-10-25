// Where the runtime was loaded from, and a tiny channel for runtime errors
// (e.g. a Mermaid parse failure) that the review bridge forwards to the chrome.

const current = typeof document !== "undefined" ? document.currentScript : null;
const scriptSrc = current && current.src ? current.src : "";

/** Base URL of the runtime script's directory, or "" when inlined (export). */
export const RUNTIME_BASE = scriptSrc ? scriptSrc.replace(/[^/]*$/, "") : "";

export function assetUrl(name) {
  return RUNTIME_BASE ? RUNTIME_BASE + name : "";
}

const listeners = new Set();
const pending = [];

export function reportRuntimeError(err) {
  const entry = { ...err, at: Date.now() };
  if (!listeners.size) pending.push(entry);
  for (const fn of listeners) fn(entry);
  // eslint-disable-next-line no-console
  console.warn(`[austere] ${err.source} error in ${err.statementId || "?"}: ${err.message}`);
}

export function onRuntimeError(fn) {
  listeners.add(fn);
  while (pending.length) fn(pending.shift());
  return () => listeners.delete(fn);
}
