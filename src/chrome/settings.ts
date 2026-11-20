// Settings (RLM-396): the owner's page for this local server, a view of the hub shell (shell.ts). People
// (links, devices, requests: /hub/api/people), Network, Review defaults, Cloud, Projects and About (/hub/api/settings).
// Nothing here runs a command: what names one (`server install`, `adapter set`, `trigger add`) stays at a
// terminal. Every setting here has a CLI form too; the hints name it.
// Drawn from the Hub-Settings artboard: each part is a card, People across the top, Network beside Review
// defaults, Cloud and About, Projects below.
import { h } from "./dom.ts";
import type { Child } from "./dom.ts";
import { icon, svgIcon } from "./icons.ts";
import type { Shape } from "./icons.ts";
import type { LocalNetwork, PagesResponse, ProjectActionResult, ProjectSummary, ProjectsResponse, SettingsResponse, ShellPage } from "../shared/hub-api.ts";
import type { AccessRequestSummary, AccessRequestsResponse, AccessSummary, ShareListResponse, ShareResponse } from "../cli/server.ts";

/** What the shell lends Settings: its status line, its formatting, and a way to read again after a change. */
export interface SettingsUi {
  say(text: string, ...actions: HTMLElement[]): void;
  /** Read and draw Settings and the sidebar again. */
  again(): void;
  when(ms: number | null | undefined): string;
  tilde(p: string): string;
  plural(n: number, one: string, many?: string): string;
  section(title: string, count: number | null, body: Child, extra?: Child, cls?: string): HTMLElement;
  empty(...parts: Child[]): HTMLElement;
  /** A link to the Notes view for one device. */
  notesOf(device: { id: string; name: string }): HTMLAnchorElement;
  /** GET a /hub/api route as the shell does: its errors are the ones the shell shows. */
  get<T>(route: string): Promise<T>;
}

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

/** POST as the owner's page does (same origin): the answer, or the server's error text (or why it could not be reached). */
async function send<T>(route: string, body: object = {}): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: "Could not reach austere-axi. Check that it is still running, then reload." };
  }
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  return r.ok ? { ok: true, data } : { ok: false, error: data.error || `austere-axi answered ${r.status}` };
}

/** How a device got in, as the Devices table's column says it. */
const GOT_IN: Record<string, string> = { link: "Named link", request: "Approved request", tailscale: "Tailscale login" };

/** Text with `backticked` parts as code: a command or a variable the owner types at a terminal. */
function words(text: string): Child[] {
  return text.split("`").map((part, i) => (i % 2 ? h("code", { text: part }) : part));
}

/** A labelled control in a row. */
function field(label: string, control: HTMLElement): HTMLLabelElement {
  return h("label", { class: "field" }, h("span", { text: label }), control);
}

function select(name: string, options: [string, string][], value: string, label: string): HTMLSelectElement {
  const el: HTMLSelectElement = h("select", { name, "aria-label": label }, options.map(([v, text]) => h("option", { value: v, text, selected: v === value })));
  el.addEventListener("change", () => (el.dataset.touched = "1"));
  return el;
}

/** A checkbox drawn as a switch (settings.css `input.toggle`); it stays a checkbox for forms and tests. */
function toggle(on: boolean, attrs: Record<string, string | boolean> = {}): HTMLInputElement {
  return h("input", { type: "checkbox", role: "switch", class: "toggle", checked: on, ...attrs });
}

/** The head of a section card: its title, what it is for, and an action on the right. */
function cardHead(id: string, title: string, about: Child | Child[], action: Child = null): HTMLElement {
  return h("div", { class: "set-head" }, h("div", { class: "set-head-text" }, h("h2", { id: `set-${id}-h`, text: title }), h("p", { class: "summary" }, about)), action);
}

/** A part of a section card: a small heading (with its count) over its body. */
function part(key: string, title: string, count: number | null, body: Child, cls = ""): HTMLElement {
  const id = `set-h-${key}`;
  return h("section", { class: `set-part${cls ? ` ${cls}` : ""}`, "aria-labelledby": id }, h("h3", { id }, title, count == null ? null : h("span", { class: "n", text: ` · ${count}` })), body);
}

/** A round badge with a name's first letter (decorative: the name is next to it). */
function avatar(name: string): HTMLElement {
  const first = name.trim().charAt(0).toUpperCase();
  return h("span", { class: "set-avatar", "aria-hidden": "true" }, first || icon("person", { size: 16, width: 1.8 }));
}

/** A command to type at a terminal, with a Copy button. */
function command(ui: SettingsUi, cmd: string): HTMLElement {
  return h("div", { class: "set-cmd" }, h("code", { text: cmd }), h("button", { type: "button", class: "btn", text: "Copy", "aria-label": `Copy ${cmd}`, onclick: () => copy(ui, cmd, "The command") }));
}

/**
 * The notes mode to send: the owner's choice when they changed the selector, else nothing, so the server
 * applies the saved default itself (and holds the notes where an attached agent rules auto out).
 */
function chosenAuto(mode: HTMLSelectElement): boolean | undefined {
  return mode.dataset.touched ? mode.value === "auto" : undefined;
}

/** Who a scope reaches, as a select: this page (when there is one), a project, or every page. */
function scopeOptions(projects: ProjectSummary[], page: boolean, pageProject: { id: string; name: string } | null): [string, string][] {
  const out: [string, string][] = [];
  if (page) out.push(["page", "This page"]);
  if (pageProject) out.push([`project:${pageProject.id}`, `Every page in ${pageProject.name}`]);
  else for (const p of projects) out.push([`project:${p.id}`, `Every page in ${p.name}`]);
  out.push(["all", "Every page"]);
  return out;
}

/** `{scope, project?}` from a scope select's value. */
function scopeBody(value: string): { scope: string; project?: string } {
  return value.startsWith("project:") ? { scope: "project", project: value.slice("project:".length) } : { scope: value };
}

const NOTES: [string, string][] = [
  ["hold", "Hold notes for me"],
  ["auto", "Send notes straight to the agent"],
];

export async function renderSettings(ui: SettingsUi): Promise<Child[]> {
  const [settings, access, asks, projectList, pageList] = await Promise.all([
    ui.get<SettingsResponse>("/hub/api/settings"),
    ui.get<ShareListResponse>("/hub/api/people"),
    ui.get<AccessRequestsResponse>("/hub/api/people/requests"),
    ui.get<ProjectsResponse>("/hub/api/projects"),
    ui.get<PagesResponse>("/hub/api/pages"),
  ]);
  const projects = projectList.projects;
  const defaultMode = settings.review.auto ? "auto" : "hold";

  /** Run a change, say how it went, and read the page again. */
  const act = async <T>(route: string, body: object, ok: (data: T) => string): Promise<void> => {
    const r = await send<T>(route, body);
    ui.say(r.ok ? ok(r.data) : r.error);
    if (r.ok) ui.again();
  };
  /** A button: `btn` (filled), `btn ghost`, `btn primary`, `btn text` (a link-like word), plus `danger` for red. */
  const button = (text: string, onclick: () => unknown, extra: Record<string, string> = {}): HTMLButtonElement => h("button", { type: "button", class: "btn ghost", text, onclick: () => void onclick(), ...extra });

  // ── People and access ──

  const requestRow = (q: AccessRequestSummary): HTMLElement => {
    const page = q.file ? ui.tilde(q.file) : "a page no longer in the hub";
    const from = [q.verifiedLogin ? `${q.verifiedLogin}${q.tailscaleDevice ? ` on ${q.tailscaleDevice}` : ""} (verified by Tailscale)` : null, q.addr, q.host ? `(${q.host})` : null, q.browser].filter(Boolean).join(" · ");
    const scope = select("scope", scopeOptions(projects, Boolean(q.file), q.project), "page", `What ${q.name} can review`);
    const mode = select("mode", NOTES, defaultMode, `Where ${q.name}'s notes go`);
    return h(
      "li",
      { class: "set-ask", "data-request": q.id },
      avatar(q.name),
      h("div", { class: "set-who" }, h("span", { class: "row-title", text: q.name }), h("span", { class: "meta", text: `Asks for ${page} · ${ui.when(q.createdAt)}` }), from ? h("span", { class: "meta", text: from }) : null),
      h(
        "div",
        { class: "set-actions" },
        scope,
        mode,
        button("Approve", () => act<{ device?: AccessSummary }>(`/hub/api/people/requests/${q.id}/approve`, { ...scopeBody(scope.value), auto: chosenAuto(mode) }, (d) => `${q.name} is in: ${d.device?.reaches ?? "approved"}. The browser that asked opens the page by itself.`), { class: "btn primary" }),
        button("Deny", () => act(`/hub/api/people/requests/${q.id}/deny`, {}, () => `Denied ${q.name}. That browser may ask again.`)),
        button("Block", () => act(`/hub/api/people/requests/${q.id}/block`, {}, () => `Blocked ${q.name}'s browser: it can no longer ask.`), { class: "btn ghost danger" }),
      ),
    );
  };

  const switchBox = (label: string, on: boolean, project: string | null): HTMLLabelElement => {
    const box = toggle(on);
    box.addEventListener("change", () => void act("/hub/api/people/requests/switch", project ? { on: box.checked, project } : { on: box.checked }, () => `Requests ${box.checked ? "on" : "off"} ${project ? `for ${label}` : "for every page"}.`));
    return h("label", { class: "switch" }, h("span", { class: "set-switch-text", text: label }), box);
  };
  const own = new Map(asks.switch.projects.map((p) => [p.id, p.on]));
  const requestsSwitch = h(
    "div",
    { class: "switches" },
    switchBox("Every page", asks.switch.all, null),
    projects.length ? h("p", { class: "meta", text: "A project's own choice wins over every page's:" }) : null,
    projects.map((p) => switchBox(p.name, own.get(p.id) ?? asks.switch.all, p.id)),
  );

  const linkRow = (l: AccessSummary): HTMLElement =>
    h(
      "li",
      { class: "set-line", "data-link": l.id },
      h(
        "div",
        { class: "set-who" },
        h("span", { class: "row-title", text: l.name }),
        h("span", { class: "meta", text: `Reaches ${l.reaches} · ${l.auto ? "notes go straight to the agent" : "notes held for you"} · ${l.reusable ? "old-style link: any browser can use it, no expiry" : `made ${ui.when(l.createdAt)}, expires ${ui.when(l.expiresAt)}`}` }),
      ),
      h(
        "div",
        { class: "set-actions" },
        l.link ? button("Copy link", () => copy(ui, l.link as string, `${l.name}'s link`), { class: "btn" }) : null,
        l.reusable ? button("Make single-use", () => act<AccessSummary>(`/hub/api/people/${l.id}/single-use`, {}, () => `${l.name}'s link now works once and expires in 7 days. Send the new link; the old one stopped.`)) : null,
        button("Cancel link", () => act(`/hub/api/people/${l.id}/revoke`, {}, () => `Cancelled ${l.name}'s link.`), { "aria-label": `Cancel ${l.name}'s link` }),
      ),
    );

  /** One cell of the Devices table; its label is read out, and shown when the table stacks on a narrow screen. */
  const cell = (label: string, value: string, meta: string | null = null): HTMLElement =>
    h("div", { class: "set-cell" }, h("span", { class: "set-lbl", text: `${label}: ` }), h("span", { text: value }), meta ? h("span", { class: "meta", text: meta }) : null);

  const deviceRow = (d: AccessSummary): HTMLElement => {
    const scope = select("scope", [["", "Change what they reach…"], ...scopeOptions(projects, false, null)], "", `What ${d.name} can review`);
    scope.addEventListener("change", () => {
      if (scope.value) void act<AccessSummary>(`/hub/api/people/${d.id}/scope`, scopeBody(scope.value), (s) => `${d.name} now reaches ${s.reaches}.`);
    });
    const rename = (): void => {
      const name = prompt(`New name for ${d.name}`, d.name);
      if (name && name.trim() && name.trim() !== d.name) void act<AccessSummary>(`/hub/api/people/${d.id}/rename`, { name: name.trim() }, (s) => `Renamed ${d.name} to ${s.name}.`);
    };
    const where = d.lastAddr ? `from ${d.lastAddr}${d.lastHost ? ` (${d.lastHost})` : ""}` : null;
    return h(
      "li",
      { class: "set-dev", "data-device": d.id },
      h("div", { class: "set-cell name" }, h("span", { class: "row-title", text: d.name }), d.verifiedLogin ? h("span", { class: "meta verified", text: `Tailscale: ${d.verifiedLogin} (verified)` }) : null),
      cell("Got in by", GOT_IN[d.origin] ?? d.origin, ui.when(d.claimedAt)),
      cell("Reaches", d.reaches),
      cell("Notes go", d.auto ? "Straight to the agent" : "Held for you"),
      cell("Last seen", d.lastSeenAt ? ui.when(d.lastSeenAt) : "Not seen yet", where),
      h(
        "div",
        { class: "set-actions" },
        ui.notesOf({ id: d.id, name: d.name }),
        button("Rename", rename, { class: "btn text", "aria-label": `Rename ${d.name}` }),
        button("Revoke", () => confirm(`Revoke ${d.name}? Their open pages stop at once.`) && act(`/hub/api/people/${d.id}/revoke`, {}, () => `Revoked ${d.name}. Their open pages stopped.`), { class: "btn text danger", "aria-label": `Revoke ${d.name}` }),
        scope,
      ),
    );
  };
  const devices = access.devices.length
    ? h(
        "div",
        { class: "set-devices" },
        h("div", { class: "set-dev-head", "aria-hidden": "true" }, ["Device", "Got in by", "Reaches", "Notes go", "Last seen", ""].map((t) => h("span", { text: t }))),
        h("ul", { class: "set-dev-list" }, access.devices.map(deviceRow)),
      )
    : ui.empty("No device has access yet.");

  const shareForm = newLinkForm(ui, pageList.pages, projects, defaultMode, settings.network.share != null);
  const newLink = part("new-link", "New link", null, shareForm);
  const toNewLink = (): void => {
    newLink.scrollIntoView({ block: "start" });
    newLink.querySelector<HTMLInputElement>("input[name=name]")?.focus({ preventScroll: true });
  };
  const waiting = asks.waiting.length;

  const people = h(
    "section",
    { id: "set-people", class: "set", "aria-labelledby": "set-people-h" },
    cardHead(
      "people",
      "People and access",
      words("Who may open your pages from another device, and what they reach. A link works for one browser: the first one that opens it. At a terminal: `austere-axi share`."),
      h("button", { type: "button", class: "btn", onclick: toNewLink }, svgIcon(PLUS, { size: 14, width: 2 }), "New link"),
    ),
    part("waiting", "Waiting for access", waiting, waiting ? h("ul", { class: "set-asks" }, asks.waiting.map(requestRow)) : ui.empty("Nobody is asking."), waiting ? "waiting" : ""),
    part("links", "Links nobody has opened yet", access.links.length, access.links.length ? h("ul", { class: "set-lines" }, access.links.map(linkRow)) : ui.empty("None.")),
    part("devices", "Devices with access", access.devices.length, devices),
    newLink,
    asks.blocked.length
      ? part(
          "blocked",
          "Blocked",
          asks.blocked.length,
          h(
            "ul",
            { class: "set-lines" },
            asks.blocked.map((q) => h("li", { class: "set-line" }, h("div", { class: "set-who" }, h("span", { class: "row-title", text: q.name }), h("span", { class: "meta", text: [q.addr, q.host, q.browser, ui.when(q.decidedAt)].filter(Boolean).join(" · ") })))),
          ),
        )
      : null,
    part("ask", "Browsers without a link may ask for access", null, requestsSwitch, "set-asking"),
  );

  // ── Network ──

  const net = settings.network;
  const KIND: Record<string, string> = { this_computer: "this computer", tailscale: "Tailscale", local_network: "local network, reviewers only", added: "added at a terminal" };
  const FROM: Record<string, string> = { link_url: "set by AUSTERE_AXI_LINK_URL", link_host: "set by AUSTERE_AXI_LINK_HOST", tailscale: "this computer's Tailscale address", host: "the address AUSTERE_AXI_HOST names", lan: "the local-network address you switched on" };
  const always = net.always_on;
  const alwaysText =
    always.mode === "service"
      ? `On: ${always.supervisor === "launchd" ? "launchd" : "systemd"} runs it${always.unit ? ` (${always.unit})` : ""} and starts it again when it stops.`
      : always.mode === "kept_on"
        ? "On while this process runs: it was started to stay on, but no service starts it again after a restart of the computer."
        : `Off: it stops after ${ui.plural(always.idle_minutes ?? 30, "minute")} without use, and the next command starts it again.`;
  const network = h(
    "section",
    { id: "set-network", class: "set", "aria-labelledby": "set-network-h" },
    cardHead("network", "Network", "Where this server can be reached. It never listens on every address."),
    h(
      "div",
      { class: "set-block" },
      h("span", { class: "set-label", text: "Answers on" }),
      h(
        "ul",
        { class: "plain set-addrs" },
        net.addresses.map((a) =>
          h("li", { "data-kind": a.kind }, h("code", { text: a.url }), h("span", { class: "k", text: KIND[a.kind] }), net.share?.url === a.url ? h("span", { class: "set-pill", text: "Address to share" }) : null),
        ),
      ),
    ),
    h(
      "div",
      { class: "set-block" },
      h("span", { class: "set-label", text: "Address to share" }),
      h(
        "div",
        { class: "share-addr" },
        net.share
          ? [h("code", { text: net.share.url }), button("Copy", () => copy(ui, net.share!.url, "The address"), { class: "btn" }), h("span", { class: "meta", text: FROM[net.share.from] })]
          : h("span", { class: "warn", text: "None: only this computer can reach the server, so no link can be shared. Start Tailscale, switch on the local network below, or set AUSTERE_AXI_HOST at a terminal." }),
      ),
    ),
    h(
      "div",
      { class: "set-block" },
      h("span", { class: "set-label", text: "Tailscale" }),
      h("span", { text: net.tailscale ? `${net.tailscale.dns_name ? `${net.tailscale.dns_name} · ` : ""}${net.tailscale.ip}` : "Not running here." }),
    ),
    h("div", { class: "set-block setting", "data-slot": "tailscale-identity" }, tailscaleNames(net.tailscale_names, projects, defaultMode, act)),
    h("div", { class: "set-block setting", "data-slot": "local-network" }, localNetwork(net.lan, act)),
    h(
      "div",
      { class: "set-block", "data-always": always.mode },
      h("span", { class: "set-title", text: "Always on" }),
      h("span", { class: "meta", text: alwaysText }),
      always.mode === "service" ? null : [h("span", { class: "meta", text: "To keep it running, at a terminal:" }), command(ui, "austere-axi server install")],
    ),
  );

  // ── Review defaults ──

  const modeOption = (value: string, text: string, about: string): HTMLElement => {
    const id = `set-mode-${value}`;
    const input = h("input", { type: "radio", id, name: "default-mode", value, checked: value === defaultMode, "aria-describedby": `${id}-d` });
    input.addEventListener("change", () => void act<ProjectActionResult>("/hub/api/settings/review", { auto: value === "auto" }, (d) => d.message));
    return h("div", { class: "set-opt" }, input, h("label", { for: id, text }), h("span", { class: "meta", id: `${id}-d`, text: about }));
  };
  const viewing = settings.review.viewing;
  const review = h(
    "section",
    { id: "set-review", class: "set", "aria-labelledby": "set-review-h" },
    cardHead("review", "Review defaults", words("For reviewers you let in from now on, unless you say otherwise when you share or approve. Those already in keep their own. At a terminal: `austere-axi share default hold|auto`.")),
    h(
      "fieldset",
      { class: "modes" },
      h("legend", { text: "A new reviewer's notes" }),
      modeOption("hold", "Hold them for me", "You read each note and decide which ones the agent gets"),
      modeOption("auto", "Send them straight to the agent", "Not available on pages an agent is attached to"),
    ),
    part(
      "viewing",
      "On pages now",
      viewing.length,
      viewing.length
        ? h(
            "ul",
            { class: "set-viewing" },
            viewing.map((v) => h("li", {}, h("a", { class: "row-title", href: `/hub/open/${v.id}`, title: v.file, text: v.title }), h("span", { class: "meta", text: v.viewers.map((x) => (x.role === "owner" ? "you" : x.name)).join(", ") }))),
          )
        : ui.empty("Nobody has a page open."),
    ),
  );

  // ── Projects ──

  const gone = new Set(settings.gone_folders);
  const projectRow = (p: ProjectSummary): HTMLElement => {
    const rename = (): void => {
      const name = prompt(`New name for ${p.name}`, p.name);
      if (name && name.trim() && name.trim() !== p.name) void act<ProjectActionResult>(`/hub/api/projects/${p.id}/rename`, { name: name.trim() }, (d) => d.message);
    };
    const folder = (root: string): HTMLElement => {
      const missing = gone.has(root);
      const forget = (): unknown =>
        (!missing || confirm(`${root} is gone. Forget it and archive its pages? Their notes are kept.`)) &&
        act<ProjectActionResult>(`/hub/api/projects/${p.id}/forget-root`, { root, drop: missing }, (d) => d.message);
      return h(
        "li",
        { class: missing ? "gone" : "" },
        h("code", { text: ui.tilde(root), title: root }),
        missing ? h("span", { class: "set-gone", text: "folder is gone" }) : null,
        p.roots.length > 1 || missing ? button(missing ? "Forget the missing folder" : "Forget", forget, { class: missing ? "btn" : "btn text", "aria-label": `Forget the folder ${root}` }) : null,
      );
    };
    return h(
      "li",
      { class: "set-line", "data-project": p.id },
      h(
        "div",
        { class: "set-who" },
        h("span", { class: "row-title" }, p.name, h("span", { class: "set-dim", text: ` · ${ui.plural(p.pages, "page")} · ${ui.plural(p.roots.length, "folder")}` })),
        h("ul", { class: "plain folders" }, p.roots.map(folder)),
        p.same_as
          ? h(
              "p",
              { class: "same" },
              `Same repository as ${p.same_as.name}. `,
              button(`Merge into ${p.same_as.name}`, () => confirm(`Move the folders and pages of ${p.name} into ${p.same_as!.name}? ${p.name} goes away.`) && act<ProjectActionResult>(`/hub/api/projects/${p.same_as!.id}/merge`, { from: p.id }, (d) => d.message)),
            )
          : null,
      ),
      h("div", { class: "set-actions" }, button("Rename", rename, { "aria-label": `Rename ${p.name}` })),
    );
  };
  const projectsPart = h(
    "section",
    { id: "set-projects", class: "set", "aria-labelledby": "set-projects-h" },
    cardHead("projects", "Projects", words("A project is a name and the folders its pages live in. Worktrees of one repository share a project. At a terminal: `austere-axi project`.")),
    projects.length ? h("ul", { class: "set-lines set-flush" }, projects.map(projectRow)) : h("div", { class: "set-block" }, ui.empty("No projects yet.")),
    h(
      "div",
      { class: "missing set-foot" },
      settings.missing
        ? [
            h("span", { text: `${ui.plural(settings.missing, "page")} opened for review ${settings.missing === 1 ? "has" : "have"} a file that is gone. Archiving keeps ${settings.missing === 1 ? "its" : "their"} notes.` }),
            button("Archive missing pages", () => act<ProjectActionResult>("/hub/api/projects/archive-missing", {}, (d) => d.message)),
          ]
        : h("span", { text: "No page opened for review has a missing file." }),
    ),
  );

  // ── Cloud (RLM-421) ──

  const c = settings.cloud;
  const cloudBox = toggle(c.on, { "aria-describedby": "set-cloud-state" });
  cloudBox.addEventListener("change", () => {
    if (!cloudBox.checked && c.published && !confirm(`Turn cloud features off? Pages published from this machine (${c.published}) stay up on the service, but their notes stop reaching you here until you turn cloud back on.`)) {
      cloudBox.checked = true;
      return;
    }
    void act<ProjectActionResult>("/hub/api/settings/cloud", { on: cloudBox.checked }, (d) => d.message);
  });
  const cloudPart = h(
    "section",
    { id: "set-cloud", class: "set", "aria-labelledby": "set-cloud-h" },
    cardHead("cloud", "Cloud", words("Hosted share links: `publish`, `clone`, `cloud login` and the sync of hosted pages. Off by default; off, only local features work and nothing reaches the hosted service. At a terminal: `austere-axi cloud on|off`.")),
    h(
      "div",
      { class: "set-block setting", "data-slot": "cloud" },
      h(
        "label",
        { class: "switch" },
        h("span", { class: "set-switch-text" }, h("span", { class: "set-title", text: "Cloud features" }), h("span", { class: "meta", id: "set-cloud-state", text: c.on ? `On: talks to ${c.service}.` : "Off: only local features work." })),
        cloudBox,
      ),
      c.account ? h("span", { class: "meta", text: `Signed in as ${c.account}.` }) : null,
      c.published ? h("span", { class: "meta", text: `${ui.plural(c.published, "page")} published from this machine${c.on ? "." : ": still up on the service, not synced while cloud is off."}` }) : null,
    ),
  );

  // ── About ──

  const about = h(
    "section",
    { id: "set-about", class: "set", "aria-labelledby": "set-about-h" },
    h("div", { class: "set-head" }, h("h2", { id: "set-about-h", text: "About" })),
    h(
      "dl",
      { class: "facts" },
      h("dt", { text: "Version" }),
      h("dd", { text: settings.about.version }),
      h("dt", { text: "State folder" }),
      h("dd", {}, h("code", { text: ui.tilde(settings.about.state_dir), title: settings.about.state_dir })),
      h("dt", { text: "Port" }),
      h("dd", { text: String(net.port) }),
    ),
    h(
      "div",
      { class: "set-block" },
      settings.about.newer_cli
        ? h("p", { class: "warn note-older" }, words(`This server runs ${settings.about.version}, older than the austere-axi ${settings.about.newer_cli} you use at the terminal. Restart it to update: \`austere-axi server restart\`.`))
        : null,
      h("p", { class: "meta" }, words("Stays at a terminal: anything that runs a command, such as `server install`, `adapter set` and `trigger add`.")),
    ),
  );

  return [
    h(
      "div",
      { class: "set-page" },
      h("div", { class: "set-top" }, h("h1", { text: "Settings" }), h("p", { class: "summary", text: "This server only: who can review, where it is reachable, and how. Hosted pages keep their own invites." })),
      h(
        "nav",
        { class: "set-nav", "aria-label": "Settings sections" },
        // In-page jumps without a fragment: a fragment change is a popstate, and the shell would read the view again.
        PARTS.map((p) => {
          const n = p.id === "people" ? waiting : 0;
          return h(
            "a",
            {
              href: `#set-${p.id}`,
              class: n ? "waiting" : "",
              "aria-label": n ? `${p.label}, ${n} waiting` : null,
              onclick: (e: Event) => {
                e.preventDefault();
                document.getElementById(`set-${p.id}`)?.scrollIntoView({ block: "start" });
              },
            },
            p.label,
            n ? h("span", { class: "n", text: String(n) }) : null,
          );
        }),
      ),
      people,
      h("div", { class: "set-grid" }, network, h("div", { class: "set-col" }, review, cloudPart, about)),
      projectsPart,
    ),
  ];
}

function copy(ui: SettingsUi, text: string, what: string): void {
  // No Clipboard API over plain HTTP on a network address: show the text instead of doing nothing.
  if (!navigator.clipboard) return ui.say(`Copy it by hand: ${text}`);
  void navigator.clipboard.writeText(text).then(
    () => ui.say(`${what} is copied.`),
    () => ui.say(`Copy it by hand: ${text}`),
  );
}

/** Settings → People → New link: a named link for a page, its project or every page, as the review page's Share makes it. */
function newLinkForm(ui: SettingsUi, pages: ShellPage[], projects: ProjectSummary[], defaultMode: string, reachable: boolean): HTMLElement {
  if (!reachable) return ui.empty("Only this computer can reach the server, so a link would not open anywhere else. See Network.");
  if (!pages.length) return ui.empty("No page is open for review yet. Open one, then share it here or from its menu.");
  const name = h("input", { type: "text", name: "name", maxlength: "40", required: true, placeholder: "Their name", "aria-label": "Their name", autocomplete: "off" });
  const page = h(
    "select",
    { name: "page", "aria-label": "Page" },
    pages.map((p) => h("option", { value: p.open_id, text: `${p.title || p.rel_path} · ${p.project}` })),
  );
  const pageProject = (): { id: string; name: string } | null => {
    const p = pages.find((x) => x.open_id === page.value);
    return p ? { id: p.project_id, name: p.project } : null;
  };
  const scope = h("select", { name: "scope", "aria-label": "They can review" });
  const fillScope = (): void => scope.replaceChildren(...scopeOptions(projects, true, pageProject()).map(([v, text]) => h("option", { value: v, text })));
  fillScope();
  page.addEventListener("change", fillScope);
  const mode = select("mode", NOTES, defaultMode, "Their notes");
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "new-link" },
    field("Name", name),
    field("Page", page),
    field("They can review", scope),
    field("Their notes", mode),
    h("button", { type: "submit", class: "btn primary", text: "Create link" }),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await send<ShareResponse>("/hub/api/people/share", { page: page.value, name: name.value, ...scopeBody(scope.value), auto: chosenAuto(mode) });
    if (!r.ok) {
      error.textContent = r.error;
      error.hidden = false;
      return;
    }
    const made = r.data;
    // The new link is listed under "Links nobody has opened yet" once Settings reads again; the status line keeps it at hand.
    ui.say(
      `Link for ${made.name}, reaching ${made.reaches}: ${made.link} — works once, until ${new Date(made.expiresAt).toLocaleString()} if nobody opens it. Send it only to ${made.name}.`,
      h("button", { type: "button", class: "btn tiny", text: "Copy link", onclick: () => copy(ui, made.link, "The link") }),
    );
    ui.again();
  });
  return h("div", { class: "set-form" }, form, error);
}

/** Run a change, say how it went, and read Settings again (renderSettings' `act`). */
type Act = <T>(route: string, body: object, ok: (data: T) => string) => Promise<void>;

/**
 * Settings → Network → Names from Tailscale (RLM-399): what Tailscale tells about reviewers here, and a
 * form that lets a Tailscale login in without a link (`share tailscale <login>`).
 */
function tailscaleNames(on: boolean, projects: ProjectSummary[], defaultMode: string, act: Act): Child[] {
  const status = on
    ? "On: a reviewer who comes in over Tailscale is named by Tailscale (login and device, shown as verified). Asked only for connections to this server's Tailscale address, never from a header."
    : "Off: the server does not listen on Tailscale here, so nobody is named by it. A reviewer is known by the device you let in.";
  const login = h("input", { type: "text", name: "login", maxlength: "200", required: true, placeholder: "ana@example.com", "aria-label": "Tailscale login", autocomplete: "off" });
  const name = h("input", { type: "text", name: "name", maxlength: "40", placeholder: "Name to show (default: the login)", "aria-label": "Name to show", autocomplete: "off" });
  const reach = scopeOptions(projects, false, null);
  const scope = select("scope", reach, reach[0][0], "They can review");
  const mode = select("mode", NOTES, defaultMode, "Their notes");
  const form = h(
    "form",
    { class: "login-form", "data-form": "tailscale-login" },
    field("Tailscale login", login),
    field("Name", name),
    field("They can review", scope),
    field("Their notes", mode),
    h("button", { type: "submit", class: "btn", text: "Let in" }),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void act<AccessSummary>("/hub/api/people/tailscale", { login: login.value.trim(), name: name.value.trim() || undefined, ...scopeBody(scope.value), auto: chosenAuto(mode) }, (d) => `${d.verifiedLogin ?? d.name} is in on any of their Tailscale devices: ${d.reaches}. Listed under Devices; Revoke there.`);
  });
  return [
    h("span", { class: "set-title", text: "Names from Tailscale" }),
    h("span", { class: "meta", text: status }),
    h("p", { class: "meta" }, words("A Tailscale login gets in without a link or a request: any device signed in to Tailscale as that login opens what it reaches, over Tailscale only. At a terminal: `austere-axi share tailscale <login> --all`.")),
    form,
  ];
}

/** The text the local-network switch shows (P6). */
const LAN_WARNING = "Traffic on this network is not encrypted. Others on the same network could read pages, notes and reviewers' access. Use it on a network you trust, or use Tailscale or HTTPS.";

/** Settings → Network → Local network (P6): off by default; on, the server also listens on the chosen address, for reviewers only. */
function localNetwork(lan: LocalNetwork, act: Act): Child[] {
  const on = lan.address != null;
  // The address switched on stays listed when this computer no longer has it, so the owner can switch it off.
  const options: [string, string][] = lan.choices.map((c) => [c.address, `${c.address} (${c.iface})`]);
  if (lan.address && !options.some(([a]) => a === lan.address)) options.unshift([lan.address, `${lan.address} (not on this computer now)`]);
  const address = select("lan-address", options, lan.address ?? options[0]?.[0] ?? "", "Address on the local network");
  address.disabled = on || !options.length;
  const box = toggle(on, { disabled: !options.length, "aria-describedby": "lan-warn" });
  box.addEventListener("change", () => {
    if (box.checked && !confirm(`Listen on ${address.value}? ${LAN_WARNING}`)) {
      box.checked = false;
      return;
    }
    void act<ProjectActionResult>("/hub/api/settings/network", { lan: box.checked ? address.value : null }, (d) => d.message);
  });
  const state = !on ? "off" : lan.listening ? `on at ${lan.url}` : `on, but this computer does not have ${lan.address} now`;
  return [
    h("label", { class: "switch" }, h("span", { class: "set-switch-text" }, h("span", { class: "set-title", text: "Local network" }), h("span", { class: "meta", text: `Listen on the local network: ${state}` })), box),
    options.length ? h("div", { class: "login-form" }, field("Address", address)) : h("span", { class: "meta", text: "This computer is on no local network." }),
    h("p", { class: "meta", id: "lan-warn" }, words(`Reviewers only: the owner never signs in there, and no link with the owner key points there. ${LAN_WARNING} At a terminal: \`austere-axi server lan <address>\`.`)),
  ];
}
