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
    });
  }
  return m;
}

function MermaidView({ props, statementId }) {
  const ref = useRef(null);
  const [error, setError] = useState(null);
  const source = String(props.source ?? "").trim();

  useEffect(() => {
    let cancelled = false;
    if (!source) return undefined;
    loadMermaid()
      .then(async (m) => {
        const id = `austere-mmd-${++seq}`;
        const { svg, bindFunctions } = await m.render(id, source);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        const el = ref.current.querySelector("svg");
        if (el) {
          // Keep Mermaid's natural max-width so small diagrams are not blown up;
          // just let them shrink on narrow screens.
          el.removeAttribute("height");
          el.style.height = "auto";
          if (!el.style.maxWidth) el.style.maxWidth = "100%";
        }
        // Name each node, cluster and actor so a click reaches the agent as its label.
        ref.current.querySelectorAll("g.node, g.cluster, g.edgeLabel, g.actor, text.actor, g.note").forEach((g) => {
          const label = g.textContent.replace(/\s+/g, " ").trim();
          if (label) g.setAttribute("data-austere-part", label.slice(0, 80));
        });
        bindFunctions?.(ref.current);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err?.message || err).split("\n").slice(0, 4).join(" ");
        setError(message);
        reportRuntimeError({ source: "mermaid", statementId, component: "Mermaid", message });
        document.querySelectorAll(`[id^="daustere-mmd-"], #d${"austere-mmd-" + seq}`).forEach((n) => n.remove());
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
