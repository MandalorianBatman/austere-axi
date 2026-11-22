// Small pieces the hub views and Settings share: links that move inside the hub, empty states, page rows.
import { Fragment, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { InboxPage, ShellCopy, ShellPage } from "../shared/hub-api.ts";
import { joinText, middle, plural, titleOf, when } from "./format.ts";
import { Icon } from "./icon.tsx";
import { tilde } from "./hub-env.ts";
import type { IconName } from "./icons.ts";
import { UNREACHABLE, openLink, post } from "./hub-http.ts";
import { go, reload, say, toUrl, useHub } from "./hub-store.ts";
import type { State } from "./hub-store.ts";

/** A link to another view or filter: a real URL, and a click moves inside the hub. */
export function ViewLink({
  next,
  current,
  children,
}: {
  next: Partial<State>;
  current?: boolean;
  children: ReactNode;
}) {
  const state = useHub((s) => s.state);
  return (
    <a
      href={toUrl({ ...state, ...next })}
      onClick={(e) => go(e, next)}
      aria-current={current ? "page" : undefined}
    >
      {children}
    </a>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className="empty">{children}</p>;
}

/** The non-empty parts with a middle dot between. */
export function joined(parts: ReactNode[]): ReactNode[] {
  const kept = parts.filter((x) => x != null && x !== false && x !== "");
  return kept.map((x, i) => (
    <Fragment key={i}>
      {i ? " · " : null}
      {x}
    </Fragment>
  ));
}

export function Section({
  title,
  count,
  children,
  cls = "",
}: {
  title: string;
  count: number | null;
  children: ReactNode;
  cls?: string;
}): ReactElement {
  const id = `h-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className={cls} aria-labelledby={id}>
      <h2 id={id}>
        {title}
        {count == null ? null : <span className="n">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

export function ProjectFilter({ project }: { project: { name: string; id: string } | null }) {
  const asked = useHub((s) => s.state.project);
  if (!asked) return null;
  return (
    <p className="filter">
      Project {project?.name ? tilde(project.name) : asked} ·{" "}
      <ViewLink next={{ project: "" }}>all projects</ViewLink>
    </p>
  );
}

// ── page rows ──

const TAKER: Record<string, string> = {
  listening: "an agent is listening",
  nobody: "nobody is taking them",
};
const STATUS_LABEL: Record<string, string> = {
  open: "unanswered",
  received: "unanswered",
  addressed: "answered",
  held: "held for you",
};

/** How many chips a row shows before "+n more". */
const CHIPS = 3;

function Chip({ c }: { c: ShellCopy }): ReactElement {
  const extra = joinText([
    c.unanswered ? `${c.unanswered} unanswered` : "",
    c.listening ? "agent listening" : "",
    c.missing ? "missing" : "",
    c.archived ? "archived" : "",
  ]);
  return (
    <a
      className={`chip${c.unanswered ? " waiting" : ""}${c.missing ? " gone" : ""}`}
      href={openLink(c.id)}
      title={`${c.label} · ${c.file}`}
      data-copy={c.id}
    >
      <Icon name="branch" size={12} width={2} />
      <span className="chip-label">{middle(c.label, 28)}</span>
      {extra ? <span className="chip-note">{extra}</span> : null}
    </a>
  );
}

/** `least`: how many copies a page needs before its chips show (the inbox names copies only when there are two). */
export function Chips({ copies, least = 2 }: { copies: ShellCopy[]; least?: number }) {
  if (copies.length < least || !copies.length) return null;
  const rest = copies.slice(CHIPS);
  return (
    <div className="chips">
      {copies.slice(0, CHIPS).map((c) => (
        <Chip key={c.id} c={c} />
      ))}
      {rest.length ? (
        <details className="more">
          <summary>+{rest.length} more</summary>
          <div className="chips">
            {rest.map((c) => (
              <Chip key={c.id} c={c} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** What is worth saying about a page's state beyond its notes: gone, archived, only checked, an agent listening. A quiet page says nothing. */
export function stateWords(p: ShellPage): ReactNode[] {
  const only = p.copies.length === 1 ? p.copies[0] : null;
  if (!only) {
    const out: ReactNode[] = [plural(p.copies.length, "copy", "copies")];
    if (p.copies.every((c) => c.missing)) out.push(<em className="gone">missing</em>);
    else if (p.copies.some((c) => c.listening)) out.push(<em className="live">agent listening</em>);
    return out;
  }
  return [
    only.missing ? <em className="gone">missing</em> : null,
    only.archived ? <em>archived</em> : null,
    only.checked ? <em>checked</em> : null,
    only.listening ? <em className="live">agent listening</em> : null,
  ];
}

export function counts(p: ShellPage): ReactNode[] {
  return [
    p.unanswered ? <b className="open">{p.unanswered} unanswered</b> : null,
    p.addressed ? `${p.addressed} answered` : null,
  ];
}

/** Why a page is in its inbox group, in words. */
function Reasons({ p }: { p: ShellPage }) {
  const run = p.failed ? p.copies.find((c) => c.failed_run)?.failed_run : undefined;
  const waiting = p.unanswered - p.held;
  const lines: ReactElement[] = [];
  if (p.changed)
    lines.push(
      <li key="changed" className="need">
        Changed since you looked: {plural(p.changed, "revision")}
      </li>,
    );
  if (p.held)
    lines.push(
      <li key="held" className="need">
        {plural(p.held, "note")} held for you to release
      </li>,
    );
  if (p.failed)
    lines.push(
      <li key="failed" className="need fail">
        Agent run failed{run?.reason ? ` (${run.reason.replace(/_/g, " ")})` : ""}
        {run?.ended_at ? ` · ${when(run.ended_at)}` : ""}
      </li>,
    );
  if (p.taker)
    lines.push(
      <li key="taker" className={`wait ${p.taker}${p.run_active ? " active" : ""}`}>
        <span className="lead">{plural(waiting, "unanswered note")}</span>
        {` · ${p.taker === "attach_on" ? (p.run_active ? "agent on: a run is working on them" : "agent on: your next note starts a run") : TAKER[p.taker]}`}
      </li>,
    );
  return lines.length ? <ul className="why">{lines}</ul> : null;
}

function NotePreview({ notes }: { notes: InboxPage["notes"] }) {
  if (!notes.length) return null;
  return (
    <ul className="previews">
      {notes.map((n, i) => (
        <li key={i}>
          <span className="quote">{n.text || "(no text)"}</span>
          <span className="by">
            {joined([
              n.author || "You",
              n.target ? (
                <span>
                  on <code className="target">{n.target}</code>
                </span>
              ) : null,
              n.label,
              STATUS_LABEL[n.status] ?? n.status,
            ])}
          </span>
        </li>
      ))}
    </ul>
  );
}

type Tone = "amber" | "red" | "green" | "grey" | "plain";

/** The tile at the start of a row: what kind of attention the page wants. */
function tileOf(p: ShellPage): [IconName, Tone] {
  if (p.group === "needs_you")
    return p.failed ? ["alert", "red"] : p.held ? ["person", "amber"] : ["pencil", "amber"];
  if (p.group === "waiting_on_agent")
    return p.run_active || p.taker === "listening"
      ? ["bolt", "green"]
      : p.taker === "attach_on"
        ? ["bolt", "grey"]
        : ["waiting", "grey"];
  return ["file", "plain"];
}

/** The one next step a row offers, when there is one. Each opens the page (or turns its agent on). */
function NextStep({ p }: { p: ShellPage }) {
  if (p.taker === "nobody")
    return (
      <a className="btn fill" href={openLink(p.open_id, { attach: "1" })}>
        Turn agent on
      </a>
    );
  if (p.group !== "needs_you") return null;
  if (p.changed)
    return (
      <a className="btn fill" href={openLink(p.open_id)}>
        Review changes
      </a>
    );
  if (p.held)
    return (
      <a className="btn fill" href={openLink(p.open_id)}>
        Open held notes
      </a>
    );
  return null;
}

export function ArchiveButton({
  p,
  archivedView = false,
}: {
  p: ShellPage;
  archivedView?: boolean;
}): ReactElement {
  // One request at a time: a second click would archive again and take the first Undo's place.
  // The row comes back from the next read, and the button with it.
  const [busyFor, setBusyFor] = useState<ShellPage | null>(null);
  const busy = busyFor === p;
  const label = `${archivedView ? "Unarchive" : "Archive"} ${titleOf(p)}`;
  const title = archivedView
    ? "Bring this page back to the lists"
    : p.copies.length > 1
      ? "Put every copy of this page away; its notes are kept"
      : "Put this page away; its notes are kept";
  const flipIt = async (): Promise<void> => {
    if (busy) return;
    setBusyFor(p);
    const ok = await flip(p, archivedView ? "unarchive" : "archive");
    if (!ok) setBusyFor(null);
  };
  return archivedView ? (
    <button
      type="button"
      className="btn ghost"
      title={title}
      aria-label={label}
      disabled={busy}
      onClick={() => void flipIt()}
    >
      Unarchive
    </button>
  ) : (
    <button
      type="button"
      className="icon-btn"
      title={title}
      aria-label={label}
      disabled={busy}
      onClick={() => void flipIt()}
    >
      <Icon name="archive" />
    </button>
  );
}

/** Archive or unarchive a page's copies and offer the way back; false when the server did not take it. */
async function flip(p: ShellPage, action: "archive" | "unarchive"): Promise<boolean> {
  const done = await post(`/hub/api/page/${p.open_id}/${action}`);
  if (!done) {
    say(`Could not ${action} ${titleOf(p)}. ${UNREACHABLE}`);
    return false;
  }
  const undo = action === "archive" ? "unarchive" : "archive";
  const undoAction = {
    label: "Undo",
    // Exactly the copies the action changed: a copy archived before stays archived.
    onClick: async (): Promise<void> => {
      if (!(await post(`/hub/api/page/${p.open_id}/${undo}`, { ids: done.ids }))) {
        // Keep the way back: the owner can try again once austere-axi answers.
        say(`Could not undo. ${UNREACHABLE}`, undoAction);
        return;
      }
      say("");
      reload();
    },
  };
  say(`${action === "archive" ? "Archived" : "Unarchived"} ${titleOf(p)}.`, undoAction);
  // Counts, groups and empty states change with the row: read the views again (the status line stays).
  reload();
  return true;
}

export function PageRow({
  p,
  showProject = false,
  notes = [],
  archivedView = false,
}: {
  p: ShellPage;
  showProject?: boolean;
  notes?: InboxPage["notes"];
  archivedView?: boolean;
}): ReactElement {
  const main = p.copies.find((c) => c.id === p.open_id) ?? p.copies[0];
  const facts = joined([...stateWords(p), ...counts(p)]);
  const [name, tone] = tileOf(p);
  const time = when(p.activity);
  return (
    <li className={`row page-row ${p.group}`} data-page={p.id}>
      <span className={`tile ${tone}`} aria-hidden="true">
        <Icon name={name} size={16} width={1.8} />
      </span>
      <div className="row-main">
        <a className="row-title" href={openLink(p.open_id)} title={main?.file ?? ""}>
          {titleOf(p)}
        </a>
        <span className="path">{showProject ? `${p.project} / ${p.rel_path}` : p.rel_path}</span>
        {facts.length ? <span className="meta">{facts}</span> : null}
        <Reasons p={p} />
        <NotePreview notes={notes} />
        <Chips copies={p.copies} />
      </div>
      <div className="row-actions">
        {time ? <span className="when">{time}</span> : null}
        <NextStep p={p} />
        <ArchiveButton p={p} archivedView={archivedView} />
      </div>
    </li>
  );
}
