// The hub shell (RLM-357): the owner's home page, a small client app over /hub/api (src/cli/hub-api.ts).
// A sidebar of projects and their pages; the views Inbox (default) · Pages · Notes · Runs · Settings (settings.ts); search over
// pages and parts. Plain DOM through h(), every text through textContent. The server answers only the
// owner (the cookie); this page holds no secret of its own.
import { h } from "./dom.ts";
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

const BOOT: HubBoot = (window as Window & { __AUSTERE_HUB__?: HubBoot }).__AUSTERE_HUB__ ?? { version: "", home: "", sep: "/" };

type View = "inbox" | "pages" | "notes" | "runs" | "settings" | "search";
const VIEWS: { id: Exclude<View, "search">; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "pages", label: "Pages" },
  { id: "notes", label: "Notes" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
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
  return { view, project: p.get("project") || "", pagesView, q: p.get("q") || "", status: p.get("status") || "", author: p.get("author") || "", device: p.get("device") || "" };
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

const TAKER: Record<string, string> = { listening: "an agent is listening", nobody: "nobody is taking them" };
const STATUS_LABEL: Record<string, string> = { open: "unanswered", received: "unanswered", addressed: "answered", held: "held for you" };

// ── layout ──

document.body.append(
  h(
    "div",
    { class: "hub" },
    h(
      "aside",
      { class: "side", id: "side", "aria-label": "Projects and views" },
      h("div", { class: "brand" }, h("a", { href: "/?view=inbox", text: "austere-axi hub" }), h("small", { text: BOOT.version })),
      h("nav", { class: "views", "aria-label": "Views" }),
      h("div", { class: "side-h" }, h("span", { text: "Projects" }), h("a", { class: "all-projects", href: "/", hidden: true, text: "All" })),
      h("ul", { class: "projects" }),
    ),
    h("div", { class: "scrim" }),
    h(
      "div",
      { class: "main" },
      h(
        "header",
        { class: "top" },
        h("button", { type: "button", class: "side-toggle", "aria-controls": "side", "aria-expanded": "false", text: "Projects" }),
        h("form", { class: "search", role: "search" }, h("input", { type: "search", name: "q", placeholder: "Search pages and parts", "aria-label": "Search pages and parts", autocomplete: "off" })),
      ),
      h("div", { class: "status", role: "status", "aria-live": "polite" }),
      h("main", { class: "content", id: "content", tabindex: "-1" }),
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
  if (open) $<HTMLElement>(".views a")?.focus();
}
narrow.addEventListener("change", syncSide);
syncSide();
$(".side-toggle").addEventListener("click", () => setSide(!document.documentElement.classList.contains("side-open")));
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
  if (r.status === 403) throw new Refused("This browser is not signed in as the owner. Run `austere-axi hub open` to sign in again.");
  if (!r.ok) throw new Error(`austere-axi answered ${r.status}`);
  return (await r.json()) as T;
}

async function post(route: string, body: object = {}): Promise<ArchiveResult | null> {
  try {
    const r = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
  const extra = [c.unanswered ? `${c.unanswered} unanswered` : "", c.listening ? "agent listening" : "", c.missing ? "missing" : "", c.archived ? "archived" : ""].filter(Boolean);
  return h(
    "a",
    { class: `chip${c.unanswered ? " waiting" : ""}${c.missing ? " gone" : ""}`, href: openLink(c.id), title: `${c.label} · ${c.file}`, "data-copy": c.id },
    middle(c.label, 28),
    extra.length ? h("span", { text: extra.join(" · ") }) : null,
  );
}

/** How many chips a row shows before "+n more". */
const CHIPS = 3;

function chips(copies: ShellCopy[]): HTMLElement | null {
  if (copies.length < 2) return null;
  const rest = copies.slice(CHIPS);
  return h(
    "div",
    { class: "chips" },
    copies.slice(0, CHIPS).map(chip),
    rest.length ? h("details", { class: "more" }, h("summary", { text: `+${rest.length} more` }), h("div", { class: "chips" }, rest.map(chip))) : null,
  );
}

/** What is worth saying about a page's state beyond its notes: gone, archived, only checked, an agent listening. A quiet page says nothing. */
function stateWords(p: ShellPage): Child[] {
  const only = p.copies.length === 1 ? p.copies[0] : null;
  if (!only) {
    const out: Child[] = [plural(p.copies.length, "copy", "copies")];
    if (p.copies.every((c) => c.missing)) out.push(h("em", { class: "gone", text: "missing" }));
    else if (p.copies.some((c) => c.listening)) out.push(h("em", { class: "live", text: "agent listening" }));
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
  if (p.changed) lines.push(h("li", { class: "need", text: `Changed since you looked: ${plural(p.changed, "revision")}` }));
  if (p.held) lines.push(h("li", { class: "need", text: `${plural(p.held, "note")} held for you to release` }));
  if (p.failed) {
    const run = p.copies.find((c) => c.failed_run)?.failed_run;
    lines.push(h("li", { class: "need", text: `Agent run failed${run?.reason ? ` (${run.reason.replace(/_/g, " ")})` : ""}${run?.ended_at ? ` · ${when(run.ended_at)}` : ""}` }));
  }
  if (p.taker) {
    const waiting = p.unanswered - p.held;
    lines.push(
      h(
        "li",
        { class: `wait ${p.taker}` },
        `${plural(waiting, "unanswered note")} · ${p.taker === "attach_on" ? (p.run_active ? "agent on: a run is working on them" : "agent on: your next note starts a run") : TAKER[p.taker]}`,
        p.taker === "nobody" ? h("a", { class: "btn tiny", href: openLink(p.open_id, { attach: "1" }), text: "Turn agent on" }) : null,
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
      h("li", {}, h("span", { class: "quote", text: n.text || "(no text)" }), h("span", { class: "by", text: joined([n.author || "you", n.target ? `on ${n.target}` : "", n.label, STATUS_LABEL[n.status] ?? n.status]).join("") })),
    ),
  );
}

interface RowOptions {
  showProject?: boolean;
  notes?: InboxPage["notes"];
  archivedView?: boolean;
}

function pageRow(p: ShellPage, opts: RowOptions = {}): HTMLElement {
  const main = p.copies.find((c) => c.id === p.open_id) ?? p.copies[0];
  const counts: Child[] = [p.unanswered ? h("b", { class: "open", text: `${p.unanswered} unanswered` }) : null, p.addressed ? `${p.addressed} answered` : null];
  const meta = joined([p.rel_path, opts.showProject ? p.project : null, when(p.activity), ...stateWords(p), ...counts]);
  const li = h(
    "li",
    { class: `row ${p.group}`, "data-page": p.id },
    h(
      "div",
      { class: "row-main" },
      h("a", { class: "row-title", href: openLink(p.open_id), title: main?.file ?? "" }, titleOf(p)),
      h("span", { class: "meta" }, meta),
      reasons(p),
      notePreview(opts.notes ?? []),
      chips(p.copies),
    ),
  );
  const archive: HTMLButtonElement = h("button", {
    type: "button",
    class: "btn ghost",
    text: opts.archivedView ? "Unarchive" : "Archive",
    title: opts.archivedView ? "Bring this page back to the lists" : p.copies.length > 1 ? "Put every copy of this page away; its notes are kept" : "Put this page away; its notes are kept",
    "aria-label": `${opts.archivedView ? "Unarchive" : "Archive"} ${titleOf(p)}`,
    onclick: () => void flip(p, archive, opts.archivedView ? "unarchive" : "archive"),
  });
  li.append(h("div", { class: "row-actions" }, archive));
  return li;
}

async function flip(p: ShellPage, button: HTMLButtonElement, action: "archive" | "unarchive"): Promise<void> {
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

function section(title: string, count: number | null, body: Child, extra: Child = null, cls = ""): HTMLElement {
  const id = `h-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return h("section", { class: cls, "aria-labelledby": id }, h("h2", { id }, title, count == null ? null : h("span", { class: "n", text: String(count) }), extra), body);
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
  return h("p", { class: "filter" }, `Project ${p?.name ? tilde(p.name) : state.project}`, " · ", viewLink({ project: "" }, "all projects"));
}

async function renderInbox(): Promise<Child[]> {
  const data = await get<InboxResponse>(`/hub/api/inbox${query({ project: state.project })}`);
  const all = data.needs_you.length + data.waiting_on_agent.length + data.quiet.length;
  const showProject = !state.project;
  const rows = (list: InboxPage[]): HTMLElement => h("ul", { class: "rows" }, list.map((p) => pageRow(p, { showProject, notes: p.notes })));
  if (!all) {
    return [
      h("h1", { text: "Inbox" }),
      projectFilter(data.project),
      empty(state.project ? "Nothing is open for review in this project." : "No pages yet. Open one for review with austere-axi and it shows up here."),
    ];
  }
  const summary = joined([
    data.needs_you.length ? `${plural(data.needs_you.length, "page needs", "pages need")} you` : "nothing needs you",
    data.waiting_on_agent.length ? `${plural(data.waiting_on_agent.length, "page waits", "pages wait")} on an agent` : null,
    data.held ? `${plural(data.held, "note")} held for release` : null,
    data.failed_runs.length ? plural(data.failed_runs.length, "failed run") : null,
  ]);
  return [
    h("h1", { text: "Inbox" }),
    h("p", { class: "summary" }, summary),
    projectFilter(data.project),
    section("Needs you", data.needs_you.length, data.needs_you.length ? rows(data.needs_you) : empty("Nothing changed since you looked, no note is held for you and no run failed."), null, "group needs"),
    section("Waiting on agent", data.waiting_on_agent.length, data.waiting_on_agent.length ? rows(data.waiting_on_agent) : empty("No unanswered notes."), null, "group waiting"),
    section("Quiet", data.quiet.length, data.quiet.length ? rows(data.quiet) : empty("Every page has something going on."), null, "group quiet"),
  ];
}

const PAGE_VIEWS: { id: PagesView; label: string; count: "open" | "everything" | "archived" }[] = [
  { id: "open", label: "Open", count: "open" },
  { id: "all", label: "Everything", count: "everything" },
  { id: "archived", label: "Archived", count: "archived" },
];

async function renderPages(): Promise<Child[]> {
  const data = await get<PagesResponse>(`/hub/api/pages${query({ project: state.project, view: state.pagesView })}`);
  const { counts } = data;
  const tabs = h(
    "p",
    { class: "filter tabs" },
    joined(PAGE_VIEWS.map((v) => (v.id === state.pagesView ? h("b", { "aria-current": "page", text: `${v.label} (${counts[v.count]})` }) : viewLink({ pagesView: v.id }, `${v.label} (${counts[v.count]})`)))),
  );
  const head = [h("h1", { text: "Pages" }), h("p", { class: "summary", text: joined([plural(data.pages.length, "page"), plural(new Set(data.pages.map((p) => p.project_id)).size, "project"), data.pages.reduce((n, p) => n + p.unanswered, 0) ? `${data.pages.reduce((n, p) => n + p.unanswered, 0)} unanswered` : null]).join("") }), tabs, projectFilter(data.project)];
  if (!data.pages.length) {
    const others = PAGE_VIEWS.filter((v) => v.id !== state.pagesView && counts[v.count] > 0).map((v) => viewLink({ pagesView: v.id }, `${v.label} (${counts[v.count]})`));
    if (counts.everything === 0 && !state.project) return [...head, empty("No pages yet. Open one for review with austere-axi and it shows up here.")];
    if (state.pagesView === "archived") return [...head, empty("No archived pages.", ...(others.length ? [" See: ", ...joined(others), "."] : []))];
    const parts: Child[] = ["Nothing is open for review."];
    if (counts.checked) parts.push(` ${plural(counts.checked, "page was", "pages were")} checked but never opened: `, viewLink({ pagesView: "all" }, "show them"), ".");
    if (counts.archived) parts.push(` ${counts.archived} archived: `, viewLink({ pagesView: "archived" }, "show"), ".");
    return [...head, empty(...parts)];
  }
  const byProject = new Map<string, ShellPage[]>();
  for (const p of data.pages) {
    let list = byProject.get(p.project_id);
    if (!list) byProject.set(p.project_id, (list = []));
    list.push(p);
  }
  const info = new Map(projects.map((p) => [p.id, p]));
  const sections = [...byProject.entries()].map(([id, list]) => {
    const pinfo = info.get(id);
    const roots = pinfo?.roots ?? [];
    const waiting = list.reduce((n, p) => n + p.unanswered, 0);
    const where = roots.length ? `${middle(tilde(roots[0]), 48)}${roots.length > 1 ? ` · +${roots.length - 1} more ${roots.length === 2 ? "folder" : "folders"}` : ""}` : "";
    return h(
      "section",
      { class: "project" },
      h(
        "h2",
        {},
        viewLink({ project: id }, list[0].project),
        where ? h("small", { title: roots.join("\n"), text: where }) : null,
        waiting ? h("b", { class: "open", text: `${waiting} unanswered` }) : null,
      ),
      pinfo?.same_as ? h("p", { class: "same" }, `Same repository as project ${pinfo.same_as.name}: `, h("code", { text: pinfo.same_as.merge })) : null,
      h("ul", { class: "rows" }, list.map((p) => pageRow(p, { archivedView: state.pagesView === "archived" }))),
    );
  });
  return [...head, ...sections];
}

async function renderNotes(): Promise<Child[]> {
  const data = await get<NotesResponse>(`/hub/api/notes${query({ project: state.project, q: state.q, status: state.status, author: state.author, device: state.device })}`);
  const option = (value: string, label: string, current: string): HTMLOptionElement => h("option", { value, selected: current === value, text: label });
  const form = h(
    "form",
    {
      class: "filters",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const f = new FormData(e.target as HTMLFormElement);
        go(null, { q: String(f.get("q") ?? ""), status: String(f.get("status") ?? ""), author: String(f.get("author") ?? "") });
      },
    },
    h("input", { type: "search", name: "q", value: state.q, placeholder: "Search notes, targets, page titles", "aria-label": "Search notes" }),
    h("select", { name: "status", "aria-label": "Status" }, option("", "All", state.status), option("unanswered", "Unanswered", state.status), option("answered", "Answered", state.status)),
    data.authors.length
      ? h("select", { name: "author", "aria-label": "Author" }, option("", "Everyone", state.author), option("owner", "Owner", state.author), data.authors.map((a) => option(a, a, state.author)))
      : null,
    h("button", { type: "submit", class: "btn", text: "Filter" }),
  );
  const waiting = data.notes.filter((n) => n.status !== "addressed").length;
  const list = data.notes.map((n: NoteRow) => {
    const where = n.label && n.label !== n.project ? `${n.project} · ${n.label}` : n.project;
    return h(
      "li",
      { class: "note" },
      h("a", { href: openLink(n.artifact_id), title: n.file }, h("p", { class: "quote", text: n.text || "(no text)" })),
      h(
        "span",
        { class: "meta" },
        joined([
          n.author ? h("b", { class: "by", text: n.author }) : null,
          n.remote ? "hosted page" : null,
          n.target ? `on ${n.target}` : null,
          h("a", { href: openLink(n.artifact_id), text: n.title || basename(n.file) }),
          where,
          when(n.at),
          h("span", { class: `st ${n.status === "addressed" ? "done" : "waiting"}`, text: STATUS_LABEL[n.status] ?? n.status }),
        ]),
      ),
    );
  });
  const filtered = state.q || state.project || state.author || state.device || state.status;
  return [
    h("h1", { text: "Notes" }),
    h("p", { class: "summary", text: `${plural(data.notes.length, "note")}${waiting ? ` · ${waiting} unanswered` : ""}` }),
    form,
    projectFilter(data.project),
    data.device ? h("p", { class: "filter" }, `Device ${data.device.name} (${data.device.id}) · `, viewLink({ device: "" }, "everyone")) : null,
    list.length ? h("ul", { class: "notes" }, list) : empty(filtered ? "No notes match." : "No notes yet."),
  ];
}

const RUN_STATUS: Record<string, string> = { queued: "queued", waiting_for_session: "waiting for its session", running: "running", done: "done", failed: "failed", stopped: "stopped", interrupted: "interrupted" };

async function renderRuns(): Promise<Child[]> {
  const data = await get<HubRunsResponse>(`/hub/api/runs${query({ project: state.project })}`);
  const row = (r: RunItem): HTMLElement => {
    const took = r.started_at && r.ended_at ? `${Math.max(1, Math.round((r.ended_at - r.started_at) / 1000))} s` : null;
    return h(
      "li",
      { class: `run ${r.status}` },
      h("span", { class: `badge ${r.status}`, text: RUN_STATUS[r.status] ?? r.status }),
      h(
        "span",
        { class: "run-main" },
        r.artifact_id ? h("a", { href: openLink(r.artifact_id), title: r.file ?? "", text: r.title || basename(r.file ?? r.artifact_id) }) : h("span", { text: r.kind === "trigger" ? "Trigger run" : "Run" }),
        h("span", { class: "meta" }, joined([r.harness, r.mode, when(r.started_at), took, r.reason ? r.reason.replace(/_/g, " ") : null])),
      ),
    );
  };
  return [
    h("h1", { text: "Runs" }),
    h("p", { class: "summary", text: "Agent runs the attached agent started, newest first." }),
    projectFilter(data.project),
    data.runs.length ? h("ul", { class: "runs" }, data.runs.map(row)) : empty("No runs yet. Turn an agent on in a page's Agent menu and the owner's notes start one."),
  ];
}

async function renderSearch(): Promise<Child[]> {
  const data = await get<SearchResponse>(`/hub/api/search${query({ q: state.q })}`);
  const part = (hit: PartHit): HTMLElement =>
    h(
      "li",
      { class: "part" },
      h("a", { href: openLink(hit.artifact_id, { part: hit.statement }), title: hit.file }, h("span", { class: "part-title", text: `${hit.title || basename(hit.file)} · ${hit.statement}` }), h("span", { class: "snippet", text: hit.snippet })),
      h("span", { class: "meta", text: joined([hit.component || null, hit.copy]).join("") }),
    );
  return [
    h("h1", {}, "Search: ", h("q", { text: data.q })),
    section("Pages", data.pages.length, data.pages.length ? h("ul", { class: "rows" }, data.pages.map((p) => pageRow(p, { showProject: true }))) : empty("No page title, path or project matches.")),
    section("Parts", data.parts.length, data.parts.length ? h("ul", { class: "parts" }, data.parts.map(part)) : empty("No part of a page says that.")),
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
  notesOf: (d) => viewLink({ view: "notes", device: d.id, project: "", q: "", status: "", author: "" }, `Notes by ${d.name}`),
  get,
};

const RENDER: Record<View, () => Promise<Child[]>> = { inbox: renderInbox, pages: renderPages, notes: renderNotes, runs: renderRuns, settings: () => renderSettings(settingsUi), search: renderSearch };

let generation = 0;

async function refresh(): Promise<void> {
  const gen = ++generation;
  document.title = `${state.view === "search" ? "Search" : VIEWS.find((v) => v.id === state.view)?.label} · austere-axi hub`;
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".views a")) {
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
  content.replaceChildren(...nodes.filter((n): n is Node | string => n != null && n !== false).map((n) => (typeof n === "number" ? String(n) : n)));
}

/** Move to another view or filter; `e`: the click that asked, whose default this replaces. */
function go(e: Event | null, next: Partial<State>, push = true): void {
  const me = e as MouseEvent | null;
  if (me && (me.metaKey || me.ctrlKey || me.shiftKey || me.button === 1)) return;
  e?.preventDefault();
  if (state.view !== "search") previous = state.view;
  state = { ...state, ...next };
  if (next.view && next.view !== "notes" && next.view !== "search") state = { ...state, q: "", status: "", author: "", device: "" };
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

function renderViews(needsYou: number, waiting: number): void {
  $(".views").replaceChildren(
    ...VIEWS.map((v) =>
      h(
        "a",
        { href: toUrl({ ...state, view: v.id }), "data-view": v.id, "aria-current": state.view === v.id ? "page" : false, onclick: (e: Event) => go(e, { view: v.id }) },
        v.label,
        v.id === "inbox" && needsYou ? h("span", { class: "count need", title: `${plural(needsYou, "page needs", "pages need")} you`, text: String(needsYou) }) : null,
        v.id === "settings" && waiting ? h("span", { class: "count need", title: `${plural(waiting, "person asks", "people ask")} for access`, text: String(waiting) }) : null,
      ),
    ),
  );
}

/** Projects show their pages until the owner folds them. */
const closedProjects = new Set<string>(stored<string[]>(CLOSED_PROJECTS, []));

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
      const toggle = h("button", {
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
      });
      return h(
        "li",
        { class: `proj${selected ? " selected" : ""}` },
        h(
          "div",
          { class: "proj-head" },
          toggle,
          h("a", { class: "proj-link", href: toUrl({ ...state, project: p.id }), title: p.roots.join("\n"), "aria-current": selected ? "true" : false, onclick: (e: Event) => go(e, { project: p.id }), text: p.name }),
          p.unanswered ? h("span", { class: `count${p.needs_you ? " need" : ""}`, title: `${plural(p.unanswered, "unanswered note")}`, text: String(p.unanswered) }) : null,
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
                    { href: openLink(pg.open_id), title: pg.rel_path, class: pg.needs_you ? "need" : "" },
                    h("span", { class: "pg-title", text: titleOf(pg) }),
                    pg.unanswered ? h("span", { class: "count", text: String(pg.unanswered) }) : null,
                  ),
                  pg.copies.length > 1 ? h("div", { class: "mini-chips" }, pg.copies.map((c) => h("a", { class: `mini-chip${c.unanswered ? " waiting" : ""}`, href: openLink(c.id), title: `${c.label} · ${c.file}`, text: middle(c.label, 18) }))) : null,
                ),
              ),
            )
          : null,
      );
    });
  $(".projects").replaceChildren(...(list.length ? list : [h("li", { class: "side-empty", text: "No projects yet." })]));
}

/** Access requests waiting for the owner (RLM-398): a count on Settings. */
let waitingPeople = 0;

async function loadSide(): Promise<void> {
  try {
    const [p, pages, asks] = await Promise.all([get<ProjectsResponse>("/hub/api/projects"), get<PagesResponse>("/hub/api/pages"), get<AccessRequestsResponse>("/hub/api/people/requests")]);
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
