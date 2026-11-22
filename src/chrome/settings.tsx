// Settings (RLM-396): the owner's page for this local server, a view of the hub shell (shell.tsx). People
// (links, devices, requests: /hub/api/people), Network, Review defaults, Cloud, Projects and About (/hub/api/settings).
// Nothing here runs a command: what names one (`server install`, `adapter set`, `trigger add`) stays at a
// terminal. Every setting here has a CLI form too; the hints name it.
// Drawn from the Hub-Settings artboard: each part is a card, People across the top, Network beside Review
// defaults, Cloud and About, Projects below.
import { Fragment, useRef, useState } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import type {
  LocalNetwork,
  PagesResponse,
  ProjectActionResult,
  ProjectSummary,
  ProjectsResponse,
  SettingsResponse,
  ShellPage,
} from "../shared/hub-api.ts";
import type {
  AccessRequestSummary,
  AccessRequestsResponse,
  AccessSummary,
  ShareListResponse,
  ShareResponse,
} from "../cli/server.ts";
import { plural, when } from "./format.ts";
import { tilde } from "./hub-env.ts";
import { get, send } from "./hub-http.ts";
import { useLoad } from "./hub-load.ts";
import { Empty, ViewLink } from "./hub-parts.tsx";
import { reload, say } from "./hub-store.ts";
import { Icon, ShapeIcon } from "./icon.tsx";
import type { Shape } from "./icons.ts";

/** The parts of the page, in order: the anchors of its own small menu. */
const PARTS = [
  { id: "people", label: "People and access" },
  { id: "network", label: "Network" },
  { id: "review", label: "Review defaults" },
  { id: "cloud", label: "Cloud" },
  { id: "projects", label: "Projects" },
  { id: "about", label: "About" },
];

/** The "New link" button's plus. */
const PLUS: Shape[] = [["path", { d: "M12 5v14M5 12h14" }]];

/** How a device got in, as the Devices table's column says it. */
const GOT_IN: Record<string, string> = {
  link: "Named link",
  request: "Approved request",
  tailscale: "Tailscale login",
};

/** Text with `backticked` parts as code: a command or a variable the owner types at a terminal. */
function Words({ text }: { text: string }): ReactElement {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

/** A labelled control in a row. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * A select that remembers the owner touched it (`data-touched`): an untouched notes choice is not sent, so the
 * server applies the saved default itself (and holds the notes where an attached agent rules auto out).
 */
function Select({
  ref,
  name,
  options,
  value,
  label,
  onChange,
}: {
  ref?: RefObject<HTMLSelectElement | null>;
  name: string;
  options: [string, string][];
  value: string;
  label: string;
  onChange?: (value: string) => void;
}) {
  return (
    <select
      ref={ref}
      name={name}
      aria-label={label}
      defaultValue={value}
      onChange={(e) => {
        e.currentTarget.dataset.touched = "1";
        onChange?.(e.currentTarget.value);
      }}
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

/** A checkbox drawn as a switch (settings.css `input.toggle`); it stays a checkbox for forms and tests. */
function Toggle({
  on,
  disabled,
  describedBy,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  describedBy?: string;
  /** Called with the new state; `undo` puts the box back (a confirmation said no). */
  onChange: (checked: boolean, undo: () => void) => void;
}) {
  return (
    <input
      // The server's answer decides what shows: a read that changes it remounts the box.
      key={String(on)}
      type="checkbox"
      role="switch"
      className="toggle"
      defaultChecked={on}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(e) => {
        const box = e.currentTarget;
        onChange(box.checked, () => (box.checked = !box.checked));
      }}
    />
  );
}

/** The head of a section card: its title, what it is for, and an action on the right. */
function CardHead({
  id,
  title,
  about,
  action = null,
}: {
  id: string;
  title: string;
  about: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="set-head">
      <div className="set-head-text">
        <h2 id={`set-${id}-h`}>{title}</h2>
        <p className="summary">{about}</p>
      </div>
      {action}
    </div>
  );
}

/** A part of a section card: a small heading (with its count) over its body. */
function Part({
  id: key,
  title,
  count,
  children,
  cls = "",
}: {
  id: string;
  title: string;
  count: number | null;
  children: ReactNode;
  cls?: string;
}) {
  const id = `set-h-${key}`;
  return (
    <section className={`set-part${cls ? ` ${cls}` : ""}`} aria-labelledby={id}>
      <h3 id={id}>
        {title}
        {count == null ? null : <span className="n">{` · ${count}`}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A round badge with a name's first letter (decorative: the name is next to it). */
function Avatar({ name }: { name: string }) {
  const first = name.trim().charAt(0).toUpperCase();
  return (
    <span className="set-avatar" aria-hidden="true">
      {first || <Icon name="person" size={16} width={1.8} />}
    </span>
  );
}

function copy(text: string, what: string): void {
  // No Clipboard API over plain HTTP on a network address: show the text instead of doing nothing.
  if (!navigator.clipboard) return say(`Copy it by hand: ${text}`);
  void navigator.clipboard.writeText(text).then(
    () => say(`${what} is copied.`),
    () => say(`Copy it by hand: ${text}`),
  );
}

/** A command to type at a terminal, with a Copy button. */
function Command({ cmd }: { cmd: string }) {
  return (
    <div className="set-cmd">
      <code>{cmd}</code>
      <button
        type="button"
        className="btn"
        aria-label={`Copy ${cmd}`}
        onClick={() => copy(cmd, "The command")}
      >
        Copy
      </button>
    </div>
  );
}

/** A button: `btn ghost` unless `cls` says `btn`, `btn primary`, `btn text` (a link-like word), plus `danger` for red. */
function Button({
  onClick,
  cls = "btn ghost",
  label,
  children,
}: {
  onClick: () => unknown;
  cls?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <button type="button" className={cls} aria-label={label} onClick={() => void onClick()}>
      {children}
    </button>
  );
}

/** The notes mode to send: the owner's choice when they changed the selector, else nothing. */
function chosenAuto(mode: HTMLSelectElement | null): boolean | undefined {
  return mode?.dataset.touched ? mode.value === "auto" : undefined;
}

/** Who a scope reaches, as a select: this page (when there is one), a project, or every page. */
function scopeOptions(
  projects: ProjectSummary[],
  page: boolean,
  pageProject: { id: string; name: string } | null,
): [string, string][] {
  const out: [string, string][] = [];
  if (page) out.push(["page", "This page"]);
  if (pageProject) out.push([`project:${pageProject.id}`, `Every page in ${pageProject.name}`]);
  else for (const p of projects) out.push([`project:${p.id}`, `Every page in ${p.name}`]);
  out.push(["all", "Every page"]);
  return out;
}

/** `{scope, project?}` from a scope select's value. */
function scopeBody(value: string): { scope: string; project?: string } {
  return value.startsWith("project:")
    ? { scope: "project", project: value.slice("project:".length) }
    : { scope: value };
}

const NOTES: [string, string][] = [
  ["hold", "Hold notes for me"],
  ["auto", "Send notes straight to the agent"],
];

/** Run a change, say how it went, and read again; true when the server took it. */
type Act = <T>(route: string, body: object, ok: (data: T) => string) => Promise<boolean>;

const act: Act = async (route, body, ok) => {
  const r = await send<never>(route, body);
  say(r.ok ? ok(r.data) : r.error);
  if (r.ok) reload();
  return r.ok;
};

// ── People and access ──

function RequestRow({
  q,
  projects,
  defaultMode,
}: {
  q: AccessRequestSummary;
  projects: ProjectSummary[];
  defaultMode: string;
}) {
  const scope = useRef<HTMLSelectElement>(null);
  const mode = useRef<HTMLSelectElement>(null);
  const page = q.file ? tilde(q.file) : "a page no longer in the hub";
  const from = [
    q.verifiedLogin
      ? `${q.verifiedLogin}${q.tailscaleDevice ? ` on ${q.tailscaleDevice}` : ""} (verified by Tailscale)`
      : null,
    q.addr,
    q.host ? `(${q.host})` : null,
    q.browser,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="set-ask" data-request={q.id}>
      <Avatar name={q.name} />
      <div className="set-who">
        <span className="row-title">{q.name}</span>
        <span className="meta">{`Asks for ${page} · ${when(q.createdAt)}`}</span>
        {from ? <span className="meta">{from}</span> : null}
      </div>
      <div className="set-actions">
        <Select
          ref={scope}
          name="scope"
          options={scopeOptions(projects, Boolean(q.file), q.project)}
          value="page"
          label={`What ${q.name} can review`}
        />
        <Select
          ref={mode}
          key={defaultMode}
          name="mode"
          options={NOTES}
          value={defaultMode}
          label={`Where ${q.name}'s notes go`}
        />
        <Button
          cls="btn primary"
          onClick={() =>
            act<{ device?: AccessSummary }>(
              `/hub/api/people/requests/${q.id}/approve`,
              { ...scopeBody(scope.current?.value ?? "page"), auto: chosenAuto(mode.current) },
              (d) =>
                `${q.name} is in: ${d.device?.reaches ?? "approved"}. The browser that asked opens the page by itself.`,
            )
          }
        >
          Approve
        </Button>
        <Button
          onClick={() =>
            act(
              `/hub/api/people/requests/${q.id}/deny`,
              {},
              () => `Denied ${q.name}. That browser may ask again.`,
            )
          }
        >
          Deny
        </Button>
        <Button
          cls="btn ghost danger"
          onClick={() =>
            act(
              `/hub/api/people/requests/${q.id}/block`,
              {},
              () => `Blocked ${q.name}'s browser: it can no longer ask.`,
            )
          }
        >
          Block
        </Button>
      </div>
    </li>
  );
}

function SwitchBox({ label, on, project }: { label: string; on: boolean; project: string | null }) {
  return (
    <label className="switch">
      <span className="set-switch-text">{label}</span>
      <Toggle
        on={on}
        onChange={(checked) =>
          void act(
            "/hub/api/people/requests/switch",
            project ? { on: checked, project } : { on: checked },
            () =>
              `Requests ${checked ? "on" : "off"} ${project ? `for ${label}` : "for every page"}.`,
          )
        }
      />
    </label>
  );
}

function LinkRow({ l }: { l: AccessSummary }) {
  return (
    <li className="set-line" data-link={l.id}>
      <div className="set-who">
        <span className="row-title">{l.name}</span>
        <span className="meta">
          {`Reaches ${l.reaches} · ${l.auto ? "notes go straight to the agent" : "notes held for you"} · ${l.reusable ? "old-style link: any browser can use it, no expiry" : `made ${when(l.createdAt)}, expires ${when(l.expiresAt)}`}`}
        </span>
      </div>
      <div className="set-actions">
        {l.link ? (
          <Button cls="btn" onClick={() => copy(l.link as string, `${l.name}'s link`)}>
            Copy link
          </Button>
        ) : null}
        {l.reusable ? (
          <Button
            onClick={() =>
              act<AccessSummary>(
                `/hub/api/people/${l.id}/single-use`,
                {},
                () =>
                  `${l.name}'s link now works once and expires in 7 days. Send the new link; the old one stopped.`,
              )
            }
          >
            Make single-use
          </Button>
        ) : null}
        <Button
          label={`Cancel ${l.name}'s link`}
          onClick={() =>
            act(`/hub/api/people/${l.id}/revoke`, {}, () => `Cancelled ${l.name}'s link.`)
          }
        >
          Cancel link
        </Button>
      </div>
    </li>
  );
}

/** One cell of the Devices table; its label is read out, and shown when the table stacks on a narrow screen. */
function Cell({
  label,
  value,
  meta = null,
}: {
  label: string;
  value: string;
  meta?: string | null;
}) {
  return (
    <div className="set-cell">
      <span className="set-lbl">{`${label}: `}</span>
      <span>{value}</span>
      {meta ? <span className="meta">{meta}</span> : null}
    </div>
  );
}

function DeviceRow({ d, projects }: { d: AccessSummary; projects: ProjectSummary[] }) {
  const rename = (): void => {
    const name = prompt(`New name for ${d.name}`, d.name);
    if (name && name.trim() && name.trim() !== d.name)
      void act<AccessSummary>(
        `/hub/api/people/${d.id}/rename`,
        { name: name.trim() },
        (s) => `Renamed ${d.name} to ${s.name}.`,
      );
  };
  const where = d.lastAddr ? `from ${d.lastAddr}${d.lastHost ? ` (${d.lastHost})` : ""}` : null;
  return (
    <li className="set-dev" data-device={d.id}>
      <div className="set-cell name">
        <span className="row-title">{d.name}</span>
        {d.verifiedLogin ? (
          <span className="meta verified">{`Tailscale: ${d.verifiedLogin} (verified)`}</span>
        ) : null}
      </div>
      <Cell label="Got in by" value={GOT_IN[d.origin] ?? d.origin} meta={when(d.claimedAt)} />
      <Cell label="Reaches" value={d.reaches} />
      <Cell label="Notes go" value={d.auto ? "Straight to the agent" : "Held for you"} />
      <Cell
        label="Last seen"
        value={d.lastSeenAt ? when(d.lastSeenAt) : "Not seen yet"}
        meta={where}
      />
      <div className="set-actions">
        <ViewLink
          next={{ view: "notes", device: d.id, project: "", q: "", status: "", author: "" }}
        >
          {`Notes by ${d.name}`}
        </ViewLink>
        <Button cls="btn text" label={`Rename ${d.name}`} onClick={rename}>
          Rename
        </Button>
        <Button
          cls="btn text danger"
          label={`Revoke ${d.name}`}
          onClick={() =>
            confirm(`Revoke ${d.name}? Their open pages stop at once.`) &&
            act(
              `/hub/api/people/${d.id}/revoke`,
              {},
              () => `Revoked ${d.name}. Their open pages stopped.`,
            )
          }
        >
          Revoke
        </Button>
        <Select
          name="scope"
          options={[["", "Change what they reach…"], ...scopeOptions(projects, false, null)]}
          value=""
          label={`What ${d.name} can review`}
          onChange={(v) => {
            if (v)
              void act<AccessSummary>(
                `/hub/api/people/${d.id}/scope`,
                scopeBody(v),
                (s) => `${d.name} now reaches ${s.reaches}.`,
              );
          }}
        />
      </div>
    </li>
  );
}

/** Settings → People → New link: a named link for a page, its project or every page, as the review page's Share makes it. */
function NewLinkForm({
  pages,
  projects,
  defaultMode,
  reachable,
}: {
  pages: ShellPage[];
  projects: ProjectSummary[];
  defaultMode: string;
  reachable: boolean;
}) {
  const [pageId, setPageId] = useState(pages[0]?.open_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const mode = useRef<HTMLSelectElement>(null);
  if (!reachable)
    return (
      <Empty>
        Only this computer can reach the server, so a link would not open anywhere else. See
        Network.
      </Empty>
    );
  if (!pages.length)
    return (
      <Empty>No page is open for review yet. Open one, then share it here or from its menu.</Empty>
    );
  const chosen = pages.find((x) => x.open_id === pageId);
  const pageProject = chosen ? { id: chosen.project_id, name: chosen.project } : null;
  return (
    <div className="set-form">
      <form
        className="new-link"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          const r = await send<ShareResponse>("/hub/api/people/share", {
            page: String(f.get("page")),
            name: String(f.get("name")),
            ...scopeBody(String(f.get("scope"))),
            auto: chosenAuto(mode.current),
          });
          if (!r.ok) return setError(r.error);
          setError(null);
          form.reset();
          setPageId(pages[0]?.open_id ?? "");
          const made = r.data;
          // The new link is listed under "Links nobody has opened yet" once Settings reads again; the status line keeps it at hand.
          say(
            `Link for ${made.name}, reaching ${made.reaches}: ${made.link} — works once, until ${new Date(made.expiresAt).toLocaleString()} if nobody opens it. Send it only to ${made.name}.`,
            { label: "Copy link", onClick: () => copy(made.link, "The link") },
          );
          reload();
        }}
      >
        <Field label="Name">
          <input
            type="text"
            name="name"
            maxLength={40}
            required
            placeholder="Their name"
            aria-label="Their name"
            autoComplete="off"
          />
        </Field>
        <Field label="Page">
          <select
            name="page"
            aria-label="Page"
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
          >
            {pages.map((p) => (
              <option key={p.open_id} value={p.open_id}>
                {`${p.title || p.rel_path} · ${p.project}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="They can review">
          {/* New options per page: the choice starts again at the first. */}
          <select key={pageId} name="scope" aria-label="They can review">
            {scopeOptions(projects, true, pageProject).map(([v, text]) => (
              <option key={v} value={v}>
                {text}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Their notes">
          <Select
            ref={mode}
            key={defaultMode}
            name="mode"
            options={NOTES}
            value={defaultMode}
            label="Their notes"
          />
        </Field>
        <button type="submit" className="btn primary">
          Create link
        </button>
      </form>
      <p className="error" role="alert" hidden={error == null}>
        {error}
      </p>
    </div>
  );
}

// ── Network ──

const KIND: Record<string, string> = {
  this_computer: "this computer",
  tailscale: "Tailscale",
  local_network: "local network, reviewers only",
  added: "added at a terminal",
};
const FROM: Record<string, string> = {
  link_url: "set by AUSTERE_AXI_LINK_URL",
  link_host: "set by AUSTERE_AXI_LINK_HOST",
  tailscale: "this computer's Tailscale address",
  host: "the address AUSTERE_AXI_HOST names",
  lan: "the local-network address you switched on",
};

/**
 * Settings → Network → Names from Tailscale (RLM-399): what Tailscale tells about reviewers here, and a
 * form that lets a Tailscale login in without a link (`share tailscale <login>`).
 */
function TailscaleNames({
  on,
  projects,
  defaultMode,
}: {
  on: boolean;
  projects: ProjectSummary[];
  defaultMode: string;
}) {
  const mode = useRef<HTMLSelectElement>(null);
  const reach = scopeOptions(projects, false, null);
  const status = on
    ? "On: a reviewer who comes in over Tailscale is named by Tailscale (login and device, shown as verified). Asked only for connections to this server's Tailscale address, never from a header."
    : "Off: the server does not listen on Tailscale here, so nobody is named by it. A reviewer is known by the device you let in.";
  return (
    <>
      <span className="set-title">Names from Tailscale</span>
      <span className="meta">{status}</span>
      <p className="meta">
        <Words text="A Tailscale login gets in without a link or a request: any device signed in to Tailscale as that login opens what it reaches, over Tailscale only. At a terminal: `austere-axi share tailscale <login> --all`." />
      </p>
      <form
        className="login-form"
        data-form="tailscale-login"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          const ok = await act<AccessSummary>(
            "/hub/api/people/tailscale",
            {
              login: String(f.get("login")).trim(),
              name: String(f.get("name")).trim() || undefined,
              ...scopeBody(String(f.get("scope"))),
              auto: chosenAuto(mode.current),
            },
            (d) =>
              `${d.verifiedLogin ?? d.name} is in on any of their Tailscale devices: ${d.reaches}. Listed under Devices; Revoke there.`,
          );
          if (ok) form.reset();
        }}
      >
        <Field label="Tailscale login">
          <input
            type="text"
            name="login"
            maxLength={200}
            required
            placeholder="ana@example.com"
            aria-label="Tailscale login"
            autoComplete="off"
          />
        </Field>
        <Field label="Name">
          <input
            type="text"
            name="name"
            maxLength={40}
            placeholder="Name to show (default: the login)"
            aria-label="Name to show"
            autoComplete="off"
          />
        </Field>
        <Field label="They can review">
          <Select name="scope" options={reach} value={reach[0][0]} label="They can review" />
        </Field>
        <Field label="Their notes">
          <Select
            ref={mode}
            key={defaultMode}
            name="mode"
            options={NOTES}
            value={defaultMode}
            label="Their notes"
          />
        </Field>
        <button type="submit" className="btn">
          Let in
        </button>
      </form>
    </>
  );
}

/** The text the local-network switch shows (P6). */
const LAN_WARNING =
  "Traffic on this network is not encrypted. Others on the same network could read pages, notes and reviewers' access. Use it on a network you trust, or use Tailscale or HTTPS.";

/** Settings → Network → Local network (P6): off by default; on, the server also listens on the chosen address, for reviewers only. */
function LocalNetworkBlock({ lan }: { lan: LocalNetwork }) {
  const address = useRef<HTMLSelectElement>(null);
  const on = lan.address != null;
  // The address switched on stays listed when this computer no longer has it, so the owner can switch it off.
  const options: [string, string][] = lan.choices.map((c) => [
    c.address,
    `${c.address} (${c.iface})`,
  ]);
  if (lan.address && !options.some(([a]) => a === lan.address))
    options.unshift([lan.address, `${lan.address} (not on this computer now)`]);
  const state = !on
    ? "off"
    : lan.listening
      ? `on at ${lan.url}`
      : `on, but this computer does not have ${lan.address} now`;
  return (
    <>
      <label className="switch">
        <span className="set-switch-text">
          <span className="set-title">Local network</span>
          <span className="meta">{`Listen on the local network: ${state}`}</span>
        </span>
        <Toggle
          on={on}
          disabled={!options.length}
          describedBy="lan-warn"
          onChange={(checked, undo) => {
            const chosen = address.current?.value ?? "";
            if (checked && !confirm(`Listen on ${chosen}? ${LAN_WARNING}`)) return undo();
            void act<ProjectActionResult>(
              "/hub/api/settings/network",
              { lan: checked ? chosen : null },
              (d) => d.message,
            );
          }}
        />
      </label>
      {options.length ? (
        <div className="login-form">
          <label className="field">
            <span>Address</span>
            <select
              ref={address}
              key={lan.address ?? ""}
              name="lan-address"
              aria-label="Address on the local network"
              defaultValue={lan.address ?? options[0]?.[0] ?? ""}
              disabled={on || !options.length}
            >
              {options.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <span className="meta">This computer is on no local network.</span>
      )}
      <p className="meta" id="lan-warn">
        <Words
          text={`Reviewers only: the owner never signs in there, and no link with the owner key points there. ${LAN_WARNING} At a terminal: \`austere-axi server lan <address>\`.`}
        />
      </p>
    </>
  );
}

// ── Review defaults ──

function ModeOption({
  value,
  text,
  about,
  defaultMode,
}: {
  value: string;
  text: string;
  about: string;
  defaultMode: string;
}) {
  const id = `set-mode-${value}`;
  return (
    <div className="set-opt">
      <input
        key={defaultMode}
        type="radio"
        id={id}
        name="default-mode"
        value={value}
        defaultChecked={value === defaultMode}
        aria-describedby={`${id}-d`}
        onChange={() =>
          void act<ProjectActionResult>(
            "/hub/api/settings/review",
            { auto: value === "auto" },
            (d) => d.message,
          )
        }
      />
      <label htmlFor={id}>{text}</label>
      <span className="meta" id={`${id}-d`}>
        {about}
      </span>
    </div>
  );
}

// ── Projects ──

function ProjectRow({ p, gone }: { p: ProjectSummary; gone: Set<string> }) {
  const rename = (): void => {
    const name = prompt(`New name for ${p.name}`, p.name);
    if (name && name.trim() && name.trim() !== p.name)
      void act<ProjectActionResult>(
        `/hub/api/projects/${p.id}/rename`,
        { name: name.trim() },
        (d) => d.message,
      );
  };
  return (
    <li className="set-line" data-project={p.id}>
      <div className="set-who">
        <span className="row-title">
          {p.name}
          <span className="set-dim">{` · ${plural(p.pages, "page")} · ${plural(p.roots.length, "folder")}`}</span>
        </span>
        <ul className="plain folders">
          {p.roots.map((root) => {
            const missing = gone.has(root);
            return (
              <li key={root} className={missing ? "gone" : ""}>
                <code title={root}>{tilde(root)}</code>
                {missing ? <span className="set-gone">folder is gone</span> : null}
                {p.roots.length > 1 || missing ? (
                  <Button
                    cls={missing ? "btn" : "btn text"}
                    label={`Forget the folder ${root}`}
                    onClick={() =>
                      (!missing ||
                        confirm(
                          `${root} is gone. Forget it and archive its pages? Their notes are kept.`,
                        )) &&
                      act<ProjectActionResult>(
                        `/hub/api/projects/${p.id}/forget-root`,
                        { root, drop: missing },
                        (d) => d.message,
                      )
                    }
                  >
                    {missing ? "Forget the missing folder" : "Forget"}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {p.same_as ? (
          <p className="same">
            {`Same repository as ${p.same_as.name}. `}
            <Button
              onClick={() =>
                confirm(
                  `Move the folders and pages of ${p.name} into ${p.same_as!.name}? ${p.name} goes away.`,
                ) &&
                act<ProjectActionResult>(
                  `/hub/api/projects/${p.same_as!.id}/merge`,
                  { from: p.id },
                  (d) => d.message,
                )
              }
            >
              {`Merge into ${p.same_as.name}`}
            </Button>
          </p>
        ) : null}
      </div>
      <div className="set-actions">
        <Button label={`Rename ${p.name}`} onClick={rename}>
          Rename
        </Button>
      </div>
    </li>
  );
}

// ── the page ──

interface Loaded {
  settings: SettingsResponse;
  access: ShareListResponse;
  asks: AccessRequestsResponse;
  projects: ProjectSummary[];
  pages: ShellPage[];
}

async function loadSettings(_: null, signal: AbortSignal): Promise<Loaded> {
  const [settings, access, asks, projectList, pageList] = await Promise.all([
    get<SettingsResponse>("/hub/api/settings", signal),
    get<ShareListResponse>("/hub/api/people", signal),
    get<AccessRequestsResponse>("/hub/api/people/requests", signal),
    get<ProjectsResponse>("/hub/api/projects", signal),
    get<PagesResponse>("/hub/api/pages", signal),
  ]);
  return { settings, access, asks, projects: projectList.projects, pages: pageList.pages };
}

export function SettingsView(): ReactElement | null {
  const { loaded, error } = useLoad(null, loadSettings);
  if (error) return <p className="error">{error}</p>;
  if (!loaded) return null;
  return <SettingsPage {...loaded.data} />;
}

function SettingsPage({ settings, access, asks, projects, pages }: Loaded): ReactElement {
  const defaultMode = settings.review.auto ? "auto" : "hold";
  const net = settings.network;
  const waiting = asks.waiting.length;
  const always = net.always_on;
  const alwaysText =
    always.mode === "service"
      ? `On: ${always.supervisor === "launchd" ? "launchd" : "systemd"} runs it${always.unit ? ` (${always.unit})` : ""} and starts it again when it stops.`
      : always.mode === "kept_on"
        ? "On while this process runs: it was started to stay on, but no service starts it again after a restart of the computer."
        : `Off: it stops after ${plural(always.idle_minutes ?? 30, "minute")} without use, and the next command starts it again.`;
  const ownSwitch = new Map(asks.switch.projects.map((p) => [p.id, p.on]));
  const viewing = settings.review.viewing;
  const gone = new Set(settings.gone_folders);
  const c = settings.cloud;
  const toNewLink = (): void => {
    const el = document.getElementById("set-h-new-link")?.parentElement;
    el?.scrollIntoView({ block: "start" });
    el?.querySelector<HTMLInputElement>("input[name=name]")?.focus({ preventScroll: true });
  };

  return (
    <div className="set-page">
      <div className="set-top">
        <h1>Settings</h1>
        <p className="summary">
          This server only: who can review, where it is reachable, and how. Hosted pages keep their
          own invites.
        </p>
      </div>
      <nav className="set-nav" aria-label="Settings sections">
        {/* In-page jumps without a fragment: a fragment change is a popstate, and the shell would read the view again. */}
        {PARTS.map((p) => {
          const n = p.id === "people" ? waiting : 0;
          return (
            <a
              key={p.id}
              href={`#set-${p.id}`}
              className={n ? "waiting" : ""}
              aria-label={n ? `${p.label}, ${n} waiting` : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(`set-${p.id}`)?.scrollIntoView({ block: "start" });
              }}
            >
              {p.label}
              {n ? <span className="n">{n}</span> : null}
            </a>
          );
        })}
      </nav>

      <section id="set-people" className="set" aria-labelledby="set-people-h">
        <CardHead
          id="people"
          title="People and access"
          about={
            <Words text="Who may open your pages from another device, and what they reach. A link works for one browser: the first one that opens it. At a terminal: `austere-axi share`." />
          }
          action={
            <button type="button" className="btn" onClick={toNewLink}>
              <ShapeIcon shapes={PLUS} size={14} width={2} />
              New link
            </button>
          }
        />
        <Part
          id="waiting"
          title="Waiting for access"
          count={waiting}
          cls={waiting ? "waiting" : ""}
        >
          {waiting ? (
            <ul className="set-asks">
              {asks.waiting.map((q) => (
                <RequestRow key={q.id} q={q} projects={projects} defaultMode={defaultMode} />
              ))}
            </ul>
          ) : (
            <Empty>Nobody is asking.</Empty>
          )}
        </Part>
        <Part id="links" title="Links nobody has opened yet" count={access.links.length}>
          {access.links.length ? (
            <ul className="set-lines">
              {access.links.map((l) => (
                <LinkRow key={l.id} l={l} />
              ))}
            </ul>
          ) : (
            <Empty>None.</Empty>
          )}
        </Part>
        <Part id="devices" title="Devices with access" count={access.devices.length}>
          {access.devices.length ? (
            <div className="set-devices">
              <div className="set-dev-head" aria-hidden="true">
                {["Device", "Got in by", "Reaches", "Notes go", "Last seen", ""].map((t, i) => (
                  <span key={i}>{t}</span>
                ))}
              </div>
              <ul className="set-dev-list">
                {access.devices.map((d) => (
                  <DeviceRow key={d.id} d={d} projects={projects} />
                ))}
              </ul>
            </div>
          ) : (
            <Empty>No device has access yet.</Empty>
          )}
        </Part>
        <Part id="new-link" title="New link" count={null}>
          <NewLinkForm
            pages={pages}
            projects={projects}
            defaultMode={defaultMode}
            reachable={net.share != null}
          />
        </Part>
        {asks.blocked.length ? (
          <Part id="blocked" title="Blocked" count={asks.blocked.length}>
            <ul className="set-lines">
              {asks.blocked.map((q) => (
                <li key={q.id} className="set-line">
                  <div className="set-who">
                    <span className="row-title">{q.name}</span>
                    <span className="meta">
                      {[q.addr, q.host, q.browser, when(q.decidedAt)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Part>
        ) : null}
        <Part
          id="ask"
          title="Browsers without a link may ask for access"
          count={null}
          cls="set-asking"
        >
          <div className="switches">
            <SwitchBox label="Every page" on={asks.switch.all} project={null} />
            {projects.length ? (
              <p className="meta">A project's own choice wins over every page's:</p>
            ) : null}
            {projects.map((p) => (
              <SwitchBox
                key={p.id}
                label={p.name}
                on={ownSwitch.get(p.id) ?? asks.switch.all}
                project={p.id}
              />
            ))}
          </div>
        </Part>
      </section>

      <div className="set-grid">
        <section id="set-network" className="set" aria-labelledby="set-network-h">
          <CardHead
            id="network"
            title="Network"
            about="Where this server can be reached. It never listens on every address."
          />
          <div className="set-block">
            <span className="set-label">Answers on</span>
            <ul className="plain set-addrs">
              {net.addresses.map((a) => (
                <li key={a.url} data-kind={a.kind}>
                  <code>{a.url}</code>
                  <span className="k">{KIND[a.kind]}</span>
                  {net.share?.url === a.url ? (
                    <span className="set-pill">Address to share</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <div className="set-block">
            <span className="set-label">Address to share</span>
            <div className="share-addr">
              {net.share ? (
                <>
                  <code>{net.share.url}</code>
                  <Button cls="btn" onClick={() => copy(net.share!.url, "The address")}>
                    Copy
                  </Button>
                  <span className="meta">{FROM[net.share.from]}</span>
                </>
              ) : (
                <span className="warn">
                  None: only this computer can reach the server, so no link can be shared. Start
                  Tailscale, switch on the local network below, or set AUSTERE_AXI_HOST at a
                  terminal.
                </span>
              )}
            </div>
          </div>
          <div className="set-block">
            <span className="set-label">Tailscale</span>
            <span>
              {net.tailscale
                ? `${net.tailscale.dns_name ? `${net.tailscale.dns_name} · ` : ""}${net.tailscale.ip}`
                : "Not running here."}
            </span>
          </div>
          <div className="set-block setting" data-slot="tailscale-identity">
            <TailscaleNames
              on={net.tailscale_names}
              projects={projects}
              defaultMode={defaultMode}
            />
          </div>
          <div className="set-block setting" data-slot="local-network">
            <LocalNetworkBlock lan={net.lan} />
          </div>
          <div className="set-block" data-always={always.mode}>
            <span className="set-title">Always on</span>
            <span className="meta">{alwaysText}</span>
            {always.mode === "service" ? null : (
              <>
                <span className="meta">To keep it running, at a terminal:</span>
                <Command cmd="austere-axi server install" />
              </>
            )}
          </div>
        </section>

        <div className="set-col">
          <section id="set-review" className="set" aria-labelledby="set-review-h">
            <CardHead
              id="review"
              title="Review defaults"
              about={
                <Words text="For reviewers you let in from now on, unless you say otherwise when you share or approve. Those already in keep their own. At a terminal: `austere-axi share default hold|auto`." />
              }
            />
            <fieldset className="modes">
              <legend>A new reviewer's notes</legend>
              <ModeOption
                value="hold"
                text="Hold them for me"
                about="You read each note and decide which ones the agent gets"
                defaultMode={defaultMode}
              />
              <ModeOption
                value="auto"
                text="Send them straight to the agent"
                about="Not available on pages an agent is attached to"
                defaultMode={defaultMode}
              />
            </fieldset>
            <Part id="viewing" title="On pages now" count={viewing.length}>
              {viewing.length ? (
                <ul className="set-viewing">
                  {viewing.map((v) => (
                    <li key={v.id}>
                      <a className="row-title" href={`/hub/open/${v.id}`} title={v.file}>
                        {v.title}
                      </a>
                      <span className="meta">
                        {v.viewers.map((x) => (x.role === "owner" ? "you" : x.name)).join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Nobody has a page open.</Empty>
              )}
            </Part>
          </section>

          <section id="set-cloud" className="set" aria-labelledby="set-cloud-h">
            <CardHead
              id="cloud"
              title="Cloud"
              about={
                <Words text="Hosted share links: `publish`, `clone`, `cloud login` and the sync of hosted pages. Off by default; off, only local features work and nothing reaches the hosted service. At a terminal: `austere-axi cloud on|off`." />
              }
            />
            <div className="set-block setting" data-slot="cloud">
              <label className="switch">
                <span className="set-switch-text">
                  <span className="set-title">Cloud features</span>
                  <span className="meta" id="set-cloud-state">
                    {c.on ? `On: talks to ${c.service}.` : "Off: only local features work."}
                  </span>
                </span>
                <Toggle
                  on={c.on}
                  describedBy="set-cloud-state"
                  onChange={(checked, undo) => {
                    if (
                      !checked &&
                      c.published &&
                      !confirm(
                        `Turn cloud features off? Pages published from this machine (${c.published}) stay up on the service, but their notes stop reaching you here until you turn cloud back on.`,
                      )
                    )
                      return undo();
                    void act<ProjectActionResult>(
                      "/hub/api/settings/cloud",
                      { on: checked },
                      (d) => d.message,
                    );
                  }}
                />
              </label>
              {c.account ? <span className="meta">{`Signed in as ${c.account}.`}</span> : null}
              {c.published ? (
                <span className="meta">
                  {`${plural(c.published, "page")} published from this machine${c.on ? "." : ": still up on the service, not synced while cloud is off."}`}
                </span>
              ) : null}
            </div>
          </section>

          <section id="set-about" className="set" aria-labelledby="set-about-h">
            <div className="set-head">
              <h2 id="set-about-h">About</h2>
            </div>
            <dl className="facts">
              <dt>Version</dt>
              <dd>{settings.about.version}</dd>
              <dt>State folder</dt>
              <dd>
                <code title={settings.about.state_dir}>{tilde(settings.about.state_dir)}</code>
              </dd>
              <dt>Port</dt>
              <dd>{String(net.port)}</dd>
            </dl>
            <div className="set-block">
              {settings.about.newer_cli ? (
                <p className="warn note-older">
                  <Words
                    text={`This server runs ${settings.about.version}, older than the austere-axi ${settings.about.newer_cli} you use at the terminal. Restart it to update: \`austere-axi server restart\`.`}
                  />
                </p>
              ) : null}
              <p className="meta">
                <Words text="Stays at a terminal: anything that runs a command, such as `server install`, `adapter set` and `trigger add`." />
              </p>
            </div>
          </section>
        </div>
      </div>

      <section id="set-projects" className="set" aria-labelledby="set-projects-h">
        <CardHead
          id="projects"
          title="Projects"
          about={
            <Words text="A project is a name and the folders its pages live in. Worktrees of one repository share a project. At a terminal: `austere-axi project`." />
          }
        />
        {projects.length ? (
          <ul className="set-lines set-flush">
            {projects.map((p) => (
              <ProjectRow key={p.id} p={p} gone={gone} />
            ))}
          </ul>
        ) : (
          <div className="set-block">
            <Empty>No projects yet.</Empty>
          </div>
        )}
        <div className="missing set-foot">
          {settings.missing ? (
            <Fragment>
              <span>
                {`${plural(settings.missing, "page")} opened for review ${settings.missing === 1 ? "has" : "have"} a file that is gone. Archiving keeps ${settings.missing === 1 ? "its" : "their"} notes.`}
              </span>
              <Button
                onClick={() =>
                  act<ProjectActionResult>(
                    "/hub/api/projects/archive-missing",
                    {},
                    (d) => d.message,
                  )
                }
              >
                Archive missing pages
              </Button>
            </Fragment>
          ) : (
            <span>No page opened for review has a missing file.</span>
          )}
        </div>
      </section>
    </div>
  );
}
