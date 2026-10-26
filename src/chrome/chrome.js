// Review chrome: artifact frame + conversation panel. Plain DOM, no framework.

const BOOT = window.__AUSTERE__;
const SID = BOOT.id;
const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or blocked; state stays in memory
    }
  },
};
const SS = {
  get(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  },
};

const state = {
  mode: LS.get("austere:mode", "annotate"),
  queue: LS.get(`austere:queue:${SID}`, []),
  transcript: [],
  presence: "idle",
  status: "open",
  endedBy: null,
  program: null,
  frameReady: false,
  scrollY: 0,
  parserErrors: [],
  runtimeErrors: [],
  changes: [],
  changeIdx: 0,
  sheetOpen: SS.get(`austere:sheet:${SID}`) === true,
  sending: false,
  connected: false,
  editing: null,
  links: null,
};

// ── markup ──

const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

document.body.innerHTML = `
<div class="app">
  <header class="bar">
    <div class="bar-title"><span class="title"></span><span class="file"></span></div>
    <div class="bar-mid">
      <div class="seg" role="group" aria-label="Mode">
        <button type="button" data-mode="annotate" title="Click anything to comment on it (⌘/Ctrl+I)">Annotate</button>
        <button type="button" data-mode="explore" title="Use the page normally (⌘/Ctrl+I)">Explore</button>
      </div>
      <button type="button" class="changes" hidden></button>
    </div>
    <div class="bar-right">
      <span class="presence"></span>
      <div class="menu">
        <button type="button" class="icon-btn menu-btn" aria-label="More">⋯</button>
        <div class="menu-pop" hidden>
          <button type="button" data-cmd="copy-path">Copy file path</button>
          <button type="button" data-cmd="copy-link">Copy review link</button>
          <button type="button" data-cmd="reload">Reload artifact</button>
          <a data-cmd="export" href="/s/${SID}/export">Download standalone HTML</a>
          <button type="button" data-cmd="end" class="danger">End review</button>
        </div>
      </div>
    </div>
  </header>
  <div class="banner" hidden></div>
  <div class="main">
    <section class="stage">
      <iframe class="frame" title="Artifact" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"></iframe>
    </section>
    <div class="scrim"></div>
    <aside class="panel" aria-label="Conversation">
      <div class="panel-head">
        <span>Conversation</span>
        <button type="button" class="icon-btn sheet-close" aria-label="Close">⌄</button>
      </div>
      <div class="log"></div>
      <form class="composer">
        <textarea rows="2" placeholder="Message the agent…"></textarea>
        <div class="composer-row">
          <span class="composer-hint">Enter sends · Shift+Enter newline</span>
          <span class="composer-actions">
            <button type="button" class="btn ghost send-end">Send &amp; End</button>
            <button type="submit" class="btn primary send">Send</button>
          </span>
        </div>
        <div class="composer-error" hidden></div>
      </form>
    </aside>
  </div>
  <button type="button" class="dock"></button>
</div>`;

const frame = $(".frame");
const log = $(".log");
const textarea = $(".composer textarea");
const banner = $(".banner");

$(".title").textContent = BOOT.title;
$(".file").textContent = BOOT.name;
$(".file").title = BOOT.file;
document.title = `${BOOT.title} · austere`;

// ── tiny markdown for agent replies ──

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function markdown(src) {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${buf.map((b) => `<li>${inline(b)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      out.push(`<p><strong>${inline(line.replace(/^#+\s+/, ""))}</strong></p>`);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^```|^\s*([-*]|\d+\.)\s+|^#{1,6}\s/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

// ── frame bridge ──

function post(msg) {
  frame.contentWindow?.postMessage({ austere: 1, ...msg }, "*");
}

function loadFrame() {
  state.frameReady = false;
  frame.src = `${BOOT.artifactUrl}?r=${Date.now()}`;
}

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data;
  if (!d || d.austere !== 1) return;
  switch (d.type) {
    case "hello":
      post({
        type: "init",
        mode: state.status === "ended" ? "explore" : state.mode,
        state: SS.get(`austere:form:${SID}`),
        scrollY: state.scrollY,
      });
      break;
    case "ready":
      state.frameReady = true;
      if (d.title) {
        $(".title").textContent = d.title;
        document.title = `${d.title} · austere`;
      }
      break;
    case "annotate":
      addToQueue(d.item);
      break;
    case "action":
      addToQueue(d.item);
      pulseDock();
      break;
    case "errors":
      state.parserErrors = (d.errors || []).filter((x) => x.severity !== "warning");
      renderLog();
      break;
    case "runtime-error":
      if (d.error && !state.runtimeErrors.some((x) => x.statementId === d.error.statementId && x.message === d.error.message)) {
        state.runtimeErrors.push(d.error);
        renderLog();
      }
      break;
    case "state":
      SS.set(`austere:form:${SID}`, d.state);
      break;
    case "scroll":
      state.scrollY = d.y || 0;
      break;
    case "changes":
      state.changes = (d.ids || []).slice(0, 50);
      state.changeIdx = 0;
      renderChanges();
      break;
    case "toggle-mode":
      setMode(state.mode === "annotate" ? "explore" : "annotate");
      break;
  }
});

// ── queue ──

function saveQueue() {
  LS.set(`austere:queue:${SID}`, state.queue);
}

function addToQueue(item) {
  if (state.status === "ended") return;
  item.qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  state.queue.push(item);
  saveQueue();
  renderLog(true);
  renderDock();
}

function removeFromQueue(qid) {
  state.queue = state.queue.filter((q) => q.qid !== qid);
  saveQueue();
  renderLog();
  renderDock();
}

function anchorLabel(item) {
  if (item.kind === "annotation") return { icon: "✎", text: item.target, sub: item.component };
  if (item.kind === "action") return { icon: "↗", text: item.message, sub: "button" };
  if (item.kind === "render-error") return { icon: "!", text: item.statement || "page", sub: "render issue" };
  return { icon: "", text: "", sub: "" };
}

function flatForm(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) parts.push(...flatForm(v, ""));
    else parts.push(`${prefix}${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  return parts;
}

function itemQuote(item) {
  if (item.selection) return item.selection;
  if (item.detail?.part) return item.excerpt ? `${item.detail.part}  ${item.excerpt}` : item.detail.part;
  if (item.detail?.column) {
    const where = [item.detail.row && `row ${item.detail.row}`, `column ${item.detail.column}`].filter(Boolean).join(", ");
    return item.excerpt ? `${item.excerpt}  (${where})` : where;
  }
  if (item.kind === "action" && item.form) return flatForm(item.form).join(" · ");
  if (item.kind === "render-error") return item.message;
  return item.excerpt || "";
}

function itemBody(item, { queued } = {}) {
  const a = anchorLabel(item);
  const wrap = h("div", { class: `item kind-${item.kind}` });
  if (a.text) {
    const anchor = h(
      "button",
      {
        type: "button",
        class: "anchor",
        title: item.kind === "annotation" ? "Show in the page" : "",
        onclick: () => {
          if (item.kind === "annotation" || item.kind === "render-error") {
            post({ type: "reveal", id: item.target || item.statement });
            if (isNarrow()) setSheet(false);
          }
        },
      },
      h("span", { class: "anchor-icon", text: a.icon }),
      h("span", { class: "anchor-text", text: a.text }),
      a.sub ? h("span", { class: "anchor-sub", text: a.sub }) : null,
    );
    wrap.append(anchor);
  }
  const quote = itemQuote(item);
  if (quote) wrap.append(h("blockquote", { text: quote.length > 260 ? quote.slice(0, 259) + "…" : quote }));
  const noteText = item.kind === "message" ? item.text : item.note;
  if (queued && state.editing === item.qid) {
    const ta = h("textarea", { class: "edit", rows: "2" });
    ta.value = noteText || "";
    const save = () => {
      const v = ta.value.trim();
      if (item.kind === "message") {
        if (!v) return removeFromQueue(item.qid);
        item.text = v;
      } else item.note = v;
      state.editing = null;
      saveQueue();
      renderLog();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        state.editing = null;
        renderLog();
      }
    });
    ta.addEventListener("blur", save);
    wrap.append(ta);
    setTimeout(() => ta.focus(), 0);
  } else if (noteText) {
    wrap.append(h("div", { class: "note", text: noteText }));
  }
  return wrap;
}

function fmtTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function receipt(entry) {
  const steps = [
    ["Seen", entry.seenAt],
    ["Working", entry.workAt],
    ["Done", entry.doneAt],
  ];
  const row = h("div", { class: "receipt" });
  for (const [label, at] of steps) {
    row.append(h("span", { class: at ? "on" : "", title: at ? `${label} ${fmtTime(at)}` : `Not ${label.toLowerCase()} yet`, text: label }));
  }
  if (!entry.seenAt) {
    row.append(
      h("em", {
        text: state.presence === "listening" ? "" : state.presence === "working" ? "agent is busy; delivered on its next poll" : "no agent listening; delivered when one polls",
      }),
    );
  }
  return row;
}

let lastLogCount = 0;
function renderLog(scrollToEnd = false) {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = "";
  const issues = [...state.parserErrors, ...state.runtimeErrors];
  if (issues.length) {
    const box = h("div", { class: "issues" }, h("div", { class: "issues-head", text: `Render issues (${issues.length})` }));
    for (const err of issues.slice(0, 8)) {
      box.append(
        h(
          "div",
          { class: "issue" },
          h("div", { class: "issue-text" }, err.statementId ? h("code", { text: err.statementId }) : null, " ", err.message),
          state.status === "ended"
            ? null
            : h("button", {
                type: "button",
                class: "btn tiny",
                text: "Queue fix",
                onclick: () =>
                  addToQueue({ kind: "render-error", statement: err.statementId, target: err.statementId, message: err.message, note: "Fix this render error." }),
              }),
        ),
      );
    }
    log.append(box);
  }
  if (!state.transcript.length && !state.queue.length) {
    log.append(
      h(
        "div",
        { class: "empty" },
        h("p", { html: "<strong>Point at anything to comment on it.</strong>" }),
        h("p", {
          text: "In Annotate mode, click a section, table cell, diagram node or diff line, or select text. Notes queue here; Send delivers them to the agent.",
        }),
      ),
    );
  }
  for (const entry of state.transcript) {
    if (entry.role === "agent") {
      log.append(
        h(
          "div",
          { class: "msg agent" },
          h("div", { class: "who", text: `Agent · ${fmtTime(entry.at)}` }),
          h("div", { class: "md", html: markdown(entry.text) }),
        ),
      );
    } else {
      const bubble = h("div", { class: "msg user" }, h("div", { class: "who", text: `You · ${fmtTime(entry.at)}${entry.end ? " · ended review" : ""}` }));
      for (const it of entry.items || []) bubble.append(itemBody(it));
      bubble.append(receipt(entry));
      log.append(bubble);
    }
  }
  if (state.queue.length) {
    const q = h("div", { class: "queued" }, h("div", { class: "queued-head", text: `Queued · ${state.queue.length}` }));
    for (const item of state.queue) {
      const el = itemBody(item, { queued: true });
      el.classList.add("q");
      el.append(
        h(
          "div",
          { class: "q-actions" },
          h("button", {
            type: "button",
            class: "btn tiny ghost",
            text: "Edit",
            onclick: () => {
              state.editing = item.qid;
              renderLog();
            },
          }),
          h("button", { type: "button", class: "btn tiny ghost", text: "Remove", onclick: () => removeFromQueue(item.qid) }),
        ),
      );
      q.append(el);
    }
    log.append(q);
  }
  if (state.status === "ended") {
    log.append(
      h("div", { class: "ended-note", text: state.endedBy === "agent" ? "The agent ended this review." : "You ended this review." }),
    );
  }
  const count = state.transcript.length + state.queue.length;
  if (scrollToEnd || atBottom || count !== lastLogCount) log.scrollTop = log.scrollHeight;
  lastLogCount = count;
  renderComposer();
}

// ── composer / sending ──

function renderComposer() {
  const ended = state.status === "ended";
  const n = state.queue.length;
  textarea.disabled = ended || state.sending;
  $(".send").disabled = ended || state.sending;
  $(".send-end").disabled = ended || state.sending;
  $(".send").textContent = state.sending ? "Sending…" : n ? `Send ${n}` : "Send";
  textarea.placeholder = ended ? "Review ended" : n ? "Add a message (optional)…" : "Message the agent…";
}

function composerError(text) {
  const el = $(".composer-error");
  el.textContent = text || "";
  el.hidden = !text;
}

async function sendAll(end = false) {
  if (state.sending || state.status === "ended") return;
  const text = textarea.value.trim();
  const items = state.queue.map(({ qid, ...rest }) => rest);
  if (text) items.push({ kind: "message", text });
  if (!items.length && !end) {
    textarea.focus();
    return;
  }
  if (end && !items.length && !confirm("End this review? The agent will stop listening.")) return;
  state.sending = true;
  composerError("");
  renderComposer();
  try {
    const r = await fetch(`/s/${SID}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items, end }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    state.queue = [];
    saveQueue();
    textarea.value = "";
    if (data.entry && !state.transcript.some((e) => e.id === data.entry.id)) state.transcript.push(data.entry);
  } catch (err) {
    composerError(`Not sent: ${err.message}. Your notes are still queued.`);
  } finally {
    state.sending = false;
    renderLog(true);
    renderDock();
  }
}

$(".composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendAll(false);
});
$(".send-end").addEventListener("click", () => sendAll(true));
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendAll(false);
  }
});

// ── mode, presence, changes ──

function setMode(mode) {
  state.mode = mode === "explore" ? "explore" : "annotate";
  LS.set("austere:mode", state.mode);
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.mode === state.mode);
  post({ type: "mode", mode: state.status === "ended" ? "explore" : state.mode });
}
for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => setMode(b.dataset.mode));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
    e.preventDefault();
    setMode(state.mode === "annotate" ? "explore" : "annotate");
  }
});

function renderPresence() {
  const el = $(".presence");
  let label;
  let cls;
  if (state.status === "ended") [label, cls] = ["Review ended", "ended"];
  else if (!state.connected) [label, cls] = ["Reconnecting…", "off"];
  else if (state.presence === "listening") [label, cls] = ["Agent listening", "listening"];
  else if (state.presence === "working") [label, cls] = ["Agent working", "working"];
  else [label, cls] = ["Agent not listening", "idle"];
  el.className = `presence ${cls}`;
  el.textContent = label;
  el.title =
    cls === "idle" ? "Your notes are kept and delivered the next time the agent polls." : cls === "working" ? "The agent has your last batch." : "";
  document.documentElement.classList.toggle("is-ended", state.status === "ended");
  renderDock();
}

function renderChanges() {
  const btn = $(".changes");
  if (!state.changes.length) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = `${state.changes.length} changed`;
  btn.title = `Show next change: ${state.changes.join(", ")}`;
}
$(".changes").addEventListener("click", () => {
  if (!state.changes.length) return;
  const id = state.changes[state.changeIdx % state.changes.length];
  state.changeIdx++;
  post({ type: "reveal", id });
});

// ── menu ──

const menuPop = $(".menu-pop");
$(".menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuPop.hidden = !menuPop.hidden;
});
document.addEventListener("click", () => (menuPop.hidden = true));
menuPop.addEventListener("click", async (e) => {
  const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
  if (!cmd) return;
  if (cmd === "copy-path") navigator.clipboard?.writeText(BOOT.file);
  if (cmd === "copy-link") navigator.clipboard?.writeText(state.links?.remote || location.href);
  if (cmd === "reload") loadFrame();
  if (cmd === "end") {
    if (state.queue.length) return sendAll(true);
    if (!confirm("End this review? The agent will stop listening.")) return;
    await fetch(`/s/${SID}/end`, { method: "POST" }).catch(() => {});
  }
});

// ── mobile sheet ──

const isNarrow = () => window.matchMedia("(max-width: 860px)").matches;
function setSheet(open) {
  state.sheetOpen = open;
  SS.set(`austere:sheet:${SID}`, open);
  document.documentElement.classList.toggle("sheet-open", open);
  if (open) setTimeout(() => (log.scrollTop = log.scrollHeight), 50);
}
function renderDock() {
  const dock = $(".dock");
  const n = state.queue.length;
  const parts = ["Conversation"];
  if (n) parts.push(`${n} queued`);
  const last = state.transcript[state.transcript.length - 1];
  if (last?.role === "agent" && last.at > (SS.get(`austere:seen:${SID}`) || 0)) parts.push("new reply");
  dock.innerHTML = `<span class="dock-grip"></span><span>${esc(parts.join(" · "))}</span><span class="dock-presence ${esc($(".presence").className.replace("presence", "").trim())}"></span>`;
}
function pulseDock() {
  const dock = $(".dock");
  dock.classList.remove("pulse");
  void dock.offsetWidth;
  dock.classList.add("pulse");
}
$(".dock").addEventListener("click", () => {
  SS.set(`austere:seen:${SID}`, Date.now());
  setSheet(true);
  renderDock();
});
$(".sheet-close").addEventListener("click", () => setSheet(false));
$(".scrim").addEventListener("click", () => setSheet(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.sheetOpen && isNarrow()) setSheet(false);
});
let touchY = null;
$(".panel-head").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
$(".panel-head").addEventListener(
  "touchend",
  (e) => {
    if (touchY != null && e.changedTouches[0].clientY - touchY > 60) setSheet(false);
    touchY = null;
  },
  { passive: true },
);
$(".dock").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
$(".dock").addEventListener(
  "touchend",
  (e) => {
    if (touchY != null && touchY - e.changedTouches[0].clientY > 40) setSheet(true);
    touchY = null;
  },
  { passive: true },
);

// ── server events ──

function showBanner(text, actions = []) {
  banner.textContent = "";
  if (!text) {
    banner.hidden = true;
    return;
  }
  banner.append(h("span", { text }), ...actions);
  banner.hidden = false;
}

function mergeEntries(entries) {
  for (const e of entries) {
    const i = state.transcript.findIndex((x) => x.id === e.id);
    if (i >= 0) state.transcript[i] = e;
    else state.transcript.push(e);
  }
  state.transcript.sort((a, b) => a.at - b.at);
}

let es = null;
let disconnectedAt = 0;
function connect() {
  es = new EventSource(`/s/${SID}/events`);
  es.addEventListener("open", () => {
    state.connected = true;
    disconnectedAt = 0;
    showBanner("");
    renderPresence();
  });
  es.addEventListener("error", () => {
    state.connected = false;
    if (!disconnectedAt) disconnectedAt = Date.now();
    renderPresence();
    setTimeout(() => {
      if (!state.connected && Date.now() - disconnectedAt > 3500) {
        showBanner("Lost the austere-axi server. Run any austere-axi command to restart it; this page reconnects on its own.", [
          h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() }),
        ]);
      }
    }, 4000);
  });
  es.addEventListener("snapshot", (e) => {
    const d = JSON.parse(e.data);
    state.transcript = d.transcript || [];
    state.presence = d.presence;
    state.status = d.session.status;
    state.endedBy = d.session.endedBy;
    state.links = d.links;
    if (d.version && d.version !== BOOT.version) {
      showBanner("austere-axi was updated. This page is running the previous version.", [
        h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() }),
      ]);
    }
    if (state.program === null) state.program = d.program;
    else if (d.program !== state.program) {
      state.program = d.program;
      if (state.frameReady) post({ type: "source", program: d.program });
    }
    renderPresence();
    renderLog();
    setMode(state.mode);
  });
  es.addEventListener("transcript", (e) => {
    mergeEntries(JSON.parse(e.data).entries || []);
    renderLog();
    renderDock();
  });
  es.addEventListener("presence", (e) => {
    const d = JSON.parse(e.data);
    state.presence = d.presence;
    state.status = d.status;
    state.endedBy = d.endedBy;
    renderPresence();
    renderLog();
  });
  es.addEventListener("changed", (e) => {
    const d = JSON.parse(e.data);
    state.parserErrors = [];
    state.runtimeErrors = [];
    if (d.shellChanged || !state.frameReady) {
      state.program = d.program;
      loadFrame();
    } else {
      state.program = d.program;
      post({ type: "source", program: d.program });
    }
    renderLog();
  });
  es.addEventListener("ended", (e) => {
    const d = JSON.parse(e.data);
    state.status = "ended";
    state.endedBy = d.by;
    post({ type: "mode", mode: "explore" });
    renderPresence();
    renderLog();
  });
  es.addEventListener("server", (e) => {
    const d = JSON.parse(e.data);
    if (d.state === "stopped") {
      showBanner("The austere-axi server stopped. Run any austere-axi command to start it again; this page reconnects on its own.");
    }
  });
}

window.addEventListener("pagehide", (e) => {
  if (!e.persisted) navigator.sendBeacon?.(`/s/${SID}/bye`);
});

// ── boot ──

setMode(state.mode);
if (isNarrow() && state.sheetOpen) setSheet(true);
renderPresence();
renderLog();
renderDock();
loadFrame();
connect();
