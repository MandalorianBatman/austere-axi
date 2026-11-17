// Navigation between the hub and review pages (RLM-358), in the owner's review header only: a
// breadcrumb `Project › Page` to the hub, a switcher between the copies of a page in several
// worktrees, a quick switcher (Ctrl/Cmd+K) over pages and parts, and "Next unanswered page".
// Reviewers and hosted pages never load it; its routes (/hub/api/*) answer the owner only.
import { h } from "./dom.ts";
import type { CopySummary, InboxResponse, SearchResponse } from "../shared/hub-api.ts";

export interface NavHooks {
  /** This copy's id. */
  id: string;
  /** The header's title block: the breadcrumb goes before the title, the copy switcher after it. */
  bar: HTMLElement;
  /** The ⋯ menu: the switcher and "Next unanswered page" go in it. */
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
    return Array.isArray(raw) ? raw.filter((r): r is Recent => !!r && typeof r === "object" && typeof r.id === "string" && typeof r.title === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(r: Recent): void {
  // One entry a page: a copy in another worktree replaces it.
  const list = [r, ...recents().filter((x) => x.id !== r.id && !(x.project === r.project && x.rel_path === r.rel_path))].slice(0, RECENT_MAX);
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
}

/** Install the owner's navigation; returns what the chrome calls once the frame has rendered. */
export function installNav(hooks: NavHooks): { frameReady(): void; toggleSwitcher(): void } {
  const fragment = new URLSearchParams(location.hash.slice(1));
  let part = fragment.get("part");
  if (fragment.has("part") || fragment.has("attach")) {
    const attach = fragment.has("attach");
    fragment.delete("part");
    fragment.delete("attach");
    history.replaceState(history.state, "", `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ""}`);
    if (attach) setTimeout(hooks.openAttach, 0);
  }

  // ── breadcrumb and copy switcher ──
  const crumbs = h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, h("a", { class: "crumb", href: "/", text: "Hub" }), h("span", { class: "crumb-sep", "aria-hidden": "true", text: "›" }));
  hooks.bar.prepend(crumbs);
  void fetch(`/hub/api/page/${hooks.id}`)
    .then((r) => (r.ok ? (r.json() as Promise<CopySummary>) : null))
    .then((summary) => {
      if (!summary) return;
      if (summary.project) {
        crumbs.firstElementChild?.replaceWith(h("a", { class: "crumb", href: `/?project=${encodeURIComponent(summary.project.id)}`, title: `${summary.project.name} in the hub`, text: summary.project.name }));
      }
      remember({ id: summary.id, title: summary.title || summary.rel_path, project: summary.project?.name ?? "", rel_path: summary.rel_path });
      if (summary.copies.length < 2) return;
      const select = h(
        "select",
        { class: "copy-switch", "aria-label": "Copy of this page (worktree)", title: "The same page in another worktree" },
        summary.copies.map((c) => h("option", { value: c.id, selected: c.id === summary.id, text: `${c.label}${c.missing ? " (missing)" : c.archived ? " (archived)" : ""}` })),
      );
      select.addEventListener("change", () => {
        if (select.value !== summary.id) location.href = open(select.value);
      });
      hooks.bar.append(select);
    })
    .catch(() => {
      // the server is gone: the crumb still links to the hub
    });

  // ── quick switcher ──
  const input = h("input", { type: "search", class: "qs-input", placeholder: "Go to a page or a part…", "aria-label": "Go to a page or a part", role: "combobox", "aria-expanded": "true", "aria-controls": "qs-list", autocomplete: "off" });
  const list = h("ul", { class: "qs-list", id: "qs-list", role: "listbox", "aria-label": "Pages and parts" });
  const dialog = h(
    "div",
    { class: "qs", role: "dialog", "aria-modal": "true", "aria-label": "Go to a page", hidden: true },
    h("div", { class: "qs-box" }, input, list, h("div", { class: "qs-foot", text: "↑ ↓ to move · Enter to open · Esc to close" })),
  );
  document.body.append(dialog);
  let items: Item[] = [];
  let active = 0;
  let gen = 0;
  let timer = 0;
  let returnFocus: Element | null = null;
  /** A search for the current text is on its way: the list shows nothing older. */
  let searching = false;

  function render(): void {
    list.replaceChildren(
      ...(items.length
        ? items.map((it, i) =>
            h(
              "li",
              { id: `qs-${i}`, role: "option", class: `qs-item ${it.kind}`, "aria-selected": String(i === active), onclick: () => (location.href = it.href), onmousemove: () => select(i) },
              h("span", { class: "qs-title", text: it.title }),
              h("span", { class: "qs-sub", text: it.sub }),
            ),
          )
        : [h("li", { class: "qs-empty", text: searching ? "Searching…" : input.value.trim() ? "Nothing matches." : "No other page opened lately. Type to search every page." })]),
    );
    input.setAttribute("aria-activedescendant", items.length ? `qs-${active}` : "");
  }

  function select(i: number): void {
    if (i === active) return;
    active = i;
    for (const [n, li] of [...list.children].entries()) li.setAttribute("aria-selected", String(n === active));
    input.setAttribute("aria-activedescendant", `qs-${active}`);
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function recentItems(): Item[] {
    return recents()
      .filter((r) => r.id !== hooks.id)
      .map((r) => ({ href: open(r.id), title: r.title, sub: [r.project, r.rel_path].filter(Boolean).join(" · "), kind: "recent" as const }));
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
    const pages = [...data.pages].sort((a, b) => rank(`${a.project}\0${a.rel_path}`) - rank(`${b.project}\0${b.rel_path}`));
    items = [
      ...pages.map((p) => ({ href: open(p.open_id), title: p.title || p.rel_path, sub: [p.project, p.rel_path, p.unanswered ? `${p.unanswered} unanswered` : ""].filter(Boolean).join(" · "), kind: "page" as const })),
      ...data.parts.map((x) => ({ href: open(x.artifact_id, `?part=${encodeURIComponent(x.statement)}`), title: `${x.title || x.file.split(/[\\/]/).pop()} · ${x.statement}`, sub: x.snippet, kind: "part" as const })),
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
      if (items.length) select((active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) location.href = it.href;
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (e.key === "Tab") {
      // A modal: focus stays in the box.
      e.preventDefault();
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
    if (!next) return hooks.flash(here < 0 ? "No page has unanswered notes." : "No other page has unanswered notes.");
    // The copy with the notes: chips come with unanswered copies first.
    location.href = open(next.copies.find((c) => c.unanswered > 0)?.id ?? next.open_id);
  }

  const goto = h("button", { type: "button", "data-cmd": "goto", title: "Pages and parts of every project (Ctrl/Cmd+K)", text: "Go to page… (Ctrl+K)", onclick: () => setTimeout(show, 0) });
  const next = h("button", { type: "button", "data-cmd": "next-unanswered", title: "The next page in the hub's inbox with notes no agent answered", text: "Next unanswered page", onclick: () => void nextUnanswered() });
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
