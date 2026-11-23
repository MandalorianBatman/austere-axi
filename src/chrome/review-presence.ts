// What the page says about the agent: one label and tone for the header, the Agent tab, the dock and the composer.
// Pure: the same state gives the same words. Components pass `now` so the "4 min" in it counts up.
import type { Presence } from "./presence.ts";
import { HOSTED, OWNER, VIEWER } from "./review-env.ts";
import type { ReviewState } from "./review-store.ts";

export interface PresenceView {
  label: string;
  /** `ended`, `off`, `hosted`, `listening`, `working`, `stale`, `busy` or `idle`: the label's tone. */
  cls: string;
  /** With an agent attached, "not listening" says nothing: the Agent pill tells what runs. */
  attached: boolean;
  title: string;
}

/** How long ago the agent took the notes: "4 min", "1 h 5 min"; "" under a minute. */
export function agentFor(since: number | null, now: number): string {
  const min = since == null ? 0 : Math.floor((now - since) / 60_000);
  if (min < 1) return "";
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

type Slice = Pick<
  ReviewState,
  "archived" | "lockout" | "connected" | "presence" | "since" | "wake" | "unread" | "attachInfo"
>;

export function presenceView(s: Slice, now: number): PresenceView {
  let label: string;
  let cls: string;
  const took = agentFor(s.since, now);
  if (s.archived) [label, cls] = ["Page archived", "ended"];
  else if (s.lockout) [label, cls] = [s.lockout, "ended"];
  else if (!s.connected) [label, cls] = ["Reconnecting…", "off"];
  else if (HOSTED) [label, cls] = ["Shared page", "hosted"];
  else if (s.presence === "listening") [label, cls] = ["Agent listening", "listening"];
  else if (s.presence === "working")
    [label, cls] = [took ? `Agent working (${took})` : "Agent working", "working"];
  else if (s.presence === "stale")
    [label, cls] = [
      took ? `Took your notes ${took} ago, no reply yet` : "Took your notes, no reply yet",
      "stale",
    ];
  else if (s.wake?.state === "idle")
    [label, cls] = [`Agent idle in ${s.wake.harness} · Send wakes it`, "listening"];
  else if (s.wake?.state === "busy")
    [label, cls] = [`Agent busy in ${s.wake.harness} · notes wait for its turn`, "busy"];
  else [label, cls] = ["Agent not listening", "idle"];
  if (cls === "idle" && s.unread) label += ` · ${s.unread} not answered yet`;
  const attached = cls === "idle" && s.attachInfo?.effective.state === "on";
  const title =
    cls === "idle"
      ? "Your notes are kept and reach the agent the next time it polls."
      : cls === "working"
        ? "The agent has your last batch."
        : cls === "stale"
          ? "The agent took your last notes. It has not replied or changed the page for a while."
          : cls === "hosted"
            ? "Notes go to the page owner. Replies show up here as they are posted."
            : cls === "busy"
              ? "The agent session that worked on this page is in a turn. Your notes start its next turn when this one ends."
              : s.wake
                ? "The agent session that worked on this page is idle. Send starts a turn in it."
                : "";
  return { label, cls, attached, title };
}

/** Only someone whose notes go straight to an agent is told it takes them; a held reviewer's wait for the owner. */
export const notesGoToAgent = (): boolean => OWNER || VIEWER.auto === true;

// The roster of the others on the page (presence.ts) draws into the header's chips; it is made once that exists.
let roster: Presence | null = null;
export const setRoster = (p: Presence): void => {
  roster = p;
};
export const getRoster = (): Presence | null => roster;
