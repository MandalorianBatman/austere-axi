import React, { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { assetUrl, austereComponent, reportRuntimeError } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import type { Mermaid as MermaidApi } from "mermaid";

declare global {
  interface Window {
    /** Set by mermaid.min.js once loaded. */
    mermaid?: MermaidApi;
  }
}

interface MermaidProps {
  source: string;
  caption?: string;
}

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
// Text is set at 14px (themeVariables.fontSize); shrinking past this keeps it under 10px.
const MIN_SCALE = 10 / 14;
let mermaidPromise: Promise<MermaidApi> | null = null;
let seq = 0;

function loadScript(src: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export function loadMermaid(): Promise<MermaidApi> {
  if (window.mermaid) return Promise.resolve(initMermaid(window.mermaid));
  if (!mermaidPromise) {
    const local = assetUrl("mermaid.min.js");
    mermaidPromise = (local ? loadScript(local).catch(() => loadScript(MERMAID_CDN)) : loadScript(MERMAID_CDN)).then(
      // The script just loaded defines window.mermaid.
      () => initMermaid(window.mermaid as MermaidApi),
    );
  }
  return mermaidPromise;
}

let initialized = false;
function initMermaid(m: MermaidApi): MermaidApi {
  if (!initialized) {
    initialized = true;
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif",
      themeVariables: {
        darkMode: true,
        background: "#121214",
        fontSize: "14px",
        primaryColor: "#202024",
        primaryTextColor: "#ececef",
        primaryBorderColor: "#4a4a52",
        secondaryColor: "#1a1a1e",
        secondaryTextColor: "#ececef",
        secondaryBorderColor: "#3a3a40",
        tertiaryColor: "#18181b",
        tertiaryTextColor: "#ececef",
        tertiaryBorderColor: "#3a3a40",
        lineColor: "#8b8b94",
        textColor: "#d4d4d8",
        mainBkg: "#202024",
        nodeBorder: "#4a4a52",
        clusterBkg: "#18181b",
        clusterBorder: "#34343a",
        edgeLabelBackground: "#121214",
        noteBkgColor: "#2a2614",
        noteTextColor: "#ececef",
        noteBorderColor: "#5c5326",
        actorBkg: "#202024",
        actorBorder: "#4a4a52",
        actorTextColor: "#ececef",
        signalColor: "#a1a1aa",
        signalTextColor: "#d4d4d8",
        labelBoxBkgColor: "#202024",
        labelBoxBorderColor: "#4a4a52",
        labelTextColor: "#ececef",
        loopTextColor: "#d4d4d8",
        activationBkgColor: "#2a2a30",
        activationBorderColor: "#5a5a64",
        sequenceNumberColor: "#121214",
      },
      flowchart: { htmlLabels: false, curve: "basis", padding: 12 },
      gantt: { axisFormat: "%m-%d", fontSize: 12, barHeight: 22 },
    });
  }
  return m;
}

/** Agents sometimes wrap the source in a markdown fence. */
function stripFence(source: string): string {
  const m = /^```(?:mermaid)?\s*\n([\s\S]*?)\n?```\s*$/.exec(source);
  return m ? m[1] : source;
}

/** Words of an SVG text element, lines joined with spaces (tspans would run together). */
function words(el: Element): string {
  const lines = el.querySelectorAll("tspan, div, span, p");
  const parts = lines.length ? Array.from(lines, (x) => (x.children.length ? "" : x.textContent)) : [el.textContent];
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Name what a reviewer points at, so a click reaches the agent as its label:
 * flowchart nodes, clusters and edge labels; sequence actors, messages and
 * notes; class and ER entities (by title); gantt tasks.
 */
function labelParts(root: Element): void {
  const set = (el: Element, label: string) => {
    if (label) el.setAttribute("data-austere-part", label.slice(0, 80));
  };
  root.querySelectorAll("g.node, g.cluster, g.edgeLabel").forEach((g) => {
    // Class and ER boxes hold every member: name them by their title.
    const title = g.querySelector(".classTitle, .label-group, .er.entityLabel, .name");
    set(g, words(title || g));
  });
  root.querySelectorAll("text.actor, text.messageText, text.noteText, text.taskText").forEach((el) => set(el, words(el)));
}

/** Which sides of a scrolling box hide more content: "left", "right", both, or "". */
function edges(box: HTMLElement): string {
  const max = box.scrollWidth - box.clientWidth;
  if (max <= 1) return "";
  const left = box.scrollLeft > 1 ? "left" : "";
  const right = box.scrollLeft < max - 1 ? "right" : "";
  return `${left} ${right}`.trim();
}

/** `err?.message`, for any thrown value. */
function errorMessage(err: unknown): unknown {
  return typeof err === "object" && err !== null && "message" in err ? err.message : undefined;
}

function MermaidView({ props, statementId }: RendererArgs<MermaidProps>) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Sides with more diagram past the box's edge; set once the diagram scrolls sideways.
  const [more, setMore] = useState("");
  const source = String(props.source ?? "").trim();

  useEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const update = () => setMore(edges(box));
    const resized = new ResizeObserver(update);
    resized.observe(box);
    // The svg replaces the box's children after each render; watch the new one too.
    const replaced = new MutationObserver(() => {
      const svg = box.querySelector("svg");
      if (svg) resized.observe(svg);
      update();
    });
    replaced.observe(box, { childList: true });
    box.addEventListener("scroll", update, { passive: true });
    return () => {
      resized.disconnect();
      replaced.disconnect();
      box.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!source) return undefined;
    const id = `austere-mmd-${++seq}`;
    loadMermaid()
      .then(async (m) => {
        const { svg, bindFunctions } = await m.render(id, stripFence(source));
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        const el = ref.current.querySelector("svg");
        if (el) {
          // Keep Mermaid's natural max-width so small diagrams are not blown up,
          // and let wide ones shrink while the text stays legible; past that the
          // diagram scrolls inside its box, with a fade and a hint (see `edges`).
          el.removeAttribute("height");
          el.style.height = "auto";
          if (!el.style.maxWidth) el.style.maxWidth = "100%";
          const natural = el.viewBox && el.viewBox.baseVal ? el.viewBox.baseVal.width : 0;
          // Mermaid lays a gantt out to the page width it renders at, so it only has to fit its box.
          const fitsPage = el.getAttribute("aria-roledescription") === "gantt";
          if (natural > 0 && !fitsPage) el.style.minWidth = `${Math.round(natural * MIN_SCALE)}px`;
        }
        labelParts(ref.current);
        bindFunctions?.(ref.current);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Keep where it failed; drop the parser's list of expected tokens.
        const message = String(errorMessage(err) || err).split("\n").slice(0, 4).join(" ").split(/\s*Expecting /)[0];
        setError(message);
        reportRuntimeError({ source: "mermaid", statementId, component: "Mermaid", message });
        // Mermaid leaves its scratch node behind on a failure; remove only this
        // render's, not one another diagram is still using.
        document.getElementById(`d${id}`)?.remove();
      });
    return () => {
      cancelled = true;
    };
  }, [source, statementId]);

  return (
    <figure className="austere-mermaid">
      {error ? (
        <div className="austere-render-error">
          <strong>Diagram failed to render.</strong> {error}
        </div>
      ) : null}
      <div className="austere-mermaid-svg" ref={ref} data-more={more || undefined} />
      {more ? <div className="austere-mermaid-more">Scroll sideways to see the whole diagram.</div> : null}
      {props.caption ? <figcaption>{props.caption}</figcaption> : null}
    </figure>
  );
}

export default austereComponent({
  name: "Mermaid",
  group: "Content",
  props: z.object({
    source: z.string(),
    caption: z.string().optional(),
  }),
  description:
    "Diagram from Mermaid source (flowchart, sequence, state, class, ER, gantt). source is a raw multi-line string. Keep node labels to a few words; clicked nodes reach the agent by label.",
  notes: ["- Mermaid for sequences, state machines, ER, gantt and quick flowcharts. flowchart LR fits ~4 steps before it scrolls; use TD for longer chains."],
  renderer: MermaidView,
  example: `requestPath = Mermaid("flowchart LR
  client[Client] --> api[API]
  api --> pg[(Postgres)]", "Request path")`,
});
