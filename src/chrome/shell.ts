// The hub shell (RLM-357): the owner's home page, a small client app over /hub/api (src/cli/hub-api.ts).
// A sidebar of projects and their pages; the views Inbox (default) · Pages · Notes · Runs · Settings (settings.ts); search over
// pages and parts. Plain DOM through h(), every text through textContent. The server answers only the
// owner (the cookie); this page holds no secret of its own.
import { h } from "./dom.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { renderSettings } from "./settings.ts";
import type { SettingsUi } from "./settings.ts";
import type { AccessRequestsResponse } from "../cli/server.ts";
import type { Child } from "./dom.ts";
import type {
  ArchiveResult,
  HubRunsResponse,
  InboxPage,
  InboxResponse,
  NoteRow,
  NotesResponse,
  PagesResponse,
  PagesView,
  PartHit,
  ProjectSummary,
  ProjectsResponse,
  RunItem,
  SearchResponse,
  ShellCopy,
  ShellPage,
} from "../shared/hub-api.ts";

interface HubBoot {
  version: string;
  home: string;
  sep: string;
}

const BOOT: HubBoot = (window as Window & { __AUSTERE_HUB__?: HubBoot }).__AUSTERE_HUB__ ?? {
  version: "",
  home: "",
  sep: "/",
};

type View = "inbox" | "pages" | "notes" | "runs" | "settings" | "search";
const VIEWS: { id: Exclude<View, "search">; label: string; icon: IconName }[] = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "pages", label: "Pages", icon: "file" },
  { id: "notes", label: "Notes", icon: "message" },
  { id: "runs", label: "Runs", icon: "terminal" },
  { id: "settings", label: "Settings", icon: "sliders" },
];
const isView = (v: string | null): v is Exclude<View, "search"> => VIEWS.some((x) => x.id === v);

/** The view the hub opened on last (RLM-358). */
const LAST_VIEW = "austere:hub:view";
const CLOSED_PROJECTS = "austere:hub:closed-projects";

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or full: the hub still works, it just forgets
  }
}

interface State {
  view: View;
  /** `?project=`: a project's name, id or folder; "" for every project. */
  project: string;
  pagesView: PagesView;
  /** The search (view search) or the notes filter (view notes). */
  q: string;
  status: string;
  author: string;
  device: string;
}

function fromUrl(): State {
  const p = new URLSearchParams(location.search);
  const asked = p.get("view");
  const pagesView: PagesView = p.has("all") ? "all" : p.has("archived") ? "archived" : "open";
  let view: View;
  if (asked === "search" || isView(asked)) view = asked;
  // Links from before the shell: `/?q=…` searched, `/?all=1` and `/?archived=1` were the page lists.
  else if (p.get("q")) view = "search";
  else if (pagesView !== "open") view = "pages";
  else {
    const last = stored<string>(LAST_VIEW, "inbox");
    view = isView(last) ? last : "inbox";
  }
  return {
    view,
    project: p.get("project") || "",
    pagesView,
    q: p.get("q") || "",
    status: p.get("status") || "",
    author: p.get("author") || "",
    device: p.get("device") || "",
  };
}

function toUrl(s: State): string {
  const p = new URLSearchParams();
  p.set("view", s.view);
  if (s.project) p.set("project", s.project);
  if (s.view === "pages" && s.pagesView !== "open") p.set(s.pagesView, "1");
  if ((s.view === "search" || s.view === "notes") && s.q) p.set("q", s.q);
  if (s.view === "notes") {
    if (s.status) p.set("status", s.status);
    if (s.author) p.set("author", s.author);
    if (s.device) p.set("device", s.device);
  }
  return `/?${p}`;
}

let state = fromUrl();
let previous: View = state.view === "search" ? "inbox" : state.view;

// ── formatting ──

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function when(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  const t = d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (same(d, today)) return `Today ${t}`;
  if (same(d, new Date(Date.now() - 86_400_000))) return `Yesterday ${t}`;
  return `${d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })} ${t}`;
}

function tilde(p: string): string {
  const home = BOOT.home;
  return home && (p === home || p.startsWith(home + BOOT.sep)) ? `~${p.slice(home.length)}` : p;
}

/** A long path or label, shortened in the middle: the start and the end stay (`agent/agy-gemi…/c07769ee1529`). */
function middle(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(text.length - tail)}`;
}

const basename = (p: string): string => p.split(/[\\/]/).pop() || p;
const titleOf = (p: ShellPage): string => p.title || basename(p.rel_path);

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

// ── layout ──

const SVG_NS = "http://www.w3.org/2000/svg";

/** The austere-axi mark beside the name: decorative, the name beside it is the link's text. */
function logoMark(): SVGSVGElement {
  const el = (tag: string, attrs: Record<string, string>): SVGElement => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const svg = el("svg", {
    class: "logo",
    width: "24",
    height: "24",
    viewBox: "0 0 32 32",
    "aria-hidden": "true",
  }) as SVGSVGElement;
  svg.append(
    el("rect", { class: "logo-ground", width: "32", height: "32", rx: "7" }),
    el("rect", { class: "logo-edge", x: "1", y: "1", width: "30", height: "30", rx: "6" }),
    el("path", { class: "logo-a", d: "M9 23 16 8l7 15M11.5 18h9" }),
  );
  return svg;
}

document.body.append(
  h(
    "div",
    { class: "hub" },
    h(
      "aside",
      { class: "side", id: "side", "aria-label": "Projects and views" },
      h(
        "div",
        { class: "brand" },
        logoMark(),
        h("a", { href: "/?view=inbox", text: "austere-axi" }),
        h("small", { text: BOOT.version }),
      ),
      h(
        "form",
        { class: "search", role: "search" },
        h(
          "label",
          { class: "search-box" },
          icon("search", { size: 15, width: 1.8 }),
          h("input", {
            type: "search",
            name: "q",
            placeholder: "Search pages and parts",
            "aria-label": "Search pages and parts",
            autocomplete: "off",
          }),
        ),
      ),
      h("nav", { class: "views", "aria-label": "Views" }),
      h(
        "div",
        { class: "side-h" },
        h("span", { text: "Projects" }),
        h("a", { class: "all-projects", href: "/", hidden: true, text: "All" }),
      ),
      h("ul", { class: "projects" }),
    ),
    h("div", { class: "scrim" }),
    h(
      "div",
      { class: "main" },
      // Narrow screens only: the drawer's toggle, and a way to its search.
      h(
        "header",
        { class: "top" },
        h(
          "button",
          {
            type: "button",
            class: "side-toggle",
            "aria-controls": "side",
            "aria-expanded": "false",
          },
          icon("menu", { size: 18 }),
          h("span", { class: "side-toggle-text", text: "Projects" }),
        ),
        h(
          "button",
          { type: "button", class: "top-search", "aria-label": "Search pages and parts" },
          icon("search", { size: 20, width: 1.8 }),
        ),
      ),
      h("div", { class: "status", role: "status", "aria-live": "polite" }),
      h("main", { class: "content", id: "content", tabindex: "-1" }),
      // Phones: the views as a tab bar along the bottom; the drawer keeps search and projects.
      h("nav", { class: "tabbar", "aria-label": "Views" }),
    ),
  ),
);

const $ = <E extends Element = HTMLElement>(sel: string): E => document.querySelector(sel) as E;
const content = $("#content");
const statusEl = $(".status");
const searchInput = $<HTMLInputElement>(".search input");

const narrow = window.matchMedia("(max-width: 860px)");
/** On a narrow screen the closed drawer sits off screen: out of Tab order too, until it opens. */
function syncSide(): void {
  $(".side").inert = narrow.matches && !document.documentElement.classList.contains("side-open");
}
function setSide(open: boolean): void {
  document.documentElement.classList.toggle("side-open", open);
  $(".side-toggle").setAttribute("aria-expanded", String(open));
  syncSide();
  if (open) {
    // On a phone the views live in the tab bar, not the drawer: then focus starts at the top of the drawer.
    const view = $<HTMLElement>(".views a");
    (view && view.getClientRects().length ? view : $<HTMLElement>(".brand a"))?.focus();
  }
}
narrow.addEventListener("change", syncSide);
syncSide();
$(".side-toggle").addEventListener("click", () =>
  setSide(!document.documentElement.classList.contains("side-open")),
);
$(".top-search").addEventListener("click", () => {
  setSide(true);
  searchInput.focus();
});
$(".scrim").addEventListener("click", () => setSide(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.documentElement.classList.contains("side-open")) {
    setSide(false);
    $<HTMLElement>(".side-toggle").focus();
  }
});

/** Show `text` above the view, with optional buttons (Undo). */
function say(text: string, ...actions: HTMLElement[]): void {
  statusEl.replaceChildren(...(text ? [h("span", { text }), ...actions] : []));
}

// ── data ──

class Refused extends Error {}

async function get<T>(route: string): Promise<T> {
  const r = await fetch(route, { headers: { accept: "application/json" } });
  if (r.status === 403)
    throw new Refused(
      "This browser is not signed in as the owner. Run `austere-axi hub open` to sign in again.",
    );
  if (!r.ok) throw new Error(`austere-axi answered ${r.status}`);
  return (await r.json()) as T;
}

async function post(route: string, body: object = {}): Promise<ArchiveResult | null> {
  try {
    const r = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok ? ((await r.json()) as ArchiveResult) : null;
  } catch {
    return null;
  }
}

const UNREACHABLE = "Could not reach austere-axi. Check that it is still running, then reload.";
const errorText = (err: unknown): string => (err instanceof Refused ? err.message : UNREACHABLE);

function query(params: Record<string, string>): string {
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ""));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── pieces ──

function openLink(id: string, extra: Record<string, string> = {}): string {
  return `/hub/open/${id}${query(extra)}`;
}

function chip(c: ShellCopy): HTMLElement {
  const extra = [
    c.unanswered ? `${c.unanswered} unanswered` : "",
    c.listening ? "agent listening" : "",
    c.missing ? "missing" : "",
    c.archived ? "archived" : "",
  ].filter(Boolean);
  return h(
    "a",
    {
      class: `chip${c.unanswered ? " waiting" : ""}${c.missing ? " gone" : ""}`,
      href: openLink(c.id),
      title: `${c.label} · ${c.file}`,
      "data-copy": c.id,
    },
    icon("branch", { size: 12, width: 2 }),
    h("span", { class: "chip-label", text: middle(c.label, 28) }),
    extra.length ? h("span", { class: "chip-note", text: extra.join(" · ") }) : null,
  );
}

/** How many chips a row shows before "+n more". */
const CHIPS = 3;

/** `least`: how many copies a page needs before its chips show (the inbox names copies only when there are two). */
function chips(copies: ShellCopy[], least = 2): HTMLElement | null {
  if (copies.length < least || !copies.length) return null;
  const rest = copies.slice(CHIPS);
  return h(
    "div",
    { class: "chips" },
    copies.slice(0, CHIPS).map(chip),
    rest.length
      ? h(
          "details",
          { class: "more" },
          h("summary", { text: `+${rest.length} more` }),
          h("div", { class: "chips" }, rest.map(chip)),
        )
      : null,
  );
}

/** What is worth saying about a page's state beyond its notes: gone, archived, only checked, an agent listening. A quiet page says nothing. */
function stateWords(p: ShellPage): Child[] {
  const only = p.copies.length === 1 ? p.copies[0] : null;
  if (!only) {
    const out: Child[] = [plural(p.copies.length, "copy", "copies")];
    if (p.copies.every((c) => c.missing)) out.push(h("em", { class: "gone", text: "missing" }));
    else if (p.copies.some((c) => c.listening))
      out.push(h("em", { class: "live", text: "agent listening" }));
    return out;
  }
  return [
    only.missing ? h("em", { class: "gone", text: "missing" }) : null,
    only.archived ? h("em", { text: "archived" }) : null,
    only.checked ? h("em", { text: "checked" }) : null,
    only.listening ? h("em", { class: "live", text: "agent listening" }) : null,
  ];
}

function joined(parts: Child[]): Child[] {
  const kept = parts.filter((x) => x != null && x !== false && x !== "");
  return kept.flatMap((x, i) => (i ? [" · ", x] : [x]));
}

/** Why a page is in its inbox group, in words. */
function reasons(p: ShellPage): HTMLElement | null {
  const lines: HTMLElement[] = [];
  if (p.changed)
    lines.push(
      h("li", {
        class: "need",
        text: `Changed since you looked: ${plural(p.changed, "revision")}`,
      }),
    );
  if (p.held)
    lines.push(
      h("li", { class: "need", text: `${plural(p.held, "note")} held for you to release` }),
    );
  if (p.failed) {
    const run = p.copies.find((c) => c.failed_run)?.failed_run;
    lines.push(
      h("li", {
        class: "need fail",
        text: `Agent run failed${run?.reason ? ` (${run.reason.replace(/_/g, " ")})` : ""}${run?.ended_at ? ` · ${when(run.ended_at)}` : ""}`,
      }),
    );
  }
  if (p.taker) {
    const waiting = p.unanswered - p.held;
    lines.push(
      h(
        "li",
        { class: `wait ${p.taker}${p.run_active ? " active" : ""}` },
        h("span", { class: "lead", text: plural(waiting, "unanswered note") }),
        ` · ${p.taker === "attach_on" ? (p.run_active ? "agent on: a run is working on them" : "agent on: your next note starts a run") : TAKER[p.taker]}`,
      ),
    );
  }
  return lines.length ? h("ul", { class: "why" }, lines) : null;
}

function notePreview(notes: InboxPage["notes"]): HTMLElement | null {
  if (!notes.length) return null;
  return h(
    "ul",
    { class: "previews" },
    notes.map((n) =>
      h(
        "li",
        {},
        h("span", { class: "quote", text: n.text || "(no text)" }),
        h(
          "span",
          { class: "by" },
          joined([
            n.author || "You",
            n.target ? h("span", {}, "on ", h("code", { class: "target", text: n.target })) : null,
            n.label,
            STATUS_LABEL[n.status] ?? n.status,
          ]),
        ),
      ),
    ),
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
function nextStep(p: ShellPage): HTMLElement | null {
  if (p.taker === "nobody")
    return h("a", {
      class: "btn fill",
      href: openLink(p.open_id, { attach: "1" }),
      text: "Turn agent on",
    });
  if (p.group !== "needs_you") return null;
  if (p.changed)
    return h("a", { class: "btn fill", href: openLink(p.open_id), text: "Review changes" });
  if (p.held)
    return h("a", { class: "btn fill", href: openLink(p.open_id), text: "Open held notes" });
  return null;
}

function archiveButton(p: ShellPage, archivedView = false): HTMLButtonElement {
  const label = `${archivedView ? "Unarchive" : "Archive"} ${titleOf(p)}`;
  const title = archivedView
    ? "Bring this page back to the lists"
    : p.copies.length > 1
      ? "Put every copy of this page away; its notes are kept"
      : "Put this page away; its notes are kept";
  const button: HTMLButtonElement = archivedView
    ? h("button", {
        type: "button",
        class: "btn ghost",
        text: "Unarchive",
        title,
        "aria-label": label,
        onclick: () => void flip(p, button, "unarchive"),
      })
    : h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          title,
          "aria-label": label,
          onclick: () => void flip(p, button, "archive"),
        },
        icon("archive"),
      );
  return button;
}

interface RowOptions {
  showProject?: boolean;
  notes?: InboxPage["notes"];
  archivedView?: boolean;
}

function pageRow(p: ShellPage, opts: RowOptions = {}): HTMLElement {
  const main = p.copies.find((c) => c.id === p.open_id) ?? p.copies[0];
  const counts: Child[] = [
    p.unanswered ? h("b", { class: "open", text: `${p.unanswered} unanswered` }) : null,
    p.addressed ? `${p.addressed} answered` : null,
  ];
  const facts = joined([...stateWords(p), ...counts]);
  const [name, tone] = tileOf(p);
  const time = when(p.activity);
  return h(
    "li",
    { class: `row page-row ${p.group}`, "data-page": p.id },
    h(
      "span",
      { class: `tile ${tone}`, "aria-hidden": "true" },
      icon(name, { size: 16, width: 1.8 }),
    ),
    h(
      "div",
      { class: "row-main" },
      h(
        "a",
        { class: "row-title", href: openLink(p.open_id), title: main?.file ?? "" },
        titleOf(p),
      ),
      h("span", {
        class: "path",
        text: opts.showProject ? `${p.project} / ${p.rel_path}` : p.rel_path,
      }),
      facts.length ? h("span", { class: "meta" }, facts) : null,
      reasons(p),
      notePreview(opts.notes ?? []),
      chips(p.copies),
    ),
    h(
      "div",
      { class: "row-actions" },
      time ? h("span", { class: "when", text: time }) : null,
      nextStep(p),
      archiveButton(p, opts.archivedView),
    ),
  );
}

async function flip(
  p: ShellPage,
  button: HTMLButtonElement,
  action: "archive" | "unarchive",
): Promise<void> {
  // One request at a time: a second click would archive again and take the first Undo's place.
  if (button.disabled) return;
  button.disabled = true;
  const done = await post(`/hub/api/page/${p.open_id}/${action}`);
  if (!done) {
    button.disabled = false;
    return say(`Could not ${action} ${titleOf(p)}. ${UNREACHABLE}`);
  }
  const undo = action === "archive" ? "unarchive" : "archive";
  const undoButton: HTMLButtonElement = h("button", {
    type: "button",
    class: "btn tiny",
    text: "Undo",
    // Exactly the copies the action changed: a copy archived before stays archived.
    onclick: async (): Promise<void> => {
      if (undoButton.disabled) return;
      undoButton.disabled = true;
      if (!(await post(`/hub/api/page/${p.open_id}/${undo}`, { ids: done.ids }))) {
        // Keep the way back: the owner can try again once austere-axi answers.
        undoButton.disabled = false;
        return say(`Could not undo. ${UNREACHABLE}`, undoButton);
      }
      say("");
      void refresh();
      void loadSide();
    },
  });
  say(`${action === "archive" ? "Archived" : "Unarchived"} ${titleOf(p)}.`, undoButton);
  // Counts, groups and empty states change with the row: read the view again (the status line stays).
  void refresh();
  void loadSide();
}

function section(
  title: string,
  count: number | null,
  body: Child,
  extra: Child = null,
  cls = "",
): HTMLElement {
  const id = `h-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return h(
    "section",
    { class: cls, "aria-labelledby": id },
    h(
      "h2",
      { id },
      title,
      count == null ? null : h("span", { class: "n", text: String(count) }),
      extra,
    ),
    body,
  );
}

function empty(...parts: Child[]): HTMLElement {
  return h("p", { class: "empty" }, parts);
}

function viewLink(next: Partial<State>, text: string): HTMLAnchorElement {
  const target = { ...state, ...next };
  return h("a", { href: toUrl(target), onclick: (e: Event) => go(e, next), text });
}

// ── views ──

let projects: ProjectSummary[] = [];
let sidePages: ShellPage[] = [];

function projectFilter(p: { name: string; id: string } | null): HTMLElement | null {
  if (!state.project) return null;
  return h(
    "p",
    { class: "filter" },
    `Project ${p?.name ? tilde(p.name) : state.project}`,
    " · ",
    viewLink({ project: "" }, "all projects"),
  );
}

/** An inbox group: its heading, count and what puts a page there, then its rows. */
function groupSection(
  title: string,
  count: number,
  hint: string,
  body: Child,
  cls: string,
): HTMLElement {
  const id = `h-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return h(
    "section",
    { class: cls, "aria-labelledby": id },
    h(
      "div",
      { class: "sec-h" },
      h("h2", { id }, title, h("span", { class: "n", text: String(count) })),
      h("p", { class: "hint", text: hint }),
    ),
    body,
  );
}

async function renderInbox(): Promise<Child[]> {
  const data = await get<InboxResponse>(`/hub/api/inbox${query({ project: state.project })}`);
  const all = data.needs_you.length + data.waiting_on_agent.length + data.quiet.length;
  const showProject = !state.project;
  const rows = (list: InboxPage[]): HTMLElement =>
    h(
      "ul",
      { class: "rows card" },
      list.map((p) => pageRow(p, { showProject, notes: p.notes })),
    );
  if (!all) {
    return [
      h("header", { class: "view-h" }, h("h1", { text: "Inbox" })),
      projectFilter(data.project),
      empty(
        state.project
          ? "Nothing is open for review in this project."
          : "No pages yet. Open one for review with austere-axi and it shows up here.",
      ),
    ];
  }
  const waiting = data.waiting_on_agent.length;
  const summary = joined([
    data.needs_you.length
      ? h("span", {
          class: "need",
          text: `${plural(data.needs_you.length, "page needs", "pages need")} you`,
        })
      : "nothing needs you",
    waiting ? `${waiting} ${waiting === 1 ? "waits" : "wait"} on an agent` : null,
    data.quiet.length ? `${data.quiet.length} quiet` : null,
    data.held ? `${plural(data.held, "note")} held for release` : null,
    data.failed_runs.length ? plural(data.failed_runs.length, "failed run") : null,
  ]);
  return [
    h(
      "header",
      { class: "view-h" },
      h("h1", { text: "Inbox" }),
      h("p", { class: "summary" }, summary),
    ),
    projectFilter(data.project),
    groupSection(
      "Needs you",
      data.needs_you.length,
      "The agent changed the page, a teammate's notes wait for you, or a run failed",
      data.needs_you.length
        ? rows(data.needs_you)
        : empty("Nothing changed since you looked, no note is held for you and no run failed."),
      "group needs",
    ),
    groupSection(
      "Waiting on agent",
      waiting,
      "Notes no agent has answered yet, and who takes them",
      waiting ? rows(data.waiting_on_agent) : empty("No unanswered notes."),
      "group waiting",
    ),
    groupSection(
      "Quiet",
      data.quiet.length,
      "Open for review, nothing waiting",
      data.quiet.length ? rows(data.quiet) : empty("Every page has something going on."),
      "group quiet",
    ),
  ];
}

const PAGE_VIEWS: { id: PagesView; label: string; count: "open" | "everything" | "archived" }[] = [
  { id: "open", label: "Open", count: "open" },
  { id: "all", label: "Everything", count: "everything" },
  { id: "archived", label: "Archived", count: "archived" },
];

const GROUP_LABEL: Record<string, string> = {
  needs_you: "Needs you",
  waiting_on_agent: "Waiting on agent",
  quiet: "Quiet",
};

/** The Notes column under the count: why the page wants the owner, or who takes its notes. */
function notesLine(p: ShellPage): HTMLElement | null {
  if (p.changed) return h("span", { class: "why-short need", text: "Changed since you looked" });
  if (p.held)
    return h("span", { class: "why-short need", text: `${plural(p.held, "note")} held for you` });
  if (p.failed) return h("span", { class: "why-short fail", text: "Agent run failed" });
  if (p.taker === "attach_on")
    return h("span", {
      class: `why-short${p.run_active ? " live" : ""}`,
      text: p.run_active ? "A run is working on them" : "Agent on: your next note starts a run",
    });
  if (p.taker === "nobody")
    return h(
      "span",
      { class: "why-short" },
      "Nobody is taking them · ",
      h("a", { href: openLink(p.open_id, { attach: "1" }), text: "Turn agent on" }),
    );
  return null;
}

/** A row of the Pages table: page · copies · notes · last activity · archive. */
function tableRow(p: ShellPage, archivedView: boolean): HTMLElement {
  const main = p.copies.find((c) => c.id === p.open_id) ?? p.copies[0];
  const counts = joined([
    p.unanswered ? h("b", { class: "open", text: `${p.unanswered} unanswered` }) : null,
    p.addressed ? `${p.addressed} answered` : null,
  ]);
  const words = joined(stateWords(p));
  const dot = p.failed
    ? "fail"
    : p.group === "needs_you"
      ? "need"
      : p.run_active || p.taker === "listening"
        ? "live"
        : "idle";
  return h(
    "li",
    { class: `row page-row trow ${p.group}`, "data-page": p.id },
    h(
      "div",
      { class: "t-page" },
      h("span", {
        class: `dot ${dot}`,
        role: "img",
        "aria-label": p.failed ? "Agent run failed" : (GROUP_LABEL[p.group] ?? p.group),
      }),
      h(
        "div",
        { class: "row-main" },
        h(
          "a",
          { class: "row-title", href: openLink(p.open_id), title: main?.file ?? "" },
          titleOf(p),
        ),
        h("span", { class: "path", text: p.rel_path }),
      ),
    ),
    h("div", { class: "t-copies" }, chips(p.copies, 1)),
    h(
      "div",
      { class: "t-notes" },
      counts.length ? h("span", { class: "t-count" }, counts) : null,
      notesLine(p),
      words.length ? h("span", { class: "meta" }, words) : null,
    ),
    h("span", { class: "when", text: when(p.activity) }),
    h("div", { class: "row-actions" }, archiveButton(p, archivedView)),
  );
}

async function renderPages(): Promise<Child[]> {
  const data = await get<PagesResponse>(
    `/hub/api/pages${query({ project: state.project, view: state.pagesView })}`,
  );
  const { counts } = data;
  const tabs = h(
    "nav",
    { class: "seg", "aria-label": "Which pages" },
    PAGE_VIEWS.map((v) => {
      const a = viewLink({ pagesView: v.id }, v.label);
      if (v.id === state.pagesView) a.setAttribute("aria-current", "page");
      a.append(" ", h("span", { class: "n", text: String(counts[v.count]) }));
      return a;
    }),
  );
  const unanswered = data.pages.reduce((n, p) => n + p.unanswered, 0);
  const projectCount = new Set(data.pages.map((p) => p.project_id)).size;
  const head = [
    h(
      "header",
      { class: "view-h split" },
      h(
        "div",
        {},
        h("h1", { text: "Pages" }),
        h("p", {
          class: "summary",
          text: joined([
            `${plural(data.pages.length, "page")} in ${plural(projectCount, "project")}`,
            unanswered ? plural(unanswered, "unanswered note") : null,
          ]).join(""),
        }),
      ),
      tabs,
    ),
    projectFilter(data.project),
  ];
  if (!data.pages.length) {
    const others = PAGE_VIEWS.filter((v) => v.id !== state.pagesView && counts[v.count] > 0).map(
      (v) => viewLink({ pagesView: v.id }, `${v.label} (${counts[v.count]})`),
    );
    if (counts.everything === 0 && !state.project)
      return [
        ...head,
        empty("No pages yet. Open one for review with austere-axi and it shows up here."),
      ];
    if (state.pagesView === "archived")
      return [
        ...head,
        empty("No archived pages.", ...(others.length ? [" See: ", ...joined(others), "."] : [])),
      ];
    const parts: Child[] = ["Nothing is open for review."];
    if (counts.checked)
      parts.push(
        ` ${plural(counts.checked, "page was", "pages were")} checked but never opened: `,
        viewLink({ pagesView: "all" }, "show them"),
        ".",
      );
    if (counts.archived)
      parts.push(
        ` ${counts.archived} archived: `,
        viewLink({ pagesView: "archived" }, "show"),
        ".",
      );
    return [...head, empty(...parts)];
  }
  const byProject = new Map<string, ShellPage[]>();
  for (const p of data.pages) {
    let list = byProject.get(p.project_id);
    if (!list) byProject.set(p.project_id, (list = []));
    list.push(p);
  }
  const info = new Map(projects.map((p) => [p.id, p]));
  const archivedView = state.pagesView === "archived";
  const items: HTMLElement[] = [];
  for (const [id, list] of byProject) {
    const pinfo = info.get(id);
    const roots = pinfo?.roots ?? [];
    const waiting = list.reduce((n, p) => n + p.unanswered, 0);
    const where = roots.length
      ? `${middle(tilde(roots[0]), 48)}${roots.length > 1 ? ` · +${roots.length - 1} more ${roots.length === 2 ? "folder" : "folders"}` : ""}`
      : "";
    items.push(
      h(
        "li",
        { class: "proj-row" },
        h("h2", {}, viewLink({ project: id }, list[0].project)),
        where ? h("small", { class: "path", title: roots.join("\n"), text: where }) : null,
        waiting
          ? h("span", {
              class: `proj-wait${list.some((p) => p.needs_you) ? " need" : ""}`,
              text: `${waiting} unanswered`,
            })
          : null,
        pinfo?.same_as
          ? h(
              "p",
              { class: "same" },
              `Same repository as project ${pinfo.same_as.name}: `,
              h("code", { text: pinfo.same_as.merge }),
            )
          : null,
      ),
      ...list.map((p) => tableRow(p, archivedView)),
    );
  }
  const table = h(
    "div",
    { class: `table card pages-table${archivedView ? " archived" : ""}` },
    h(
      "div",
      { class: "thead", "aria-hidden": "true" },
      ["Page", "Copies", "Notes", "Last activity", ""].map((t) => h("span", { text: t })),
    ),
    h("ul", { class: "rows" }, items),
  );
  const checked =
    state.pagesView === "open" && counts.checked
      ? h(
          "p",
          { class: "foot" },
          `${plural(counts.checked, "more page was", "more pages were")} checked but never opened for review. `,
          viewLink({ pagesView: "all" }, "Show them"),
        )
      : null;
  return [...head, table, checked];
}

const NOTE_STATE: Record<string, string> = {
  open: "Unanswered",
  received: "Unanswered",
  addressed: "Answered",
  held: "Held for you",
};

async function renderNotes(): Promise<Child[]> {
  const data = await get<NotesResponse>(
    `/hub/api/notes${query({ project: state.project, q: state.q, status: state.status, author: state.author, device: state.device })}`,
  );
  const option = (value: string, label: string, current: string): HTMLOptionElement =>
    h("option", { value, selected: current === value, text: label });
  const form = h(
    "form",
    {
      class: "filters",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const f = new FormData(e.target as HTMLFormElement);
        go(null, {
          q: String(f.get("q") ?? ""),
          status: String(f.get("status") ?? ""),
          author: String(f.get("author") ?? ""),
        });
      },
    },
    h(
      "label",
      { class: "search-box" },
      icon("search", { size: 15, width: 1.8 }),
      h("input", {
        type: "search",
        name: "q",
        value: state.q,
        placeholder: "Search notes, targets, page titles",
        "aria-label": "Search notes",
      }),
    ),
    h(
      "select",
      { name: "status", "aria-label": "Status" },
      option("", "All", state.status),
      option("unanswered", "Unanswered", state.status),
      option("answered", "Answered", state.status),
    ),
    data.authors.length
      ? h(
          "select",
          { name: "author", "aria-label": "Author" },
          option("", "Everyone", state.author),
          option("owner", "Owner", state.author),
          data.authors.map((a) => option(a, a, state.author)),
        )
      : null,
    h("button", { type: "submit", class: "btn", text: "Filter" }),
  );
  const waiting = data.notes.filter((n) => n.status !== "addressed").length;
  const list = data.notes.map((n: NoteRow) => {
    const where = n.label && n.label !== n.project ? `${n.project} · ${n.label}` : n.project;
    const tone =
      n.status === "addressed" ? "done" : n.status === "held" ? "waiting held" : "waiting";
    const time = when(n.at);
    return h(
      "li",
      { class: "note" },
      h(
        "span",
        { class: `st ${tone}` },
        h("span", { class: "st-dot", "aria-hidden": "true" }),
        NOTE_STATE[n.status] ?? n.status,
      ),
      h(
        "div",
        { class: "note-main" },
        h(
          "a",
          { href: openLink(n.artifact_id), title: n.file },
          h("p", { class: "quote", text: n.text || "(no text)" }),
        ),
        h(
          "span",
          { class: "meta" },
          n.author ? h("b", { class: "by", text: n.author }) : null,
          n.remote ? h("span", { text: "hosted page" }) : null,
          n.target
            ? [h("span", { text: "on" }), h("code", { class: "target", text: n.target })]
            : null,
          h("span", { text: "in" }),
          h("a", { href: openLink(n.artifact_id), text: n.title || basename(n.file) }),
          where ? h("span", { text: `· ${where}` }) : null,
        ),
      ),
      time ? h("span", { class: "when", text: time }) : null,
    );
  });
  const filtered = state.q || state.project || state.author || state.device || state.status;
  return [
    h(
      "header",
      { class: "view-h" },
      h("h1", { text: "Notes" }),
      h("p", {
        class: "summary",
        text: `${filtered ? "Newest first" : "Every note on every page, newest first"} · ${plural(data.notes.length, "note")}${waiting ? ` · ${waiting} unanswered` : ""}`,
      }),
    ),
    form,
    projectFilter(data.project),
    data.device
      ? h(
          "p",
          { class: "filter" },
          `Device ${data.device.name} (${data.device.id}) · `,
          viewLink({ device: "" }, "everyone"),
        )
      : null,
    list.length
      ? h("ul", { class: "notes card" }, list)
      : empty(filtered ? "No notes match." : "No notes yet."),
  ];
}

const RUN_STATUS: Record<string, string> = {
  queued: "Queued",
  waiting_for_session: "Waiting for its session",
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

async function renderRuns(): Promise<Child[]> {
  const data = await get<HubRunsResponse>(`/hub/api/runs${query({ project: state.project })}`);
  const row = (r: RunItem): HTMLElement => {
    const took =
      r.started_at && r.ended_at
        ? `${Math.max(1, Math.round((r.ended_at - r.started_at) / 1000))} s`
        : "";
    return h(
      "li",
      { class: `run ${r.status}` },
      h(
        "span",
        { class: `rstat ${r.status}` },
        h("span", { class: "st-dot", "aria-hidden": "true" }),
        RUN_STATUS[r.status] ?? r.status,
      ),
      h(
        "div",
        { class: "run-main" },
        r.artifact_id
          ? h("a", {
              href: openLink(r.artifact_id),
              title: r.file ?? "",
              text: r.title || basename(r.file ?? r.artifact_id),
            })
          : h("span", { text: r.kind === "trigger" ? "Trigger run" : "Run" }),
        r.reason ? h("span", { class: "run-why", text: r.reason.replace(/_/g, " ") }) : null,
      ),
      h("span", { class: "agent", text: joined([r.harness, r.mode]).join("") }),
      h("span", { class: "when", text: when(r.started_at) }),
      h("span", { class: "took", text: took }),
    );
  };
  return [
    h(
      "header",
      { class: "view-h" },
      h("h1", { text: "Runs" }),
      h("p", {
        class: "summary",
        text: "Agent runs your notes started on pages where the agent is on, newest first",
      }),
    ),
    projectFilter(data.project),
    data.runs.length
      ? h(
          "div",
          { class: "table card runs-table" },
          h(
            "div",
            { class: "thead", "aria-hidden": "true" },
            ["Status", "Page", "Agent", "Started", "Took"].map((t) => h("span", { text: t })),
          ),
          h("ul", { class: "runs" }, data.runs.map(row)),
        )
      : empty(
          "No runs yet. Turn an agent on in a page's Agent menu and the owner's notes start one.",
        ),
  ];
}

async function renderSearch(): Promise<Child[]> {
  const data = await get<SearchResponse>(`/hub/api/search${query({ q: state.q })}`);
  const part = (hit: PartHit): HTMLElement =>
    h(
      "li",
      { class: "part" },
      h(
        "a",
        { href: openLink(hit.artifact_id, { part: hit.statement }), title: hit.file },
        h("span", {
          class: "part-title",
          text: `${hit.title || basename(hit.file)} · ${hit.statement}`,
        }),
        h("span", { class: "snippet", text: hit.snippet }),
      ),
      h("span", { class: "meta", text: joined([hit.component || null, hit.copy]).join("") }),
    );
  return [
    h("header", { class: "view-h" }, h("h1", {}, "Search: ", h("q", { text: data.q }))),
    section(
      "Pages",
      data.pages.length,
      data.pages.length
        ? h(
            "ul",
            { class: "rows card" },
            data.pages.map((p) => pageRow(p, { showProject: true })),
          )
        : empty("No page title, path or project matches."),
    ),
    section(
      "Parts",
      data.parts.length,
      data.parts.length
        ? h("ul", { class: "parts card" }, data.parts.map(part))
        : empty("No part of a page says that."),
    ),
  ];
}

const settingsUi: SettingsUi = {
  say,
  // A change can move the sidebar too: a project renamed or merged, a request decided.
  again: () => {
    void refresh();
    void loadSide();
  },
  when,
  tilde,
  plural,
  section,
  empty,
  notesOf: (d) =>
    viewLink(
      { view: "notes", device: d.id, project: "", q: "", status: "", author: "" },
      `Notes by ${d.name}`,
    ),
  get,
};

const RENDER: Record<View, () => Promise<Child[]>> = {
  inbox: renderInbox,
  pages: renderPages,
  notes: renderNotes,
  runs: renderRuns,
  settings: () => renderSettings(settingsUi),
  search: renderSearch,
};

let generation = 0;

async function refresh(): Promise<void> {
  const gen = ++generation;
  document.title = `${state.view === "search" ? "Search" : VIEWS.find((v) => v.id === state.view)?.label} · austere-axi hub`;
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".views a, .tabbar a")) {
    if (a.dataset.view === state.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  searchInput.value = state.view === "search" ? state.q : "";
  let nodes: Child[];
  try {
    nodes = await RENDER[state.view]();
  } catch (err) {
    nodes = [h("p", { class: "error", text: errorText(err) })];
  }
  if (gen !== generation) return;
  content.replaceChildren(
    ...nodes
      .filter((n): n is Node | string => n != null && n !== false)
      .map((n) => (typeof n === "number" ? String(n) : n)),
  );
}

/** Move to another view or filter; `e`: the click that asked, whose default this replaces. */
function go(e: Event | null, next: Partial<State>, push = true): void {
  const me = e as MouseEvent | null;
  if (me && (me.metaKey || me.ctrlKey || me.shiftKey || me.button === 1)) return;
  e?.preventDefault();
  if (state.view !== "search") previous = state.view;
  state = { ...state, ...next };
  if (next.view && next.view !== "notes" && next.view !== "search")
    state = { ...state, q: "", status: "", author: "", device: "" };
  if (state.view !== "search") store(LAST_VIEW, state.view);
  if (push) history.pushState(null, "", toUrl(state));
  else history.replaceState(null, "", toUrl(state));
  setSide(false);
  renderSide();
  void refresh();
}

window.addEventListener("popstate", () => {
  state = fromUrl();
  renderSide();
  void refresh();
});

let searchTimer = 0;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const q = searchInput.value.trim();
    if (q) go(null, { view: "search", q }, state.view !== "search");
    else if (state.view === "search") go(null, { view: previous, q: "" });
  }, 200);
});
$(".search").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q) go(null, { view: "search", q }, state.view !== "search");
});

// ── sidebar ──

/** The views, for the sidebar (`tab` false) or the phone tab bar. */
function viewLinks(tab: boolean, needsYou: number, waiting: number): HTMLAnchorElement[] {
  return VIEWS.map((v) =>
    h(
      "a",
      {
        href: toUrl({ ...state, view: v.id }),
        "data-view": v.id,
        "aria-current": state.view === v.id ? "page" : false,
        onclick: (e: Event) => go(e, { view: v.id }),
      },
      icon(v.icon, tab ? { size: 20, width: 1.8 } : {}),
      h("span", { class: "label", text: v.label }),
      v.id === "inbox" && needsYou
        ? h("span", {
            class: "count need",
            title: `${plural(needsYou, "page needs", "pages need")} you`,
            text: String(needsYou),
          })
        : null,
      v.id === "settings" && waiting
        ? h("span", {
            class: "count need",
            title: `${plural(waiting, "person asks", "people ask")} for access`,
            text: String(waiting),
          })
        : null,
    ),
  );
}

function renderViews(needsYou: number, waiting: number): void {
  $(".views").replaceChildren(...viewLinks(false, needsYou, waiting));
  $(".tabbar").replaceChildren(...viewLinks(true, needsYou, waiting));
}

/** Projects show their pages until the owner folds them. */
const closedProjects = new Set<string>(stored<string[]>(CLOSED_PROJECTS, []));

const needsDot = (): HTMLElement =>
  h("span", { class: "dot need", role: "img", "aria-label": "Needs you" });

function renderSide(): void {
  renderViews(
    projects.reduce((n, p) => n + p.needs_you, 0),
    waitingPeople,
  );
  const all = $<HTMLAnchorElement>(".all-projects");
  all.hidden = !state.project;
  all.href = toUrl({ ...state, project: "" });
  all.onclick = (e) => go(e, { project: "" });
  const byProject = new Map<string, ShellPage[]>();
  for (const p of sidePages) {
    let list = byProject.get(p.project_id);
    if (!list) byProject.set(p.project_id, (list = []));
    list.push(p);
  }
  const list = projects
    .filter((p) => p.pages > 0 || state.project === p.id || state.project === p.name)
    .map((p) => {
      const selected = state.project === p.id || state.project === p.name;
      const expanded = !closedProjects.has(p.id);
      const pages = byProject.get(p.id) ?? [];
      const toggle = h(
        "button",
        {
          type: "button",
          class: "proj-toggle",
          "aria-expanded": String(expanded),
          "aria-label": `${expanded ? "Hide" : "Show"} the pages of ${p.name}`,
          onclick: () => {
            if (closedProjects.has(p.id)) closedProjects.delete(p.id);
            else closedProjects.add(p.id);
            store(CLOSED_PROJECTS, [...closedProjects]);
            renderSide();
          },
        },
        icon("chevronRight", { size: 14, width: 2 }),
      );
      return h(
        "li",
        { class: `proj${selected ? " selected" : ""}` },
        h(
          "div",
          { class: "proj-head" },
          toggle,
          h("a", {
            class: "proj-link",
            href: toUrl({ ...state, project: p.id }),
            title: p.roots.join("\n"),
            "aria-current": selected ? "true" : false,
            onclick: (e: Event) => go(e, { project: p.id }),
            text: p.name,
          }),
          p.unanswered
            ? h("span", {
                class: `count${p.needs_you ? " need" : ""}`,
                title: plural(p.unanswered, "unanswered note"),
                text: String(p.unanswered),
              })
            : p.needs_you
              ? needsDot()
              : null,
        ),
        expanded
          ? h(
              "ul",
              { class: "proj-pages" },
              pages.map((pg) =>
                h(
                  "li",
                  {},
                  h(
                    "a",
                    {
                      href: openLink(pg.open_id),
                      title: pg.rel_path,
                      class: pg.needs_you ? "need" : "",
                    },
                    h("span", { class: "pg-title", text: titleOf(pg) }),
                    pg.needs_you
                      ? needsDot()
                      : pg.unanswered
                        ? h("span", {
                            class: "count",
                            title: plural(pg.unanswered, "unanswered note"),
                            text: String(pg.unanswered),
                          })
                        : null,
                  ),
                  pg.copies.length > 1
                    ? h(
                        "div",
                        { class: "mini-chips" },
                        pg.copies.map((c) =>
                          h("a", {
                            class: `mini-chip${c.unanswered ? " waiting" : ""}`,
                            href: openLink(c.id),
                            title: `${c.label} · ${c.file}`,
                            text: middle(c.label, 18),
                          }),
                        ),
                      )
                    : null,
                ),
              ),
            )
          : null,
      );
    });
  $(".projects").replaceChildren(
    ...(list.length ? list : [h("li", { class: "side-empty", text: "No projects yet." })]),
  );
}

/** Access requests waiting for the owner (RLM-398): a count on Settings. */
let waitingPeople = 0;

async function loadSide(): Promise<void> {
  try {
    const [p, pages, asks] = await Promise.all([
      get<ProjectsResponse>("/hub/api/projects"),
      get<PagesResponse>("/hub/api/pages"),
      get<AccessRequestsResponse>("/hub/api/people/requests"),
    ]);
    projects = p.projects;
    sidePages = pages.pages;
    waitingPeople = asks.waiting.length;
  } catch {
    // the main view says why
  }
  renderSide();
}

// The hub reads again when the owner comes back to the tab: pages change while it sits in the background.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void loadSide();
    void refresh();
  }
});

history.replaceState(null, "", toUrl(state));
if (state.view !== "search") store(LAST_VIEW, state.view);
renderSide();
void loadSide().then(() => {
  // The Pages view names projects' roots; the sidebar's data has them.
  if (state.view === "pages") void refresh();
});
void refresh();
