// The Agent pill (the owner's) and its popover: attach an agent to the page, choose how its runs start, and follow
// the run it started. The run's state also shows beside the pill, with Stop, View log and Retry.
import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon } from "./icon.tsx";
import { copyText } from "./review-clipboard.ts";
import { ago, bytes, clock } from "./review-format.ts";
import { useNarrow, useNow } from "./review-hooks.ts";
import {
  ACTIVE,
  MODES,
  RUN_REASONS,
  closeAttach,
  isOn,
  openAttach,
  openLog,
  runAction,
  saveAttach,
} from "./review-attach.ts";
import { useReview } from "./review-store.ts";
import type { AttachInfo, RunSummary } from "./review-types.ts";
import { Button } from "@/chrome/ui/button";
import { Input } from "@/chrome/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/chrome/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/chrome/ui/radio-group";
import { ScrollArea } from "@/chrome/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/chrome/ui/select";
import { Skeleton } from "@/chrome/ui/skeleton";

/** The time a running run has taken, counting up each second. */
function Elapsed({ since }: { since: number | null }): ReactElement {
  const now = useNow(1000);
  return <span className="run-elapsed">{clock(now - (since ?? now))}</span>;
}

/** The run's state in words. */
function RunLabel({ run }: { run: RunSummary }): ReactElement {
  switch (run.status) {
    case "queued":
      return <span className="run-label">Run queued</span>;
    case "waiting_for_session":
      return <span className="run-label">Waiting for session</span>;
    case "running":
      return (
        <span className="run-label">
          Running <Elapsed since={run.started_at} />
        </span>
      );
    case "failed":
      return <span className="run-label">Run failed</span>;
    case "done":
      return <span className="run-label">Last run done</span>;
    case "stopped":
      return <span className="run-label">Last run stopped</span>;
    default:
      return <span className="run-label">Last run interrupted</span>;
  }
}

/** Stop, View log and Retry for the run's state. */
function RunButtons({ run }: { run: RunSummary }): ReactElement | null {
  if (run.status === "running" || run.status === "queued" || run.status === "waiting_for_session")
    return (
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="run-stop"
        onClick={() => void runAction("stop")}
      >
        Stop
      </Button>
    );
  if (run.status === "failed")
    return (
      <>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="run-log"
          onClick={() => void openLog()}
        >
          View log
        </Button>
        <Button
          type="button"
          size="xs"
          className="run-retry"
          onClick={() => void runAction("retry")}
        >
          Retry
        </Button>
      </>
    );
  return null;
}

/** Why a failed or waiting run is so. */
const runWhy = (run: RunSummary, message: string): string =>
  run.status === "failed"
    ? message || RUN_REASONS[run.reason ?? ""] || run.reason || ""
    : run.status === "waiting_for_session"
      ? message
      : "";

/** Beside the pill: a run that is going, or that failed. */
function RunState(): ReactElement {
  const run = useReview((s) => s.run);
  const message = useReview((s) => s.runMessage);
  const show = !!run && ACTIVE.has(run.status);
  return (
    <span
      className={`run-state${run ? ` ${run.status}` : ""}`}
      hidden={!show}
      title={show ? runWhy(run, message) : undefined}
    >
      {show ? (
        <>
          <RunLabel run={run} />
          <RunButtons run={run} />
        </>
      ) : null}
    </span>
  );
}

function Field({ legend, children }: { legend: string; children: ReactNode }): ReactElement {
  return (
    <fieldset className="attach-field">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

/** One session to continue: its harness and id, and how lately it was heard from. */
function SessionChoice({
  value,
  label,
  meta,
  disabled,
}: {
  value: string;
  label: string;
  meta: string;
  disabled: boolean;
}): ReactElement {
  return (
    <label className="attach-radio attach-session">
      <RadioGroupItem value={value} disabled={disabled} />
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </label>
  );
}

const STATES = [
  ["on", "On"],
  ["off", "Off"],
  ["inherit", "Use project default"],
] as const;

/** The run, as a status card: its state, the buttons, and the log once asked for. */
function RunCard(): ReactElement | null {
  const run = useReview((s) => s.run);
  const message = useReview((s) => s.runMessage);
  const log = useReview((s) => s.runLog);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => logRef.current?.scrollIntoView({ block: "nearest" }), [log]);
  if (!run) return null;
  const why = runWhy(run, message);
  return (
    <div className={`attach-run ${run.status}`}>
      <div className="attach-run-head">
        <RunLabel run={run} />
        <RunButtons run={run} />
      </div>
      {why ? <div className="attach-hint">{why}</div> : null}
      {log ? (
        <pre className="attach-log" ref={logRef}>
          {log.join("\n") || "(the log is empty)"}
        </pre>
      ) : null}
    </div>
  );
}

function Settings({ info }: { info: AttachInfo }): ReactElement {
  const busy = useReview((s) => s.attachBusy);
  const error = useReview((s) => s.attachError);
  const e = info.effective;
  const pageState = info.page?.state ?? "inherit";
  const own = pageState !== "inherit";
  const project = info.project?.setting;
  const projectText = project && project.state !== "inherit" ? project.state : "off";
  const fieldsOff = !own || busy;
  const sessionHarness =
    e.session === "author"
      ? info.author?.harness
      : info.sessions.find((s) => s.id === e.session)?.harness;
  const runHarness = sessionHarness ?? e.harness;
  const caps = info.harnesses[runHarness]?.capabilities;
  const blocked = MODES.flatMap((m) => {
    const cap = caps?.[m.id];
    return cap && !cap.ok ? [`${m.label}: ${cap.reason}`] : [];
  });
  const models = info.harnesses[runHarness]?.models;
  const modelCap = info.harnesses[runHarness]?.capabilities.model;
  const grant = info.harnesses[info.target.harness]?.grantCommand;
  return (
    <>
      <p className="attach-note">
        When on, a note you send or release starts the agent: it reads the notes, patches the page
        and replies.
      </p>
      <div className="seg attach-state" role="group" aria-label="Attach">
        {STATES.map(([value, label]) => (
          <button
            type="button"
            key={value}
            data-state={value}
            className={pageState === value ? "on" : undefined}
            aria-pressed={pageState === value}
            // An auto page may not end up on (Q3, A17): neither by On nor by going back to a project default that is on.
            disabled={
              busy ||
              (!!info.auto &&
                pageState !== value &&
                (value === "on" || (value === "inherit" && projectText === "on")))
            }
            onClick={() => void saveAttach({ state: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="attach-note">
        {own
          ? `Project default${info.project ? ` (${info.project.name})` : ""}: ${projectText}.`
          : `This page uses the project default: ${e.state}. Choose On or Off to give it its own setting.`}
      </p>
      {info.auto && e.state !== "on" ? (
        <div className="attach-warn">
          {`${info.auto}. Attach and --auto exclude each other: publish or share it without --auto to turn attach on.`}
        </div>
      ) : null}

      <Field legend="Mode">
        <RadioGroup
          value={e.mode}
          onValueChange={(mode) => void saveAttach({ mode: mode as typeof e.mode })}
        >
          {MODES.map((m) => {
            const cap = caps?.[m.id];
            const reason = cap && !cap.ok ? cap.reason : null;
            return (
              <label
                key={m.id}
                className={`attach-radio${reason ? " disabled" : ""}`}
                title={reason || m.hint}
              >
                <RadioGroupItem value={m.id} disabled={fieldsOff || !!reason} />
                <span>{m.label}</span>
              </label>
            );
          })}
        </RadioGroup>
        {blocked.length ? <div className="attach-reason">{blocked.join(" · ")}</div> : null}
        {e.mode !== "new" ? (
          <div className="attach-hint">
            {`Resends the whole session each run${info.sessionFileSize ? ` · ${bytes(info.sessionFileSize)}` : ""}`}
          </div>
        ) : null}
      </Field>

      <Field legend="Session">
        <RadioGroup value={e.session} onValueChange={(session) => void saveAttach({ session })}>
          <SessionChoice
            value="author"
            label="Author"
            meta={
              info.author
                ? `${info.author.harness} ${info.author.short}`
                : "none registered: a new session"
            }
            disabled={fieldsOff}
          />
          {info.sessions.map((s) => (
            <SessionChoice
              key={s.id}
              value={s.id}
              label={`${s.harness} ${s.short}`}
              meta={`${s.roles.join(", ")} · ${ago(s.lastSeen)} · ${s.liveness}`}
              disabled={fieldsOff}
            />
          ))}
          {e.session !== "author" && !info.sessions.some((s) => s.id === e.session) ? (
            <SessionChoice
              value={e.session}
              label={`session ${e.session}`}
              meta="not registered for this page"
              disabled={fieldsOff}
            />
          ) : null}
        </RadioGroup>
        {!info.sessions.length ? (
          <div className="attach-hint">
            No agent session has opened, patched or polled this page yet.
          </div>
        ) : null}
      </Field>

      <Field legend="Harness (for a new session)">
        <Select
          value={e.harness}
          disabled={fieldsOff}
          onValueChange={(harness) => void saveAttach({ harness })}
        >
          <SelectTrigger className="attach-select w-full" aria-label="Harness">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(info.harnesses).map(([name, hi]) => (
              <SelectItem key={name} value={name}>
                {hi.found ? name : `${name} (not found)`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field legend="Model">
        <Input
          // A new value from the server replaces what was typed.
          key={e.model ?? ""}
          type="text"
          className="attach-input"
          aria-label="Model"
          list={models?.length ? "attach-models" : undefined}
          defaultValue={e.model ?? ""}
          placeholder={modelCap && !modelCap.ok ? modelCap.reason : "the harness's default"}
          spellCheck={false}
          autoComplete="off"
          disabled={fieldsOff || (!!modelCap && !modelCap.ok)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") ev.currentTarget.blur();
          }}
          onBlur={(ev) => {
            const model = ev.currentTarget.value.trim() || null;
            if (model !== e.model) void saveAttach({ model });
          }}
        />
        {models?.length ? (
          <datalist id="attach-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        ) : null}
      </Field>

      {grant ? (
        <div className="attach-warn attach-grant">
          <span>
            {`${info.target.harness} has no write grant: its runs cannot patch this page and end with “no reply”. Grant it once, at a terminal:`}
          </span>
          <span className="attach-cmd">
            <code>{grant}</code>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void copyText(grant, "Command")}
            >
              Copy
            </Button>
          </span>
        </div>
      ) : null}
      {info.warnings
        .filter((w) => !(grant && w.includes(grant)) && !(info.auto && w.startsWith(info.auto)))
        .map((w) => (
          <div className="attach-warn" key={w}>
            {w}
          </div>
        ))}
      <div className="attach-run-slot">
        <RunCard />
      </div>
      {error ? (
        <div className="attach-error" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}

function Body(): ReactElement {
  const info = useReview((s) => s.attachInfo);
  // The popover is closed: what it showed of an earlier opening goes.
  useEffect(
    () => () => {
      useReview.setState({ runLog: null, attachError: "" });
    },
    [],
  );
  return (
    <ScrollArea className="attach-scroll">
      <div className="attach-body">
        <div className="attach-head">
          <strong>Agent on this page</strong>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="attach-close"
            aria-label="Close"
            onClick={closeAttach}
          >
            <Icon name="close" size={16} width={1.8} />
          </Button>
        </div>
        {info ? (
          <Settings info={info} />
        ) : (
          <div className="attach-loading" role="status" aria-label="Loading the agent settings">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

/** The Agent pill and its run state; the popover hangs from the pill. */
/** From the pill's foot to the foot of the panel's tabs (the bar's 52 px and the tabs' 45 px, less the pill's own). */
const TABS_CLEAR = 60;

export function AttachPill(): ReactElement {
  const narrow = useNarrow();
  const info = useReview((s) => s.attachInfo);
  const run = useReview((s) => s.run);
  const open = useReview((s) => s.panel === "agent");
  const on = isOn(info);
  const detail =
    on && info
      ? [info.target.harness, info.effective.mode, info.effective.model].filter(Boolean).join(" · ")
      : "Off";
  const showRun = !!run && ACTIVE.has(run.status);
  return (
    <div className="attach">
      <Popover open={open} onOpenChange={(next) => (next ? openAttach() : closeAttach())}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`attach-pill${on ? " on" : ""}`}
            data-run={showRun ? run.status : ""}
            title={
              on
                ? `Agent attached: ${detail}. A note you send starts it.`
                : "Attach an agent to this page"
            }
          >
            <span className="attach-dot" />
            <span className="attach-label">
              Agent: <span className="attach-detail">{detail}</span>
              <span className="attach-short">{on ? "On" : "Off"}</span>
            </span>
            <Icon name="chevronDown" size={12} width={2} cls="attach-caret" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="attach-pop"
          align="end"
          collisionPadding={8}
          // On a wide screen the panel's tabs sit under the pill: hang below them, so the popover covers none.
          sideOffset={narrow ? 4 : TABS_CLEAR}
          // Opened by Enter, the key's own click would land on the first control it finds: focus the popover itself,
          // once the key is released.
          onOpenAutoFocus={(ev) => {
            ev.preventDefault();
            const el = ev.currentTarget as HTMLElement;
            setTimeout(() => el.focus(), 0);
          }}
          aria-label="Agent on this page"
          // The panel's tabs change the view themselves: a press on one is not an outside click that closes the popover
          // it has just opened (a tab takes focus when pressed).
          onInteractOutside={(ev) => {
            if (ev.target instanceof Element && ev.target.closest(".panel-tab"))
              ev.preventDefault();
          }}
        >
          <Body />
        </PopoverContent>
      </Popover>
      <RunState />
    </div>
  );
}
