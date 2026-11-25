// The shared frame every diagram sits in: measures the room the page gives it,
// scrolls sideways when the diagram is wider (edge fades and a text cue), names
// the scroll region from the Card title, and offers Expand (the same React
// subtree in a modal dialog at its natural size). Exported to packs as
// `DiagramFrame` (src/runtime/pack-api.ts), so the bundled diagrams and
// third-party packs behave like Architecture. A .ts file with no JSX: the pack
// kit loads pack-api in Node, which cannot run .tsx.
import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Maximize2, X } from "lucide-react";
import type { DiagramContent, DiagramFrameProps } from "../../../types/pack.d.ts";

/** Room assumed for a box that has no width yet (hidden tab, no layout). */
const DEFAULT_ROOM = 900;
const DEFAULT_LEGIBLE_SCALE = 0.85;

export function DiagramFrame({
  children,
  name = "Diagram",
  className,
  wide,
  legibleScale = DEFAULT_LEGIBLE_SCALE,
}: DiagramFrameProps) {
  // Room the page gives us, so "auto" layouts can run across on desktop and down
  // on a phone. Measured before the first paint, so a diagram is laid out once
  // for the width it really has.
  const boxRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  // A diagram wider than its box scrolls; fade the cut edge so that shows.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState({ start: false, end: false });
  const [regionName, setRegionName] = useState(name);
  const checkCut = () => {
    const el = scrollRef.current;
    if (!el) return;
    const start = el.scrollLeft > 4;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setCut((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const update = () => {
      const w = el.clientWidth;
      setRoom((prev) => {
        if (prev === null) return w > 0 ? w : DEFAULT_ROOM;
        return w > 0 && Math.abs(prev - w) > 40 ? w : prev;
      });
      checkCut();
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Expand: the same content, in a modal dialog at its natural size. The inline
  // figure gives way while it is open, so each part id exists once.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [inlineHeight, setInlineHeight] = useState(0);
  const expand = () => {
    const figure = boxRef.current?.querySelector(".austere-diagram");
    setInlineHeight(figure instanceof HTMLElement ? figure.offsetHeight : 0);
    setExpanded(true);
  };
  const collapse = () => dialogRef.current?.close();
  const ready = room !== null;
  const inline = room === null ? null : children({ room, full: false });
  const full = expanded && room !== null && !inline?.error ? children({ room, full: true }) : null;
  const hasContent = !inline?.error && inline !== null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!expanded || !hasContent || !dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    // A modal dialog makes everything outside it inert, and draws above any
    // z-index. The annotate layer (hover box, note) moves in so it stays usable.
    const ui = document.querySelector("body > .austere-ui");
    if (ui) dialog.appendChild(ui);
    return () => {
      if (ui) document.body.appendChild(ui);
      if (dialog.open) dialog.close();
    };
  }, [expanded, hasContent]);
  useEffect(() => {
    if (!expanded) return undefined;
    if (!hasContent) {
      setExpanded(false);
      return undefined;
    }
    // Rotating the phone resizes the dialog, not the inline box.
    window.addEventListener("resize", checkCut);
    return () => window.removeEventListener("resize", checkCut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, hasContent]);

  // The content may have changed size: look at the cut again after every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(checkCut);
  // The scroll box is named from the title of the Card it sits in.
  useEffect(() => {
    const title = boxRef.current
      ?.closest(".openui-card")
      ?.querySelector(".openui-header-top-left")
      ?.textContent?.trim();
    setRegionName(title || name);
  }, [name, ready]);

  const pane = (content: DiagramContent, isFull: boolean) => {
    // Shrink to fit down to the legible scale, then scroll. The floor is never
    // wider than the diagram, and never narrower than its box, so a diagram that
    // fits at the legible scale does not scroll.
    const W = content.width;
    const boxWidth = isFull ? (W ?? 0) : (room ?? 0);
    const canvasStyle =
      W === undefined
        ? undefined
        : {
            maxWidth: `${W}px`,
            minWidth: `${Math.round(Math.min(W, Math.max(boxWidth, W * legibleScale)))}px`,
          };
    return h(
      "figure",
      {
        className: `austere-diagram${className ? ` ${className}` : ""}${isFull ? " is-full" : ""}`,
      },
      h(
        "div",
        {
          className: `austere-diagram-scroll${cut.start ? " is-cut-start" : ""}${cut.end ? " is-cut-end" : ""}`,
          ref: scrollRef,
          onScroll: checkCut,
          role: "region",
          "aria-label": regionName,
          tabIndex: 0,
        },
        h(
          "div",
          { className: "austere-diagram-canvas", style: canvasStyle },
          content.content as ReactNode,
        ),
      ),
      cut.start || cut.end
        ? h(
            "p",
            { className: "austere-diagram-cue", "aria-hidden": "true" },
            `${cut.start ? "← " : ""}Scroll sideways for more${cut.end ? " →" : ""}`,
          )
        : null,
      content.caption as ReactNode,
    );
  };

  let body: ReactNode = null;
  if (inline?.error) {
    body = inline.error as ReactNode;
  } else if (inline) {
    body = [
      h(
        "div",
        { className: "austere-diagram-tools", key: "tools" },
        h(
          "button",
          {
            type: "button",
            className: "austere-diagram-expand",
            ref: expandRef,
            onClick: expand,
            "aria-haspopup": "dialog",
            "aria-label": `Expand ${regionName}`,
          },
          h(Maximize2, { size: 15, "aria-hidden": "true" }),
          "Expand",
        ),
      ),
      expanded
        ? h("div", { key: "figure", style: { height: inlineHeight }, "aria-hidden": "true" })
        : h(Fragment, { key: "figure" }, pane(inline, false)),
      h(
        "dialog",
        {
          key: "dialog",
          ref: dialogRef,
          className: "austere-diagram-dialog",
          "aria-label": regionName,
          onClose: () => {
            setExpanded(false);
            expandRef.current?.focus();
          },
        },
        expanded && full
          ? [
              h(
                "div",
                { className: "austere-diagram-dialog-bar", key: "bar" },
                h("span", { className: "austere-diagram-dialog-title" }, regionName),
                h(
                  "button",
                  {
                    type: "button",
                    className: "austere-diagram-expand",
                    onClick: collapse,
                    "aria-label": "Close",
                  },
                  h(X, { size: 18, "aria-hidden": "true" }),
                  "Close",
                ),
              ),
              h(
                Fragment,
                { key: "pane" },
                full.error ? (full.error as ReactNode) : pane(full, true),
              ),
            ]
          : null,
      ),
    ];
  }
  return h("div", { className: `austere-diagram-box${wide ? " is-wide" : ""}`, ref: boxRef }, body);
}
