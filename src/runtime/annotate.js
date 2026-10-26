// Annotation layer that runs inside the artifact frame during review.
// Every rendered statement is wrapped in [data-oui-id]; pointing at anything
// resolves to the innermost named statement, so feedback lands on a line the
// agent can edit directly.

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

function clip(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function boxOf(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  const rect = r.getBoundingClientRect();
  if (rect.width || rect.height) return rect;
  return node.getBoundingClientRect();
}

function pathOf(target) {
  const path = [];
  for (let n = target; n; n = n.parentElement?.closest("[data-oui-id]")) {
    path.unshift({ id: n.getAttribute("data-oui-id"), component: n.getAttribute("data-oui-c") });
  }
  return path;
}

/**
 * Extra precision inside a statement. Components mark sub-targets with
 * data-austere-part="<what the agent should hear>" (a diff line, a diagram
 * node, a file path); the nearest one wins and its text becomes the quote.
 * Plain tables get row/column names without any marking.
 */
function partOf(target, el) {
  const part = el.closest("[data-austere-part]");
  return part && target.contains(part) ? part : null;
}

function detailOf(target, el) {
  const detail = {};
  const part = partOf(target, el);
  if (part) {
    detail.part = part.getAttribute("data-austere-part");
    return detail;
  }
  const cell = el.closest("td, th");
  if (cell && target.contains(cell)) {
    const row = cell.parentElement;
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

export function createAnnotator({ post }) {
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

  const hover = root.querySelector(".austere-hover");
  const hoverLabel = root.querySelector(".austere-hover-label");
  const selBtn = root.querySelector(".austere-selbtn");
  const pop = root.querySelector(".austere-pop");
  const popPath = root.querySelector(".austere-pop-path");
  const popQuote = root.querySelector(".austere-pop-quote");
  const popText = root.querySelector("textarea");

  let draft = null; // { target, el, selection, path, excerpt, detail }
  let pendingSelection = null;
  let hoverRaf = 0;
  let lastHoverEl = null;

  const isOurs = (el) => !!el?.closest?.(`[${UI_ATTR}]`);
  const targetOf = (el) => el?.closest?.("[data-oui-id]") || null;

  function placeBox(box, rect, pad = 4) {
    box.style.left = `${rect.left - pad}px`;
    box.style.top = `${rect.top - pad}px`;
    box.style.width = `${rect.width + pad * 2}px`;
    box.style.height = `${rect.height + pad * 2}px`;
  }

  function showHover(target) {
    if (!target) {
      hover.hidden = true;
      return;
    }
    placeBox(hover, boxOf(target));
    hoverLabel.textContent = `${target.getAttribute("data-oui-id")} · ${target.getAttribute("data-oui-c")}`;
    hover.hidden = false;
  }

  function onMove(e) {
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

  function onClickCapture(e) {
    if (mode !== "annotate" || isOurs(e.target)) return;
    if (!pop.hidden) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (hasTextSelection()) return;
    if (!e.altKey && e.target.closest(INTERACTIVE)) return;
    const target = targetOf(e.target);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    open({ target, el: e.target, point: { x: e.clientX, y: e.clientY } });
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
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    const target = targetOf(el);
    if (!text || !target || isOurs(el)) {
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
    selTimer = setTimeout(onSelectionSettled, 120);
  }

  selBtn.addEventListener("mousedown", (e) => e.preventDefault());
  selBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pendingSelection) open(pendingSelection);
    selBtn.hidden = true;
  });

  function renderPath() {
    popPath.textContent = "";
    draft.path.forEach((p, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "austere-chip" + (p.id === draft.targetId ? " active" : "");
      b.textContent = p.id;
      b.title = p.component;
      b.addEventListener("click", () => {
        draft.targetId = p.id;
        draft.component = p.component;
        renderPath();
        popText.focus();
      });
      popPath.appendChild(b);
      if (i < draft.path.length - 1) {
        const sep = document.createElement("span");
        sep.className = "austere-chip-sep";
        sep.textContent = "›";
        popPath.appendChild(sep);
      }
    });
  }

  function open({ target, el, selection, point }) {
    const path = pathOf(target);
    const detail = detailOf(target, el);
    const part = partOf(target, el);
    let excerpt;
    if (!selection) {
      excerpt = clip((part || el).innerText || (part || el).textContent, 200) || undefined;
      if (part && excerpt === detail?.part) excerpt = undefined;
    }
    draft = {
      targetId: target.getAttribute("data-oui-id"),
      component: target.getAttribute("data-oui-c"),
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

  function positionPop(point) {
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
    const item = {
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
    const act = e.target.closest("[data-act]")?.getAttribute("data-act");
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

  function elementsFor(id, map, refsTo, seen = new Set()) {
    if (seen.has(id)) return [];
    seen.add(id);
    const direct = document.querySelectorAll(`[data-oui-id="${CSS.escape(id)}"]`);
    if (direct.length) return Array.from(direct);
    if (!map || !refsTo) return [];
    return refsTo(map, id).flatMap((parent) => elementsFor(parent, map, refsTo, seen));
  }

  function flash(ids, tone = "changed", map, refsTo) {
    const els = new Set();
    for (const id of ids) for (const el of elementsFor(id, map, refsTo)) els.add(el);
    // Drop elements nested in another flashed element.
    const list = Array.from(els).filter((el) => !Array.from(els).some((o) => o !== el && o.contains(el)));
    for (const el of list) {
      const rect = boxOf(el);
      const f = document.createElement("div");
      f.setAttribute(UI_ATTR, "");
      f.className = `austere-flash ${tone}`;
      f.style.left = `${rect.left + window.scrollX - 4}px`;
      f.style.top = `${rect.top + window.scrollY - 4}px`;
      f.style.width = `${rect.width + 8}px`;
      f.style.height = `${rect.height + 8}px`;
      document.body.appendChild(f);
      setTimeout(() => f.remove(), 2400);
    }
    return list;
  }

  function reveal(id, map, refsTo) {
    const els = elementsFor(id, map, refsTo);
    if (!els.length) return false;
    const rect = boxOf(els[0]);
    const y = rect.top + window.scrollY - Math.max(24, (window.innerHeight - rect.height) / 3);
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    setTimeout(() => flash([id], "changed", map, refsTo), 350);
    return true;
  }

  return {
    setMode(next) {
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
  };
}
