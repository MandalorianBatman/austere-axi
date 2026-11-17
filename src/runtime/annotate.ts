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

/**
 * Messages the annotator posts to the chrome. For presence: `focus` is the statement this viewer
 * clicked, `writing` whether the note box has the keyboard.
 */
export type AnnotatorMessage =
  | { type: "annotate"; item: AnnotationItem }
  | { type: "focus"; id: string }
  | { type: "writing"; on: boolean }
  | { type: "toggle-mode" }
  | { type: "history"; id: string }
  // Ctrl/Cmd+K inside the frame, for the owner's quick switcher (only after init said the chrome has one).
  | { type: "quick-switch" };

/** Ids of the statements that reference `id` (shared/statements.ts referencesTo). */
export type RefsTo = (map: StatementMap, id: string) => string[];

export interface AnnotatorOptions {
  post: (msg: AnnotatorMessage) => void;
  lookup?: () => [StatementMap, RefsTo];
}

export interface Annotator {
  setMode(next: unknown): void;
  /** Whether Ctrl/Cmd+K in the frame goes to the chrome (the owner's quick switcher) instead of the browser. */
  setQuickSwitch(on: boolean): void;
  /** How many revisions changed each statement (the owner's history); a statement with earlier versions gets a History button in its popover. */
  setHistory(counts: Record<string, number>): void;
  flash(ids: string[], tone?: string, map?: StatementMap, refsTo?: RefsTo): Element[];
  reveal(id: string, map?: StatementMap, refsTo?: RefsTo): boolean;
  highlight(ids: string[], scroll?: boolean): number;
  focus(marks: FocusMark[]): void;
}

/** Another viewer's last click (presence): outlined in their colour, labelled with their name. */
export interface FocusMark {
  statement: string;
  name: string;
  /** `#rrggbb`. */
  colour: string;
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
  /**
   * The innermost statement clicked, the piece of it the box outlined (pieceOf), how to find that
   * piece again after a re-render, and its label as the note's detail names it.
   */
  target: Element;
  piece: Element | null;
  relocate: ((target: Element) => Element | null) | null;
  pieceLabel: string;
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

/**
 * The client box of an element. A shape inside an SVG is measured from its geometry (getBBox
 * through getScreenCTM): Firefox's getBoundingClientRect, and a Range over its contents, count a
 * nested <svg> (a diagram node's icon) far wider than it draws, so the box ran off the node.
 */
function clientRect(el: Element): DOMRect {
  if (el instanceof SVGGraphicsElement && el.ownerSVGElement) {
    const m = el.getScreenCTM();
    let b: DOMRect | null = null;
    try {
      b = el.getBBox();
    } catch {
      // Not rendered: Firefox throws where Chromium returns an empty box.
    }
    if (m && b) {
      const corners = [
        new DOMPoint(b.x, b.y),
        new DOMPoint(b.x + b.width, b.y),
        new DOMPoint(b.x, b.y + b.height),
        new DOMPoint(b.x + b.width, b.y + b.height),
      ].map((p) => p.matrixTransform(m));
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      const [left, top] = [Math.min(...xs), Math.min(...ys)];
      return new DOMRect(left, top, Math.max(...xs) - left, Math.max(...ys) - top);
    }
  }
  return el.getBoundingClientRect();
}

export function boxOf(node: Element): DOMRect {
  if (node instanceof SVGGraphicsElement && node.ownerSVGElement) return clientRect(node);
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

/** A table row's 1-based place in its tbody; undefined for header and footer rows. */
function rowIndexOf(row: Element): number | undefined {
  const body = row.parentElement;
  return body?.tagName === "TBODY" ? Array.prototype.indexOf.call(body.children, row) + 1 : undefined;
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
    const rowIndex = rowIndexOf(row);
    if (rowIndex) {
      const first = row.children[0];
      if (first && first !== cell) detail.row = clip(first.textContent, 60);
      detail.rowIndex = rowIndex;
    }
  }
  return Object.keys(detail).length ? detail : undefined;
}

/**
 * The innermost thing under the pointer inside its statement, which the hover box outlines
 * instead of the whole statement: a marked part (a diagram node or edge, a diff line), else a
 * table row. It is what detailOf describes, so the box shows what the note will point at.
 */
function pieceOf(target: Element, el: Element): Element | null {
  const part = partOf(target, el);
  if (part) return part;
  // A row only through one of its cells, as detailOf reads it: a row border or a selection across cells carries no row.
  const row = el.closest("td, th")?.parentElement;
  return row && target.contains(row) ? row : null;
}

/** The hover label's suffix naming the piece: the part, or the row number feedback carries. */
function pieceLabel(piece: Element | null): string {
  if (!piece) return "";
  const part = piece.getAttribute("data-austere-part");
  if (part !== null) return ` · ${clip(part, 40)}`;
  const rowIndex = rowIndexOf(piece);
  if (rowIndex) return ` · row ${rowIndex}`;
  return piece.parentElement?.tagName === "THEAD" ? " · header" : "";
}

/** Finds the same piece again inside a re-rendered statement, by its place among its kind (part values repeat). */
function relocatorOf(target: Element, piece: Element): (target: Element) => Element | null {
  const part = piece.getAttribute("data-austere-part");
  const sel = part !== null ? `[data-austere-part="${CSS.escape(part)}"]` : "tr";
  const at = Array.prototype.indexOf.call(target.querySelectorAll(sel), piece);
  return (t) => t.querySelectorAll(sel)[at] ?? null;
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
          <button type="button" data-act="history" hidden></button>
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
  const popHistory = root.querySelector('[data-act="history"]') as HTMLButtonElement;
  let historyCounts: Record<string, number> = {};
  let quickSwitch = false;
  /** History (n) for the statement the note is on: only where it has an earlier version to show. */
  function renderHistory() {
    const n = (draft && historyCounts[draft.targetId]) || 0;
    popHistory.hidden = n < 2;
    popHistory.textContent = `History (${n})`;
  }
  popText.addEventListener("focus", () => post({ type: "writing", on: true }));
  popText.addEventListener("blur", () => post({ type: "writing", on: false }));

  let draft: Draft | null = null;
  let pendingSelection: OpenRequest | null = null;
  let hoverRaf = 0;
  let lastHoverEl: EventTarget | null = null;

  const isOurs = (el: EventTarget | null) => el instanceof Element && !!el.closest(`[${UI_ATTR}]`);
  const targetOf = (el: EventTarget | null) => (el instanceof Element && el.closest("[data-oui-id]")) || null;

  function placeBox(box: HTMLElement, rect: Box, pad = 4) {
    box.style.left = `${rect.left - pad}px`;
    box.style.top = `${rect.top - pad}px`;
    box.style.width = `${rect.width + pad * 2}px`;
    box.style.height = `${rect.height + pad * 2}px`;
  }

  // What the hover box was last placed on: a statement, and the piece of it the box outlines
  // instead of the whole (pieceOf); layout changes re-measure it.
  let hovered: Element | null = null;
  let hoveredPiece: Element | null = null;
  let relocate: ((target: Element) => Element | null) | null = null;

  // A piece is cut to its scrollers (a long diff line, a wide diagram): the box stops at what shows,
  // and hides while the piece is scrolled out of sight rather than growing to the whole statement.
  function placeHoverOn(target: Element, piece: Element | null) {
    const box = piece ? visibleBox(piece) : boxOf(target);
    hover.style.visibility = box ? "" : "hidden";
    if (box) placeBox(hover, box);
  }

  function showHover(
    target: Element | null,
    piece: Element | null = null,
    locator: ((target: Element) => Element | null) | null = target && piece ? relocatorOf(target, piece) : null,
    label = pieceLabel(piece),
  ) {
    hovered = target;
    hoveredPiece = piece;
    relocate = locator;
    if (!target) {
      hover.hidden = true;
      return;
    }
    placeHoverOn(target, piece);
    hoverLabel.textContent = `${target.getAttribute("data-oui-id")} · ${target.getAttribute("data-oui-c")}${label}`;
    hover.hidden = false;
  }

  function onMove(e: MouseEvent) {
    if (mode !== "annotate" || !pop.hidden) return;
    lastHoverEl = e.target;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const el = lastHoverEl;
      if (!(el instanceof Element) || isOurs(el)) return;
      const target = targetOf(el);
      showHover(target, target && pieceOf(target, el));
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
        renderHistory();
        // The box follows the chosen statement; only the innermost one keeps the piece (and its detail),
        // labelled as when the note opened, since that is what the note sends.
        // A re-render may have replaced the statements: start from the live innermost one.
        const innermost = i === current.path.length - 1;
        if (!current.target.isConnected) {
          const id = current.path[current.path.length - 1].id;
          current.target = document.querySelector(`[data-oui-id="${CSS.escape(id)}"]`) ?? current.target;
        }
        const sel = `[data-oui-id="${CSS.escape(p.id)}"]`;
        showHover(
          current.target.closest(sel) ?? document.querySelector(sel),
          innermost ? current.piece : null,
          innermost ? current.relocate : null,
          innermost ? current.pieceLabel : "",
        );
        placeHover();
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
    const piece = pieceOf(target, el);
    let excerpt: string | undefined;
    if (!selection) {
      const node = part || el;
      // SVG elements have no innerText.
      excerpt = clip((node instanceof HTMLElement ? node.innerText : undefined) || node.textContent, 200) || undefined;
      if (part && excerpt === detail?.part) excerpt = undefined;
    }
    const statement = statementOf(target);
    post({ type: "focus", id: statement.id });
    draft = {
      target,
      piece,
      relocate: piece && relocatorOf(target, piece),
      pieceLabel: pieceLabel(piece),
      targetId: statement.id,
      component: statement.component,
      path,
      selection: selection || undefined,
      excerpt,
      detail,
    };
    renderPath();
    renderHistory();
    const quote = selection || excerpt || detail?.part || "";
    popQuote.textContent = clip(quote, 220);
    popQuote.hidden = !quote;
    popText.value = "";
    hover.hidden = true;
    selBtn.hidden = true;
    showHover(target, piece, draft.relocate, draft.pieceLabel);
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
    // A hidden textarea may keep focus; blur it so "writing" ends with the note box.
    if (document.activeElement === popText) popText.blur();
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
    // A note on a piece (a row, a node) flashes that piece, as the box outlined it.
    const piece = item.detail ? hoveredPiece : null;
    close();
    window.getSelection()?.removeAllRanges();
    if (piece?.isConnected) flashElement(piece, "queued");
    else flash([id], "queued");
  }

  pop.addEventListener("click", (e) => {
    const act = e.target instanceof Element ? e.target.closest("[data-act]")?.getAttribute("data-act") : undefined;
    if (act === "cancel") close();
    if (act === "queue") queue();
    if (act === "history" && draft) {
      // The note box stays open: the owner may read the history and still queue what they typed.
      post({ type: "history", id: draft.targetId });
    }
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
    } else if (quickSwitch && (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      post({ type: "quick-switch" });
    }
  });
  window.addEventListener("scroll", () => {
    // The box is position: fixed, so a locked one has to follow the page.
    if (!pop.hidden) return scheduleLayout();
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
    if (getComputedStyle(el).display !== "contents") return clientRect(el);
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (r: DOMRect) => {
      if (!r.width && !r.height) return;
      [left, top, right, bottom] = [Math.min(left, r.left), Math.min(top, r.top), Math.max(right, r.right), Math.max(bottom, r.bottom)];
    };
    const walk = (node: Node) => {
      for (const c of node.childNodes) {
        if (c instanceof Element) {
          if (getComputedStyle(c).display === "contents") walk(c);
          else add(clientRect(c));
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

  /** el, or the card that holds it when it sits in a folded card (hidden="until-found"). */
  function shown(el: Element): Element {
    for (let fold = el.closest("[hidden='until-found']"); fold?.parentElement; fold = el.closest("[hidden='until-found']")) {
      el = fold.parentElement;
    }
    return el;
  }

  /** el's box cut to the ancestors that clip it (scrollers, overflow: hidden); null when nothing shows. */
  function visibleBox(target: Element): Box | null {
    const el = shown(target);
    let { left, top, right, bottom } = renderedBox(el);
    // A straight diagram edge is a line, flat on one side; a side clipping took to zero shows nothing.
    const flatX = right === left;
    const flatY = bottom === top;
    if (flatX && flatY) return null;
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
    const showsX = flatX ? right >= left : right > left;
    const showsY = flatY ? bottom >= top : bottom > top;
    return showsX && showsY ? { left, top, width: right - left, height: bottom - top } : null;
  }

  function flashElement(el: Element, tone: string) {
    const box = visibleBox(el);
    if (!box) return;
    const f = overlay(box, `austere-flash ${tone}`);
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 2400);
  }

  function flash(ids: string[], tone = "changed", map?: StatementMap, refsTo?: RefsTo): Element[] {
    const list = outermost(ids, map, refsTo);
    for (const el of list) flashElement(el, tone);
    return list;
  }

  function reveal(id: string, map?: StatementMap, refsTo?: RefsTo): boolean {
    const els = elementsFor(id, map, refsTo);
    if (!els.length) return false;
    // Unfold what hides it, as find-in-page does: drop hidden, then fire beforematch.
    for (let fold = els[0].closest("[hidden='until-found']"); fold; fold = els[0].closest("[hidden='until-found']")) {
      fold.removeAttribute("hidden");
      fold.dispatchEvent(new Event("beforematch"));
    }
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
  let layoutRaf = 0;

  // Other viewers' focus: one outline per statement, in the first viewer's colour, with a
  // name tag per viewer. Redrawn with the marks, so it follows the statement.
  const focusLayer = document.createElement("div");
  focusLayer.setAttribute(UI_ATTR, "");
  root.appendChild(focusLayer);
  let focused: FocusMark[] = [];

  function drawMarks() {
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

  /**
   * A shown hover box (locked under an open note, or under a resting pointer) stays on its
   * statement or piece when the page moves it: a live update re-lays out a diagram, a scroller
   * scrolls. A re-render may replace the elements, so a detached statement is found again by
   * its id and a detached piece by its place in it.
   */
  function placeHover() {
    if (hover.hidden || !hovered) return;
    if (!hovered.isConnected) {
      const id = hovered.getAttribute("data-oui-id") as string;
      hovered = document.querySelector(`[data-oui-id="${CSS.escape(id)}"]`);
    }
    // A piece missing for a frame stays detached (no box) and is looked for again on the next update.
    if (hovered && hoveredPiece && !hoveredPiece.isConnected) hoveredPiece = relocate?.(hovered) ?? hoveredPiece;
    if (hovered) placeHoverOn(hovered, hoveredPiece);
    else hover.hidden = true;
  }

  function scheduleLayout() {
    if (layoutRaf || (!marked && hover.hidden && !focused.length)) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      if (marked) drawMarks();
      if (focused.length) drawFocus();
      placeHover();
    });
  }
  window.addEventListener("resize", scheduleLayout, { passive: true });
  new ResizeObserver(scheduleLayout).observe(document.body);
  // Our own overlays mutate too; redrawing for them would loop every frame.
  // SVG geometry attributes count: a live update can move a diagram box without other changes.
  new MutationObserver((records) => {
    if (records.some((r) => !isOurs(r.target.nodeType === 1 ? r.target : r.target.parentElement))) scheduleLayout();
  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "open", "x", "y", "width", "height", "d", "transform", "viewBox"],
  });
  document.addEventListener(
    "scroll",
    (e) => {
      if (e.target !== document) scheduleLayout();
    },
    { capture: true, passive: true },
  );

  /** Mark ids until called again; an empty list clears. With scroll, bring the first mark into view if none is. */
  function highlight(ids: string[], scroll = false): number {
    marked = ids.length ? ids : null;
    const list = drawMarks();
    if (scroll && list.length) {
      const boxes = list.map((el) => boxOf(shown(el)));
      if (!boxes.some((r) => r.bottom > 0 && r.top < window.innerHeight)) {
        const r = boxes[0];
        const y = r.top + window.scrollY - Math.max(24, (window.innerHeight - r.height) / 3);
        window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
      }
    }
    return list.length;
  }

  function drawFocus() {
    const [map, refsTo]: [StatementMap?, RefsTo?] = focused.length && lookup ? lookup() : [];
    const byStatement = new Map<string, FocusMark[]>();
    for (const m of focused) byStatement.set(m.statement, [...(byStatement.get(m.statement) ?? []), m]);
    const outlines: HTMLDivElement[] = [];
    for (const [statement, viewers] of byStatement) {
      // Every visible element of the statement is outlined (an edge's line and label, a reused
      // component); the first one carries the name tags.
      let tagged = false;
      for (const el of outermost([statement], map, refsTo)) {
        const box = visibleBox(el);
        if (!box) continue;
        const o = overlay(box, "austere-focus");
        o.style.setProperty("--austere-viewer", viewers[0].colour);
        if (!tagged) {
          tagged = true;
          const tags = document.createElement("div");
          tags.className = "austere-focus-names";
          for (const v of viewers) {
            const tag = document.createElement("span");
            tag.textContent = v.name;
            tag.style.background = v.colour;
            tags.appendChild(tag);
          }
          o.appendChild(tags);
        }
        outlines.push(o);
      }
    }
    focusLayer.replaceChildren(...outlines);
  }

  /** Shows these viewers' focus until called again; an empty list clears. */
  function focus(marks: FocusMark[]) {
    focused = marks;
    drawFocus();
  }

  return {
    setQuickSwitch(on: boolean) {
      quickSwitch = on;
    },
    setHistory(counts: Record<string, number>) {
      historyCounts = counts;
      if (draft) renderHistory();
    },
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
    focus,
  };
}
