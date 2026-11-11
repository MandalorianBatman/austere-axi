// A plain <textarea> with syntax colouring: a <pre> with the same text sits behind it
// (the textarea's own text is transparent), and a line gutter and per-line marks are
// scrolled along. No dependency; works with the platform's own caret, selection,
// undo and mobile keyboard.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const KEYWORDS = new Set(["true", "false", "null"]);

/**
 * OpenUI Lang to HTML. Follows the statement splitter's rules for strings and comments
 * (// and # to the end of the line, outside strings; strings may span lines).
 */
export function highlight(src) {
  let out = "";
  let i = 0;
  let depth = 0;
  let lineStart = true; // only whitespace so far on this line
  const span = (cls, text) => (out += `<span class="t-${cls}">${esc(text)}</span>`);
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      out += "\n";
      lineStart = true;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      out += c;
      i++;
    } else if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      let end = src.indexOf("\n", i);
      if (end < 0) end = src.length;
      span("comment", src.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, src.length);
      span("string", src.slice(i, j));
      i = j;
      lineStart = false;
    } else if (c === "@") {
      IDENT.lastIndex = i + 1;
      const m = IDENT.exec(src);
      const end = m ? i + 1 + m[0].length : i + 1;
      span("action", src.slice(i, end));
      i = end;
      lineStart = false;
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] || ""))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      span("number", m[0]);
      i += m[0].length;
      lineStart = false;
    } else if (/[A-Za-z_$]/.test(c)) {
      IDENT.lastIndex = i;
      const word = IDENT.exec(src)[0];
      const after = src.slice(i + word.length).match(/^[ \t]*(.?)(.?)/);
      const next = after[1];
      const isDef = lineStart && depth === 0 && next === "=" && after[2] !== "=";
      if (isDef) span("def", word);
      else if (next === "(" && /[A-Z]/.test(word[0])) span("component", word);
      else if (KEYWORDS.has(word)) span("keyword", word);
      else span("ref", word);
      i += word.length;
      lineStart = false;
    } else {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      span("punct", c);
      i++;
      lineStart = false;
    }
  }
  // A trailing newline would collapse in the <pre>; keep its height equal to the textarea's.
  return src.endsWith("\n") || src === "" ? out + " " : out;
}

/**
 * @param {{ root: HTMLElement, onInput: (text: string) => void }} options
 * root holds .gutter, .marks, .hl and a textarea (see index.html).
 */
export function createEditor({ root, onInput }) {
  const area = root.querySelector("textarea");
  const hl = root.querySelector(".hl");
  const marks = root.querySelector(".marks");
  const gutter = root.querySelector(".gutter-inner");
  let lines = 0;
  let marked = "";

  function paint() {
    const text = area.value;
    hl.innerHTML = highlight(text);
    const n = text.split("\n").length;
    if (n !== lines) {
      lines = n;
      gutter.innerHTML = Array.from({ length: n }, (_, k) => `<span>${k + 1}</span>`).join("");
    }
  }

  function sync() {
    hl.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
    marks.style.transform = `translateY(${-area.scrollTop}px)`;
    gutter.style.transform = `translateY(${-area.scrollTop}px)`;
  }

  area.addEventListener("input", () => {
    paint();
    sync();
    onInput(area.value);
  });
  area.addEventListener("scroll", sync, { passive: true });
  new ResizeObserver(sync).observe(area);

  const lineHeight = () => parseFloat(getComputedStyle(area).lineHeight) || 20;

  return {
    get value() {
      return area.value;
    },
    set(text) {
      area.value = text;
      paint();
      sync();
    },
    focus: () => area.focus(),
    /** Mark lines: { line, severity: "error" | "warning" }[] (1-based). */
    mark(list) {
      const sev = new Map();
      for (const m of list) if (m.line && sev.get(m.line) !== "error") sev.set(m.line, m.severity);
      const html = Array.from({ length: lines }, (_, k) => `<i class="${sev.get(k + 1) || ""}"></i>`).join("");
      if (html === marked) return;
      marked = html;
      marks.innerHTML = html;
      gutter.querySelectorAll("span").forEach((el, k) => {
        el.className = sev.get(k + 1) || "";
      });
    },
    /** Select a statement's lines and scroll them into view. */
    reveal(line, endLine = line) {
      const text = area.value.split("\n");
      let from = 0;
      for (let k = 0; k < line - 1; k++) from += text[k].length + 1;
      let to = from;
      for (let k = line - 1; k < Math.min(endLine, text.length); k++) to += text[k].length + (k < endLine - 1 ? 1 : 0);
      area.setSelectionRange(from, to);
      const top = (line - 1) * lineHeight();
      if (top < area.scrollTop || top > area.scrollTop + area.clientHeight - lineHeight() * 2) {
        area.scrollTop = Math.max(0, top - area.clientHeight / 3);
      }
      sync();
    },
    /** Insert text at the caret, replacing the selection. */
    insert(text) {
      area.focus();
      area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
      area.dispatchEvent(new Event("input"));
    },
  };
}
