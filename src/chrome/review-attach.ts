// The Agent pill's data (RLM-346; the owner's only, never on a reviewer's or a hosted page): the page's attach setting,
// the run of the attached agent, and what changing either does. The setting is read in an effect that aborts when a
// newer read starts; a run event beats an answer that was asked before it.
import { useEffect } from "react";
import { BASE } from "./review-env.ts";
import { flash } from "./review-banner.ts";
import { clock } from "./review-format.ts";
import { S, set, useReview } from "./review-store.ts";
import { putRunMark } from "./review-transcript.ts";
import type {
  AttachChange,
  AttachInfo,
  AttachModeId,
  RunEvent,
  RunMark,
  RunSummary,
} from "./review-types.ts";

export const MODES: { id: AttachModeId; label: string; hint: string }[] = [
  { id: "same", label: "Same session", hint: "Each run continues the session" },
  { id: "fork", label: "Fork", hint: "Each run branches from the session" },
  {
    id: "new",
    label: "New session",
    hint: "The first run starts a session; later runs continue it",
  },
];

/** `runs.reason` in words, for a run event without a message. */
export const RUN_REASONS: Record<string, string> = {
  exit: "the harness exited with an error",
  timeout: "it ran past its time limit",
  no_reply: "it exited without replying (does the harness have the write grant?)",
  session_in_use: "the session is open in another process",
  cost_cap: "it reached its cost cap",
  session_unknown: "cannot tell whether the session is still open; choose fork or new",
  unsupported: "the harness cannot run this mode",
  unavailable: "the harness is not available",
  rate_limit: "too many runs on this page in the last hour",
  auto_conflict: "the page takes notes without you (--auto)",
  config: "a settings file is malformed",
};

/** The states the pill shows a run in; a finished or stopped one is only a line in the Conversation. */
export const ACTIVE = new Set<RunSummary["status"]>([
  "queued",
  "waiting_for_session",
  "running",
  "failed",
]);

export const isOn = (info: AttachInfo | null): boolean => info?.effective.state === "on";

/** Ask for the setting again. */
export function reloadAttach(): void {
  set({ attachTick: S().attachTick + 1 });
}

/** A run's start and end as Conversation entries. A run that never started shows only when it failed (it was refused). */
export function addRunMarks(run: RunSummary, message?: string): void {
  const what = [run.harness, run.mode, run.model].filter(Boolean).join(" · ");
  if (run.started_at)
    putRunMark(`${run.id}:start`, {
      id: run.id,
      at: run.started_at,
      text: `Agent run started${what ? ` · ${what}` : ""}`,
      tone: "start",
    });
  if (!run.ended_at || (!run.started_at && run.status !== "failed")) return;
  const took = run.started_at ? ` after ${clock(run.ended_at - run.started_at)}` : "";
  const why = message || RUN_REASONS[run.reason ?? ""] || run.reason || "";
  const end: Pick<RunMark, "text" | "tone"> =
    run.status === "done"
      ? { text: `Agent run finished${took}`, tone: "done" }
      : run.status === "failed"
        ? {
            text: `Agent run ${run.started_at ? "failed" : "did not start"}${why ? `: ${why}` : ""}`,
            tone: "failed",
          }
        : run.status === "stopped"
          ? { text: `Agent run stopped${took}`, tone: "stopped" }
          : { text: "Agent run interrupted: the server restarted", tone: "stopped" };
  putRunMark(`${run.id}:end`, { id: run.id, at: run.ended_at, ...end });
}

/** The page's recent runs as Conversation entries, once per connection. */
export async function loadRunMarks(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/runs?limit=20`);
    if (!r.ok) return;
    for (const run of ((await r.json()) as { runs: RunSummary[] }).runs) addRunMarks(run);
  } catch {
    // the Conversation shows the runs it has
  }
}

/** The owner's `run` event: the run's new state, on the pill and in the Conversation. */
export function onRunEvent(d: RunEvent): void {
  const s = S();
  // A run that ended may have registered a session (A18): the popover's list changes.
  const ended = !ACTIVE.has(d.run.status) || d.run.status === "failed";
  set({
    runLog: s.run?.id === d.run.id ? s.runLog : null,
    runEvents: s.runEvents + 1,
    run: d.run,
    runMessage: d.message ?? "",
  });
  addRunMarks(d.run, d.message);
  if (ended) reloadAttach();
}

/** Keeps the setting current: read again whenever something asks, the newest read the only one that lands. */
export function useAttachFeed(): void {
  const tick = useReview((s) => s.attachTick);
  useEffect(() => {
    // Nothing asked yet: the first ask is the server's snapshot, when the events connect.
    if (tick === 0) return;
    const ctl = new AbortController();
    const eventsBefore = S().runEvents;
    fetch(`${BASE}/attach`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<AttachInfo>) : null))
      .then((info) => {
        if (ctl.signal.aborted || !info) return;
        set({ attachInfo: info });
        // A `run` event that came while this was on its way is newer than the run it saw.
        if (S().runEvents === eventsBefore) set({ run: info.run });
      })
      .catch(() => {
        // the pill keeps what it showed
      });
    return () => ctl.abort();
  }, [tick]);
}

/** Write the page's own row; from "Use project default", the page takes the fields it showed. */
export async function saveAttach(change: AttachChange): Promise<void> {
  const { attachInfo: info, attachBusy } = S();
  if (!info || attachBusy) return;
  const own = info.page && info.page.state !== "inherit" ? info.page.state : null;
  const e = info.effective;
  const body: AttachChange = own
    ? { state: own, ...change }
    : {
        state: "inherit",
        mode: e.mode,
        session: e.session,
        harness: e.harness,
        model: e.model,
        ...change,
      };
  set({ attachBusy: true, attachError: "" });
  try {
    const r = await fetch(`${BASE}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await r.json().catch(() => ({}))) as AttachInfo & { error?: string };
    if (r.ok) {
      set({ attachInfo: d });
      // Any read that was on its way asked before this change: a new read replaces it.
      reloadAttach();
    } else set({ attachError: d.error || `Could not change it (${r.status}).` });
  } catch {
    set({ attachError: "Could not reach austere-axi. Check that it is still running." });
  }
  set({ attachBusy: false });
}

export async function runAction(kind: "stop" | "retry"): Promise<void> {
  const r = await fetch(`${BASE}/run/${kind}`, { method: "POST" }).catch(() => null);
  if (!r) return flash("Could not reach austere-axi. Check that it is still running.");
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    flash(
      d.error
        ? `${kind === "stop" ? "Stop" : "Retry"}: ${d.error}`
        : `${kind} failed (${r.status})`,
    );
  }
}

/** The Agent popover, with fresh settings. */
export function openAttach(): void {
  if (S().panel !== "agent") reloadAttach();
  set({ panel: "agent" });
}

export function closeAttach(): void {
  if (S().panel === "agent") set({ panel: "notes" });
}

/** The failed run's log, in the popover. */
export async function openLog(): Promise<void> {
  const run = S().run;
  if (!run) return;
  openAttach();
  let log: string[];
  try {
    const r = await fetch(`${BASE}/run/${run.id}/log`);
    log = r.ok
      ? ((await r.json()) as { tail: string[] }).tail
      : [`Could not read the log (${r.status}).`];
  } catch {
    log = ["Could not reach austere-axi."];
  }
  // A retry may have started another run meanwhile: this log is not its.
  if (S().run?.id === run.id) set({ runLog: log });
}
