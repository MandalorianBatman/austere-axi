// Navigation between the hub and review pages (RLM-358), in the owner's review header only: a
// breadcrumb `Project › Page` to the hub, a switcher between the copies of a page in several
// worktrees, a quick switcher (Ctrl/Cmd+K) over pages and parts, and "Next page with unanswered notes".
// Reviewers and hosted pages never load it; its routes (/hub/api/*) answer the owner only.
import { h } from "./dom.ts";
import type { Child } from "./dom.ts";
import { icon, svgIcon } from "./icons.ts";
import type { CopySummary, InboxResponse, SearchResponse, ShellPage } from "../shared/hub-api.ts";

export interface NavHooks {
  /** This copy's id. */
  id: string;
  /** The header's title block: the breadcrumb goes before the title, the copy switcher after it. */
  bar: HTMLElement;
  /** The ⋯ menu: the switcher and "Next page with unanswered notes" go in it. */
  menu: HTMLElement;
  /** A short message in the page's banner. */
  flash(text: string): void;
  /** Outline these statements in the frame and scroll to the first. */
  highlight(ids: string[]): void;
  /** Open the page's agent popover. */
  openAttach(): void;
}

/** A page the owner opened lately, newest first: what the quick switcher lists before anything is typed. */
interface Recent {
  id: string;
  title: string;
  project: string;
  rel_path: string;
}

const RECENT = "austere:recent-pages";
const RECENT_MAX = 12;

function recents(): Recent[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT) || "[]");
    return Array.isArray(raw)
      ? raw
          .filter(
            (r): r is Recent =>
              !!r &&
              typeof r === "object" &&
              typeof r.id === "string" &&
              typeof r.title === "string",
          )
          .slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function remember(r: Recent): void {
  // One entry a page: a copy in another worktree replaces it.
  const list = [
    r,
    ...recents().filter(
      (x) => x.id !== r.id && !(x.project === r.project && x.rel_path === r.rel_path),
    ),
  ].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
    // private mode: no recents
  }
}

const open = (id: string, extra = ""): string => `/hub/open/${id}${extra}`;

interface Item {
  href: string;
  title: string;
  sub: string;
  kind: "recent" | "page" | "part";
  /** A part's statement id, shown as a mono chip before it. */
  chip?: string;
  /** A page's inbox group, as a dot before it. */
  state?: { cls: string; label: string };
  /** What a page holds for the owner, on the row's right. */
  meta?: { text: string; cls?: string };
}

/** The switcher's groups, in the order its items come. */
const GROUPS: [Item["kind"], string][] = [
  ["recent", "Opened lately"],
  ["page", "Pages"],
  ["part", "Parts of pages"],
];

function pageState(p: ShellPage): Item["state"] {
  if (p.group === "needs_you") return { cls: "needs", label: "Needs you" };
  // As the hub's Inbox: green only while an agent has the notes or is there to take them.
  if (p.group === "waiting_on_agent")
    return p.run_active
      ? { cls: "working", label: "Agent working" }
      : p.taker === "listening"
        ? { cls: "working", label: "Agent listening" }
        : { cls: "waiting", label: "Waiting on an agent" };
  return { cls: "quiet", label: "Quiet" };
}

function pageMeta(p: ShellPage): Item["meta"] {
  if (p.changed > 0) return { text: "Changed since you looked", cls: "changed" };
  if (p.unanswered > 0) return { text: `${p.unanswered} unanswered` };
  return undefined;
}

/** `text` with the words searched for marked. */
function marked(text: string, words: string[]): Child[] {
  const lower = text.toLowerCase();
  const out: Child[] = [];
  let at = 0;
  while (words.length && at < text.length) {
    let best = -1;
    let len = 0;
    for (const w of words) {
      const i = lower.indexOf(w, at);
      if (i >= 0 && (best < 0 || i < best || (i === best && w.length > len))) {
        best = i;
        len = w.length;
      }
    }
    if (best < 0) break;
    if (best > at) out.push(text.slice(at, best));
    out.push(h("mark", { class: "qs-hit", text: text.slice(best, best + len) }));
    at = best + len;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A link in the breadcrumb: its name, or on a phone a back arrow (the name stays its text). */
function crumbLink(href: string, name: string, title?: string): HTMLAnchorElement {
  return h(
    "a",
    { class: "crumb", href, title },
    svgIcon([["path", { d: "m15 6-6 6 6 6" }]], { size: 20, width: 2, cls: "crumb-back" }),
    h("span", { class: "crumb-name", text: name }),
  );
}

/** Install the owner's navigation; returns what the chrome calls once the frame has rendered. */
export function installNav(hooks: NavHooks): { frameReady(): void; toggleSwitcher(): void } {
  const fragment = new URLSearchParams(location.hash.slice(1));
  let part = fragment.get("part");
  if (fragment.has("part") || fragment.has("attach")) {
    const attach = fragment.has("attach");
    fragment.delete("part");
    fragment.delete("attach");
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ""}`,
    );
    if (attach) setTimeout(hooks.openAttach, 0);
  }

  // ── breadcrumb and copy switcher ──
  const crumbs = h(
    "nav",
    { class: "crumbs", "aria-label": "Breadcrumb" },
    crumbLink("/", "Hub"),
    h("span", { class: "crumb-sep", "aria-hidden": "true", text: "/" }),
  );
  hooks.bar.prepend(crumbs);
  void fetch(`/hub/api/page/${hooks.id}`)
    .then((r) => (r.ok ? (r.json() as Promise<CopySummary>) : null))
    .then((summary) => {
      if (!summary) return;
      if (summary.project) {
        crumbs.firstElementChild?.replaceWith(
          crumbLink(
            `/?project=${encodeURIComponent(summary.project.id)}`,
            summary.project.name,
            `${summary.project.name} in the hub`,
          ),
        );
      }
      remember({
        id: summary.id,
        title: summary.title || summary.rel_path,
        project: summary.project?.name ?? "",
        rel_path: summary.rel_path,
      });
      if (summary.copies.length < 2) return;
      const select = h(
        "select",
        {
          class: "copy-switch",
          "aria-label": "Copy of this page (worktree)",
          title: "The same page in another worktree",
        },
        summary.copies.map((c) =>
          h("option", {
            value: c.id,
            selected: c.id === summary.id,
            text: `${c.label}${c.missing ? " (missing)" : c.archived ? " (archived)" : ""}`,
          }),
        ),
      );
      select.addEventListener("change", () => {
        if (select.value !== summary.id) location.href = open(select.value);
      });
      hooks.bar.append(
        h(
          "span",
          { class: "copy-switch-wrap" },
          icon("branch", { size: 12, width: 2, cls: "copy-switch-icon" }),
          select,
          icon("chevronDown", { size: 12, width: 2, cls: "copy-switch-caret" }),
        ),
      );
    })
    .catch(() => {
      // the server is gone: the crumb still links to the hub
    });

  // ── quick switcher ──
  const input = h("input", {
    type: "search",
    class: "qs-input",
    placeholder: "Search pages and parts",
    "aria-label": "Search pages and parts",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "qs-list",
    autocomplete: "off",
  });
  const list = h("ul", {
    class: "qs-list",
    id: "qs-list",
    role: "listbox",
    "aria-label": "Pages and parts",
  });
  const kbd = (text: string): HTMLElement => h("kbd", { class: "qs-kbd", text });
  const hubLink = h("a", { class: "qs-hub", href: "/", text: "Open the hub" });
  const dialog = h(
    "div",
    { class: "qs", role: "dialog", "aria-modal": "true", "aria-label": "Go to page", hidden: true },
    h(
      "div",
      { class: "qs-box" },
      h(
        "label",
        { class: "qs-field" },
        icon("search", { size: 17, width: 1.8 }),
        input,
        h("kbd", { class: "qs-kbd qs-esc", "aria-hidden": "true", text: "Esc" }),
      ),
      list,
      h(
        "div",
        { class: "qs-foot" },
        h("span", { class: "qs-keys" }, kbd("↑"), kbd("↓"), " to move"),
        h("span", { class: "qs-keys" }, kbd("Enter"), " to open"),
        h("span", { class: "qs-keys" }, kbd("Esc"), " to close"),
        hubLink,
      ),
    ),
  );
  document.body.append(dialog);
  let items: Item[] = [];
  let active = 0;
  let gen = 0;
  let timer = 0;
  let returnFocus: Element | null = null;
  /** A search for the current text is on its way: the list shows nothing older. */
  let searching = false;
  /** The rendered options, in the order of `items`. */
  let options: HTMLElement[] = [];

  function row(it: Item, i: number, words: string[]): HTMLLIElement {
    const lead =
      it.kind === "part"
        ? h("span", { class: "qs-chip", text: it.chip ?? "" })
        : it.state
          ? h("span", {
              class: `qs-dot ${it.state.cls}`,
              role: "img",
              "aria-label": it.state.label,
              title: it.state.label,
            })
          : icon("file", { size: 15, cls: "qs-lead" });
    return h(
      "li",
      {
        id: `qs-${i}`,
        role: "option",
        class: `qs-item ${it.kind}`,
        "aria-selected": String(i === active),
        onclick: () => (location.href = it.href),
        onmousemove: () => select(i),
      },
      lead,
      h(
        "span",
        { class: "qs-text" },
        h("span", { class: "qs-title" }, it.kind === "part" ? marked(it.title, words) : it.title),
        h("span", { class: it.kind === "part" ? "qs-sub" : "qs-sub qs-path", text: it.sub }),
      ),
      it.meta
        ? h("span", {
            class: it.meta.cls ? `qs-meta ${it.meta.cls}` : "qs-meta",
            text: it.meta.text,
          })
        : null,
      h("kbd", { class: "qs-kbd qs-enter", "aria-hidden": "true", text: "Enter" }),
    );
  }

  function render(): void {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    list.replaceChildren(
      ...(items.length
        ? GROUPS.flatMap(([kind, label]) => {
            const rows = items.flatMap((it, i) => (it.kind === kind ? [row(it, i, words)] : []));
            if (!rows.length) return [];
            const id = `qs-g-${kind}`;
            return [
              h(
                "li",
                { class: "qs-group", role: "group", "aria-labelledby": id },
                h("span", { class: "qs-group-label", id, text: label }),
                h("ul", { class: "qs-rows", role: "none" }, rows),
              ),
            ];
          })
        : [
            h("li", {
              class: "qs-empty",
              text: searching
                ? "Searching…"
                : input.value.trim()
                  ? "Nothing matches."
                  : "No other page opened lately. Type to search every page.",
            }),
          ]),
    );
    options = [...list.querySelectorAll<HTMLElement>(".qs-item")];
    input.setAttribute("aria-activedescendant", items.length ? `qs-${active}` : "");
  }

  function select(i: number): void {
    if (i === active) return;
    active = i;
    for (const [n, li] of options.entries()) li.setAttribute("aria-selected", String(n === active));
    input.setAttribute("aria-activedescendant", `qs-${active}`);
    options[active]?.scrollIntoView({ block: "nearest" });
  }

  function recentItems(): Item[] {
    return recents()
      .filter((r) => r.id !== hooks.id)
      .map((r) => ({
        href: open(r.id),
        title: r.title,
        sub: [r.project, r.rel_path].filter(Boolean).join(" / "),
        kind: "recent" as const,
      }));
  }

  async function lookUp(): Promise<void> {
    const q = input.value.trim();
    const mine = ++gen;
    if (!q) {
      items = recentItems();
      active = 0;
      searching = false;
      return render();
    }
    let data: SearchResponse;
    try {
      const r = await fetch(`/hub/api/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(String(r.status));
      data = (await r.json()) as SearchResponse;
    } catch {
      if (mine !== gen) return;
      searching = false;
      render();
      hooks.flash("Could not reach austere-axi to search.");
      return;
    }
    if (mine !== gen) return;
    // Pages opened lately come first among the pages that match.
    const order = new Map(recents().map((r, i) => [`${r.project}\0${r.rel_path}`, i]));
    const rank = (key: string): number => order.get(key) ?? RECENT_MAX;
    const pages = [...data.pages].sort(
      (a, b) => rank(`${a.project}\0${a.rel_path}`) - rank(`${b.project}\0${b.rel_path}`),
    );
    items = [
      ...pages.map((p): Item => ({
        href: open(p.open_id),
        title: p.title || p.rel_path,
        sub: [p.project, p.rel_path].filter(Boolean).join(" / "),
        kind: "page",
        state: pageState(p),
        meta: pageMeta(p),
      })),
      ...data.parts.map((x): Item => {
        const page = x.title || x.file.split(/[\\/]/).pop() || x.file;
        return {
          href: open(x.artifact_id, `?part=${encodeURIComponent(x.statement)}`),
          title: x.snippet || page,
          sub: [x.component, `in ${page}`, x.copy].filter(Boolean).join(" · "),
          kind: "part",
          chip: x.statement,
        };
      }),
    ];
    active = 0;
    searching = false;
    render();
  }

  function show(): void {
    if (!dialog.hidden) return;
    returnFocus = document.activeElement;
    dialog.hidden = false;
    input.value = "";
    void lookUp();
    input.focus();
  }

  function hide(): void {
    if (dialog.hidden) return;
    dialog.hidden = true;
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    // The results shown are for the old text: drop them (and any answer still on its way) until this one is in.
    gen++;
    items = [];
    searching = true;
    render();
    timer = window.setTimeout(() => void lookUp(), 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length)
        select((active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) location.href = it.href;
    }
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (e.key === "Tab") {
      // A modal: focus stays in the box, between the search field and the hub link.
      e.preventDefault();
      (document.activeElement === input ? hubLink : input).focus();
    }
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) hide();
  });
  function toggleSwitcher(): void {
    if (dialog.hidden) show();
    else hide();
  }
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      toggleSwitcher();
    }
  });

  // ── next unanswered ──
  async function nextUnanswered(): Promise<void> {
    let inbox: InboxResponse;
    try {
      const r = await fetch("/hub/api/inbox");
      if (!r.ok) throw new Error(String(r.status));
      inbox = (await r.json()) as InboxResponse;
    } catch {
      return hooks.flash("Could not reach austere-axi.");
    }
    // The inbox's order: pages that need the owner, then pages waiting on an agent.
    const pages = [...inbox.needs_you, ...inbox.waiting_on_agent].filter((p) => p.unanswered > 0);
    const here = pages.findIndex((p) => p.copies.some((c) => c.id === hooks.id));
    const next = here < 0 ? pages[0] : pages.slice(here + 1).concat(pages.slice(0, here))[0];
    if (!next)
      return hooks.flash(
        here < 0 ? "No page has unanswered notes." : "No other page has unanswered notes.",
      );
    // The copy with the notes: chips come with unanswered copies first.
    location.href = open(next.copies.find((c) => c.unanswered > 0)?.id ?? next.open_id);
  }

  const goto = h(
    "button",
    {
      type: "button",
      "data-cmd": "goto",
      title: "Pages and parts of every project (Ctrl/Cmd+K)",
      onclick: () => setTimeout(show, 0),
    },
    "Go to page…",
    h("kbd", { class: "nav-kbd", text: "Ctrl K" }),
  );
  const next = h("button", {
    type: "button",
    "data-cmd": "next-unanswered",
    title: "The next page in the hub's inbox with notes no agent answered",
    text: "Next page with unanswered notes",
    onclick: () => void nextUnanswered(),
  });
  hooks.menu.prepend(goto, next);

  return {
    toggleSwitcher,
    frameReady() {
      if (!part) return;
      hooks.highlight([part]);
      part = null;
    },
  };
}
