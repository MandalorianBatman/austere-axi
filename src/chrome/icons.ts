// Line icons for the review page and the hub (24×24, stroke = currentColor), drawn from the redesign's artboards.
// Built with createElementNS, never innerHTML. Decorative by default (aria-hidden); pass a label for a meaningful icon.

const NS = "http://www.w3.org/2000/svg";

type Shape = [tag: "path" | "circle" | "rect", attrs: Record<string, string | number>];

const p = (d: string): Shape => ["path", { d }];
const circle = (cx: number, cy: number, r: number, extra: Record<string, string | number> = {}): Shape => ["circle", { cx, cy, r, ...extra }];
const rect = (x: number, y: number, width: number, height: number, rx: number): Shape => ["rect", { x, y, width, height, rx }];

export const ICONS = {
  inbox: [p("M22 12h-6l-2 3h-4l-2-3H2"), p("M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z")],
  file: [p("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"), p("M14 3v5h5")],
  message: [p("M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")],
  annotate: [p("M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"), p("M12 7v6M9 10h6")],
  explore: [p("m5 4 6 15 2-6 6-2z")],
  terminal: [p("m5 8 4 4-4 4"), p("M12 17h7")],
  sliders: [p("M4 6h8"), p("M18 6h2"), circle(15, 6, 2.5), p("M4 12h2"), p("M12 12h8"), circle(9, 12, 2.5), p("M4 18h8"), p("M18 18h2"), circle(15, 18, 2.5)],
  search: [circle(11, 11, 7), p("m20 20-3.5-3.5")],
  chevronDown: [p("m6 9 6 6 6-6")],
  chevronRight: [p("m9 6 6 6-6 6")],
  pencil: [p("M12 20h8"), p("M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z")],
  person: [circle(12, 8, 3.5), p("M5 20a7 7 0 0 1 14 0")],
  alert: [p("M12 4 3 19h18z"), p("M12 10v4"), p("M12 16.6v.4")],
  bolt: [p("M13 3 5 13h6l-1 8 8-10h-6z")],
  waiting: [circle(12, 12, 8, { "stroke-dasharray": "3.2 3.2" })],
  archive: [rect(3, 4, 18, 4, 1), p("M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"), p("M10 12h4")],
  branch: [circle(6, 5, 2), circle(6, 19, 2), circle(18, 8, 2), p("M6 7v10"), p("M18 10c0 4-4 5-12 5")],
  clock: [circle(12, 12, 8), p("M12 8v4l3 2")],
  arrowRight: [p("M5 12h14M13 6l6 6-6 6")],
  close: [p("M6 6l12 12M18 6 6 18")],
  panel: [rect(3, 4, 18, 16, 2), p("M15 4v16")],
  menu: [p("M4 6h16M4 12h16M4 18h16")],
  check: [p("m5 12 5 5 9-10")],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

/**
 * An inline stroke icon. Decorative (aria-hidden) unless `label` is given, which makes it role="img".
 * @param size  width and height in CSS px
 * @param width stroke width
 */
export function icon(name: IconName, { size = 16, width = 1.7, label, cls }: { size?: number; width?: number; label?: string; cls?: string } = {}): SVGSVGElement {
  return svgIcon(ICONS[name], { size, width, label, cls });
}

/** The same, from shapes a module defines for itself (see ICONS for the format). */
export function svgIcon(shapes: readonly Shape[], { size = 16, width = 1.7, label, cls }: { size?: number; width?: number; label?: string; cls?: string } = {}): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  const set = (el: Element, attrs: Record<string, string | number>): void => {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  };
  set(svg, { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", class: `icon${cls ? ` ${cls}` : ""}` });
  if (label) set(svg, { role: "img", "aria-label": label });
  else svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(NS, tag);
    set(el, attrs);
    svg.append(el);
  }
  return svg;
}

export type { Shape };
