// Annotation layer that runs inside the artifact frame during review.
// Every rendered statement is wrapped in [data-oui-id]; pointing at anything
// resolves to the innermost named statement, so feedback lands on a line the
// agent can edit directly.
import type { StatementMap } from "../shared/statements.ts";

/** One statement on the way from the root to the clicked one. */
export interface PathEntry {
  id: string;
  component: string;
}

/** What points inside a statement: a marked part, or a table cell's column and row. */
export interface AnnotationDetail {
  part?: string | null;
  column?: string;
  row?: string;
  rowIndex?: number;
}

/** What the annotator queues for the agent. */
export interface AnnotationItem {
  kind: "annotation";
  target: string;
  component: string;
  path: string[];
  note: string;
  selection?: string;
  excerpt?: string;
  detail?: AnnotationDetail;
}

/** Messages the annotator posts to the chrome. */
export type AnnotatorMessage = { type: "annotate"; item: AnnotationItem } | { type: "toggle-mode" };

/** Ids of the statements that reference `id` (shared/statements.ts referencesTo). */
export type RefsTo = (map: StatementMap, id: string) => string[];

export interface AnnotatorOptions {
  post: (msg: AnnotatorMessage) => void;
  lookup?: () => [StatementMap, RefsTo];
}

export interface Annotator {
  setMode(next: unknown): void;
  flash(ids: string[], tone?: string, map?: StatementMap, refsTo?: RefsTo): Element[];
  reveal(id: string, map?: StatementMap, refsTo?: RefsTo): boolean;
  highlight(ids: string[], scroll?: boolean): number;
}

interface Point {
  x: number;
  y: number;
}

/** Where to open the popover: the statement, the element pointed at, and any selected text. */
interface OpenRequest {
  target: Element;
  el: Element;
  selection?: string;
  point: Point;
}

interface Draft {
  targetId: string;
  component: string;
  path: PathEntry[];
  selection?: string;
  excerpt?: string;
  detail?: AnnotationDetail;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const INTERACTIVE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role=button]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=switch]",
  "[role=option]",
  "[role=slider]",
  "[role=combobox]",
  "[role=listbox]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=treeitem]",
  "[role=gridcell] input",
].join(",");

const UI_ATTR = "data-austere-ui";

function clip(text: string | null | undefined, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function boxOf(node: Element): DOMRect {
  const r = document.createRange();
  r.selectNodeContents(node);
  const rect = r.getBoundingClientRect();
  if (rect.width || rect.height) return rect;
  return node.getBoundingClientRect();
}

/** A statement element's name and component: every [data-oui-id] element carries both attributes. */
function statementOf(el: Element): PathEntry {
  return { id: el.getAttribute("data-oui-id") as string, component: el.getAttribute("data-oui-c") as string };
}

function pathOf(target: Element): PathEntry[] {
  const path: PathEntry[] = [];
  for (let n: Element | null | undefined = target; n; n = n.parentElement?.closest("[data-oui-id]")) {
    path.unshift(statementOf(n));
  }
  return path;
}

/**
 * Extra precision inside a statement. Components mark sub-targets with
 * data-austere-part="<what the agent should hear>" (a diff line, a diagram
 * node, a file path); the nearest one wins and its text becomes the quote.
 * Plain tables get row/column names without any marking.
 */
function partOf(target: Element, el: Element): Element | null {
  const part = el.closest("[data-austere-part]");
  return part && target.contains(part) ? part : null;
}

function detailOf(target: Element, el: Element): AnnotationDetail | undefined {
  const detail: AnnotationDetail = {};
  const part = partOf(target, el);
  if (part) {
    detail.part = part.getAttribute("data-austere-part");
    return detail;
  }
  const cell = el.closest("td, th");
  const row = cell?.parentElement;
  if (cell && row && target.contains(cell)) {
    const table = cell.closest("table");
    const idx = Array.prototype.indexOf.call(row.children, cell);
    const headRow = table?.querySelector("thead tr");
    const head = headRow?.children[idx];
    if (head) detail.column = clip(head.textContent, 60);
    if (row.parentElement?.tagName === "TBODY") {
      const first = row.children[0];
      if (first && first !== cell) detail.row = clip(first.textContent, 60);
      detail.rowIndex = Array.prototype.indexOf.call(row.parentElement.children, row) + 1;
    }
  }
  return Object.keys(detail).length ? detail : undefined;
}

/** lookup() returns [statementMap, referencesTo] for the program on screen; marks resolve ids through it. */
export function createAnnotator({ post, lookup }: AnnotatorOptions): Annotator {
  let mode = "explore";
  const root = document.createElement("div");
  root.setAttribute(UI_ATTR, "");
  root.className = "austere-ui";
  root.innerHTML = `
    <div class="austere-hover" hidden><span class="austere-hover-label"></span></div>
    <button type="button" class="austere-selbtn" hidden>Annotate selection</button>
    <div class="austere-pop" hidden role="dialog" aria-label="Annotate">
      <div class="austere-pop-path"></div>
      <blockquote class="austere-pop-quote"></blockquote>
      <textarea rows="3" placeholder="What should change here?"></textarea>
      <div class="austere-pop-foot">
        <span class="austere-pop-hint">Enter to queue · Shift+Enter newline · Esc</span>
        <span class="austere-pop-actions">
          <button type="button" data-act="cancel">Cancel</button>
          <button type="button" data-act="queue" class="primary">Queue</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(root);

  // Known elements, from the markup just above.
  const hover = root.querySelector(".austere-hover") as HTMLDivElement;
  const hoverLabel = root.querySelector(".austere-hover-label") as HTMLSpanElement;
  const selBtn = root.querySelector(".austere-selbtn") as HTMLButtonElement;
  const pop = root.querySelector(".austere-pop") as HTMLDivElement;
  const popPath = root.querySelector(".austere-pop-path") as HTMLDivElement;
  const popQuote = root.querySelector(".austere-pop-quote") as HTMLQuoteElement;
  const popText = root.querySelector("textarea") as HTMLTextAreaElement;

  let draft: Draft | null = null;
  let pendingSelection: OpenRequest | null = null;
  let hoverRaf = 0;
  let lastHoverEl: EventTarget | null = null;

  const isOurs = (el: EventTarget | null) => el instanceof Element && !!el.closest(`[${UI_ATTR}]`);
  const targetOf = (el: EventTarget | null) => (el instanceof Element && el.closest("[data-oui-id]")) || null;

  function placeBox(box: HTMLElement, rect: DOMRect, pad = 4) {
    box.style.left = `${rect.left - pad}px`;
    box.style.top = `${rect.top - pad}px`;
    box.style.width = `${rect.width + pad * 2}px`;
    box.style.height = `${rect.height + pad * 2}px`;
  }

  function showHover(target: Element | null) {
    if (!target) {
      hover.hidden = true;
      return;
    }
    placeBox(hover, boxOf(target));
    hoverLabel.textContent = `${target.getAttribute("data-oui-id")} · ${target.getAttribute("data-oui-c")}`;
    hover.hidden = false;
  }

  function onMove(e: MouseEvent) {
    if (mode !== "annotate" || !pop.hidden) return;
    lastHoverEl = e.target;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (isOurs(lastHoverEl)) return;
      showHover(targetOf(lastHoverEl));
    });
  }

  function hasTextSelection() {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
  }

  function onClickCapture(e: MouseEvent) {
    if (mode !== "annotate" || isOurs(e.target)) return;
    if (!pop.hidden) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (hasTextSelection()) return;
    const el = e.target;
    // A click lands on an element; anything else has no statement to annotate.
    if (!(el instanceof Element)) return;
    if (!e.altKey && el.closest(INTERACTIVE)) return;
    const target = targetOf(el);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    open({ target, el, point: { x: e.clientX, y: e.clientY } });
  }

  function onSelectionSettled() {
    if (mode !== "annotate" || !pop.hidden) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      selBtn.hidden = true;
      pendingSelection = null;
      return;
    }
    const text = sel.toString().trim();
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const el = container instanceof Element ? container : container.parentElement;
    const target = targetOf(el);
    if (!text || !el || !target || isOurs(el)) {
      selBtn.hidden = true;
      pendingSelection = null;
      return;
    }
    const rect = range.getBoundingClientRect();
    pendingSelection = { target, el, selection: clip(text, 600), point: { x: rect.left, y: rect.bottom } };
    selBtn.hidden = false;
    const w = selBtn.offsetWidth || 140;
    selBtn.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
    selBtn.style.top = `${Math.max(8, Math.min(window.innerHeight - 40, rect.bottom + 8))}px`;
  }

  let selTimer = 0;
  function scheduleSelection() {
    clearTimeout(selTimer);
    selTimer = window.setTimeout(onSelectionSettled, 120);
  }

  selBtn.addEventListener("mousedown", (e) => e.preventDefault());
  selBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pendingSelection) open(pendingSelection);
    selBtn.hidden = true;
  });

  function renderPath() {
    // Only called with a draft open; the chips it draws go when the next draft opens.
    const current = draft;
    if (!current) return;
    popPath.textContent = "";
    current.path.forEach((p, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "austere-chip" + (p.id === current.targetId ? " active" : "");
      b.textContent = p.id;
      b.title = p.component;
      b.addEventListener("click", () => {
        current.targetId = p.id;
        current.component = p.component;
        renderPath();
        popText.focus();
      });
      popPath.appendChild(b);
      if (i < current.path.length - 1) {
        const sep = document.createElement("span");
        sep.className = "austere-chip-sep";
        sep.textContent = "›";
        popPath.appendChild(sep);
      }
    });
  }

  function open({ target, el, selection, point }: OpenRequest) {
    const path = pathOf(target);
    const detail = detailOf(target, el);
    const part = partOf(target, el);
    let excerpt: string | undefined;
    if (!selection) {
      const node = part || el;
      // SVG elements have no innerText.
      excerpt = clip((node instanceof HTMLElement ? node.innerText : undefined) || node.textContent, 200) || undefined;
      if (part && excerpt === detail?.part) excerpt = undefined;
    }
    const statement = statementOf(target);
    draft = {
      targetId: statement.id,
      component: statement.component,
      path,
      selection: selection || undefined,
      excerpt,
      detail,
    };
    renderPath();
    const quote = selection || excerpt || detail?.part || "";
    popQuote.textContent = clip(quote, 220);
    popQuote.hidden = !quote;
    popText.value = "";
    hover.hidden = true;
    selBtn.hidden = true;
    showHover(target);
    hover.classList.add("locked");
    pop.hidden = false;
    positionPop(point);
    popText.focus();
  }

  function positionPop(point: Point) {
    if (window.innerWidth < 640) {
      pop.classList.add("sheet");
      pop.style.left = pop.style.top = "";
      return;
    }
    pop.classList.remove("sheet");
    const w = pop.offsetWidth || 360;
    const h = pop.offsetHeight || 200;
    let left = point.x + 12;
    let top = point.y + 12;
    if (left + w > window.innerWidth - 8) left = Math.max(8, point.x - w - 12);
    if (top + h > window.innerHeight - 8) top = Math.max(8, point.y - h - 12);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function close() {
    pop.hidden = true;
    hover.classList.remove("locked");
    hover.hidden = true;
    draft = null;
  }

  function queue() {
    const note = popText.value.trim();
    if (!draft) return;
    if (!note && !draft.selection) {
      popText.focus();
      popText.classList.add("shake");
      setTimeout(() => popText.classList.remove("shake"), 400);
      return;
    }
    const item: AnnotationItem = {
      kind: "annotation",
      target: draft.targetId,
      component: draft.component,
      path: draft.path.map((p) => p.id),
      note,
    };
    if (draft.selection) item.selection = draft.selection;
    if (draft.excerpt && !draft.selection) item.excerpt = draft.excerpt;
    if (draft.detail && draft.targetId === draft.path[draft.path.length - 1].id) item.detail = draft.detail;
    post({ type: "annotate", item });
    const id = draft.targetId;
    close();
    window.getSelection()?.removeAllRanges();
    flash([id], "queued");
  }

  pop.addEventListener("click", (e) => {
    const act = e.target instanceof Element ? e.target.closest("[data-act]")?.getAttribute("data-act") : undefined;
    if (act === "cancel") close();
    if (act === "queue") queue();
  });
  popText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      queue();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!popText.value.trim()) close();
    }
  });

  document.addEventListener("mousemove", onMove, { passive: true });
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("mouseup", scheduleSelection);
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key.startsWith("Arrow")) scheduleSelection();
  });
  document.addEventListener("selectionchange", () => {
    if ("ontouchstart" in window) scheduleSelection();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      post({ type: "toggle-mode" });
    }
  });
  window.addEventListener("scroll", () => {
    if (!pop.hidden) return;
    hover.hidden = true;
    selBtn.hidden = true;
  }, { passive: true });
  document.addEventListener("mouseleave", () => {
    if (pop.hidden) hover.hidden = true;
  });

  function elementsFor(id: string, map: StatementMap | undefined, refsTo: RefsTo | undefined, seen = new Set<string>()): Element[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const direct = document.querySelectorAll(`[data-oui-id="${CSS.escape(id)}"]`);
    if (direct.length) return Array.from(direct);
    if (!map || !refsTo) return [];
    return refsTo(map, id).flatMap((parent) => elementsFor(parent, map, refsTo, seen));
  }

  /** The outermost elements rendering any of ids (nested ones are covered by their ancestor). */
  function outermost(ids: string[], map: StatementMap | undefined, refsTo: RefsTo | undefined): Element[] {
    const els = new Set<Element>();
    for (const id of ids) for (const el of elementsFor(id, map, refsTo)) els.add(el);
    return Array.from(els).filter((el) => !Array.from(els).some((o) => o !== el && o.contains(el)));
  }

  function overlay(rect: Box, className: string): HTMLDivElement {
    const f = document.createElement("div");
    f.setAttribute(UI_ATTR, "");
    f.className = className;
    f.style.left = `${rect.left + window.scrollX - 4}px`;
    f.style.top = `${rect.top + window.scrollY - 4}px`;
    f.style.width = `${rect.width + 8}px`;
    f.style.height = `${rect.height + 8}px`;
    return f;
  }

  /**
   * The border boxes el renders. A statement wrapper is display: contents, and a range over
   * it would count text scrolled away inside its own scrollers (a long diff line), so its
   * rendered children are measured instead: their border boxes stop at what they show.
   */
  function renderedBox(el: Element): { left: number; top: number; right: number; bottom: number } {
    if (getComputedStyle(el).display !== "contents") return el.getBoundingClientRect();
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (r: DOMRect) => {
      if (!r.width && !r.height) return;
      [left, top, right, bottom] = [Math.min(left, r.left), Math.min(top, r.top), Math.max(right, r.right), Math.max(bottom, r.bottom)];
    };
    const walk = (node: Node) => {
      for (const c of node.childNodes) {
        if (c instanceof Element) {
          if (getComputedStyle(c).display === "contents") walk(c);
          else add(c.getBoundingClientRect());
        } else if (c.nodeType === Node.TEXT_NODE && c.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(c);
          add(range.getBoundingClientRect());
        }
      }
    };
    walk(el);
    return { left, top, right, bottom };
  }

  /** el's box cut to the ancestors that clip it (scrollers, overflow: hidden); null when nothing shows. */
  function visibleBox(el: Element): Box | null {
    let { left, top, right, bottom } = renderedBox(el);
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      const clipX = s.overflowX !== "visible";
      const clipY = s.overflowY !== "visible";
      // A display: contents box has no rect of its own and clips nothing.
      if ((!clipX && !clipY) || s.display === "contents") continue;
      const c = a.getBoundingClientRect();
      if (clipX) [left, right] = [Math.max(left, c.left), Math.min(right, c.right)];
      if (clipY) [top, bottom] = [Math.max(top, c.top), Math.min(bottom, c.bottom)];
    }
    return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
  }

  function flash(ids: string[], tone = "changed", map?: StatementMap, refsTo?: RefsTo): Element[] {
    const list = outermost(ids, map, refsTo);
    for (const el of list) {
      const box = visibleBox(el);
      if (!box) continue;
      const f = overlay(box, `austere-flash ${tone}`);
      document.body.appendChild(f);
      setTimeout(() => f.remove(), 2400);
    }
    return list;
  }

  function reveal(id: string, map?: StatementMap, refsTo?: RefsTo): boolean {
    const els = elementsFor(id, map, refsTo);
    if (!els.length) return false;
    const rect = boxOf(els[0]);
    const y = rect.top + window.scrollY - Math.max(24, (window.innerHeight - rect.height) / 3);
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    setTimeout(() => flash([id], "changed", map, refsTo), 350);
    return true;
  }

  // Persistent marks on the last turn's changes, while the reviewer keeps them on.
  // Overlays use page coordinates: they follow page scrolling, and anything that can
  // move a marked statement (layout, DOM changes, inner scrollers) redraws them.
  const marks = document.createElement("div");
  marks.setAttribute(UI_ATTR, "");
  root.appendChild(marks);
  let marked: string[] | null = null; // statement ids
  let marksRaf = 0;

  function drawMarks() {
    marksRaf = 0;
    const [map, refsTo]: [StatementMap?, RefsTo?] = marked && lookup ? lookup() : [];
    // Statements that render nothing, or sit scrolled out of their container, get no mark.
    const list: Element[] = [];
    const boxes: Box[] = [];
    for (const el of marked ? outermost(marked, map, refsTo) : []) {
      const box = visibleBox(el);
      if (!box) continue;
      list.push(el);
      boxes.push(box);
    }
    marks.replaceChildren(...boxes.map((box) => overlay(box, "austere-mark")));
    return list;
  }
  const scheduleMarks = () => {
    if (marked && !marksRaf) marksRaf = requestAnimationFrame(drawMarks);
  };
  window.addEventListener("resize", scheduleMarks, { passive: true });
  new ResizeObserver(scheduleMarks).observe(document.body);
  // Our own overlays mutate too; redrawing for them would loop every frame.
  new MutationObserver((records) => {
    if (records.some((r) => !isOurs(r.target.nodeType === 1 ? r.target : r.target.parentElement))) scheduleMarks();
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  document.addEventListener(
    "scroll",
    (e) => {
      if (e.target !== document) scheduleMarks();
    },
    { capture: true, passive: true },
  );

  /** Mark ids until called again; an empty list clears. With scroll, bring the first mark into view if none is. */
  function highlight(ids: string[], scroll = false): number {
    marked = ids.length ? ids : null;
    const list = drawMarks();
    if (scroll && list.length) {
      const boxes = list.map(boxOf);
      if (!boxes.some((r) => r.bottom > 0 && r.top < window.innerHeight)) {
        const r = boxes[0];
        const y = r.top + window.scrollY - Math.max(24, (window.innerHeight - r.height) / 3);
        window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
      }
    }
    return list.length;
  }

  return {
    setMode(next: unknown) {
      mode = next === "annotate" ? "annotate" : "explore";
      document.documentElement.classList.toggle("austere-annotating", mode === "annotate");
      if (mode !== "annotate") {
        close();
        selBtn.hidden = true;
        hover.hidden = true;
      }
    },
    flash,
    reveal,
    highlight,
  };
}
