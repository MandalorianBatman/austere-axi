// The DOM helper shared by the review chrome (chrome.ts) and its owner navigation (nav.ts). The hub (shell.tsx, settings.tsx) is React.

export type AttrValue = string | boolean | null | undefined | ((e: Event) => unknown);
export type Child = Node | string | number | null | undefined | false;

/**
 * An element with attributes and children. `text` sets textContent, `on…` adds a listener, `html` sets
 * innerHTML (only for markup this code builds itself); strings and numbers become text nodes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on")) {
      if (typeof v === "function") el.addEventListener(k.slice(2), v);
    } else if (k === "text") el.textContent = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat())
    if (c != null && c !== false)
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
