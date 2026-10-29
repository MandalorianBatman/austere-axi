import React, { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { assetUrl, austereComponent, reportRuntimeError } from "austere-axi/pack";

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
let mermaidPromise = null;
let seq = 0;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export function loadMermaid() {
  if (window.mermaid) return Promise.resolve(initMermaid(window.mermaid));
  if (!mermaidPromise) {
    const local = assetUrl("mermaid.min.js");
    mermaidPromise = (local ? loadScript(local).catch(() => loadScript(MERMAID_CDN)) : loadScript(MERMAID_CDN)).then(
      () => initMermaid(window.mermaid),
    );
  }
  return mermaidPromise;
}

let initialized = false;
function initMermaid(m) {
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
function stripFence(source) {
  const m = /^```(?:mermaid)?\s*\n([\s\S]*?)\n?```\s*$/.exec(source);
  return m ? m[1] : source;
}

/** Words of an SVG text element, lines joined with spaces (tspans would run together). */
function words(el) {
  const lines = el.querySelectorAll("tspan, div, span, p");
  const parts = lines.length ? Array.from(lines, (x) => (x.children.length ? "" : x.textContent)) : [el.textContent];
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Name what a reviewer points at, so a click reaches the agent as its label:
 * flowchart nodes, clusters and edge labels; sequence actors, messages and
 * notes; class and ER entities (by title); gantt tasks.
 */
function labelParts(root) {
  const set = (el, label) => {
    if (label) el.setAttribute("data-austere-part", label.slice(0, 80));
  };
  root.querySelectorAll("g.node, g.cluster, g.edgeLabel").forEach((g) => {
    // Class and ER boxes hold every member: name them by their title.
    const title = g.querySelector(".classTitle, .label-group, .er.entityLabel, .name");
    set(g, words(title || g));
  });
  root.querySelectorAll("text.actor, text.messageText, text.noteText, text.taskText").forEach((el) => set(el, words(el)));
}

function MermaidView({ props, statementId }) {
  const ref = useRef(null);
  const [error, setError] = useState(null);
  const source = String(props.source ?? "").trim();

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
          // and let wide ones shrink, but not below 60% of their natural size:
          // past that the text is unreadable, so the diagram scrolls instead.
          el.removeAttribute("height");
          el.style.height = "auto";
          if (!el.style.maxWidth) el.style.maxWidth = "100%";
          const natural = el.viewBox && el.viewBox.baseVal ? el.viewBox.baseVal.width : 0;
          if (natural > 0) el.style.minWidth = `${Math.round(Math.min(natural, natural * 0.6))}px`;
        }
        labelParts(ref.current);
        bindFunctions?.(ref.current);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Keep where it failed; drop the parser's list of expected tokens.
        const message = String(err?.message || err).split("\n").slice(0, 4).join(" ").split(/\s*Expecting /)[0];
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
      <div className="austere-mermaid-svg" ref={ref} />
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
  notes: ["- Mermaid for sequences, state machines, ER, gantt and quick flowcharts."],
  renderer: MermaidView,
  example: `requestPath = Mermaid("flowchart LR
  client[Client] --> api[API]
  api --> pg[(Postgres)]", "Request path")`,
});
