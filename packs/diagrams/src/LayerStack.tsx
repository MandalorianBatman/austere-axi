import React, { useEffect, useMemo } from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame, reportRuntimeError } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { LAYER_SPEC, LEVEL_TONES, buildLevels } from "./_containment-model.ts";
import guide from "./LayerStack.md";

const nothing = () => null;

interface LayerStackProps {
  layers?: unknown;
  top?: unknown;
  bottom?: unknown;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function LayerStackView({ props, statementId }: RendererArgs<LayerStackProps>) {
  const model = useMemo(() => buildLevels(props?.layers, LAYER_SPEC), [props]);
  const top = text(props?.top);
  const bottom = text(props?.bottom);
  const problemKey = model.problems.join("\n");
  useEffect(() => {
    for (const message of model.problems)
      reportRuntimeError({ source: "layerstack", statementId, component: "LayerStack", message });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);

  return (
    <DiagramFrame className="dg-layers" name="Layer stack">
      {() => {
        if (!model.levels.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>LayerStack has no layers.</strong> List the Layer statements, top first.
              </div>
            ),
          };
        }
        const content = (
          <>
            {top ? <p className="dg-layers-end is-top">{top}</p> : null}
            <ol className="dg-layers-list" aria-label="Layers, top to bottom">
              {model.levels.map((layer) => (
                <li
                  key={layer.id}
                  className={`dg-layer${layer.tone ? ` t-${layer.tone}` : ""}`}
                  data-oui-id={layer.named ? layer.id : undefined}
                  data-oui-c={layer.named ? "Layer" : undefined}
                >
                  <div className="dg-layer-head" data-austere-part={layer.label}>
                    {layer.note ? <span className="dg-layer-tag">{layer.note}</span> : null}{" "}
                    <span className="dg-layer-name">{layer.label}</span>
                  </div>
                  {layer.items.length ? (
                    <ul className="dg-layer-items">
                      {layer.items.map((item, i) => (
                        <li key={i} data-austere-part={`${layer.label}: ${item}`}>
                          {item}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
            {bottom ? <p className="dg-layers-end is-bottom">{bottom}</p> : null}
          </>
        );
        return { content };
      }}
    </DiagramFrame>
  );
}

export const Layer = austereComponent({
  name: "Layer",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    items: z.array(z.string()).optional(),
    tag: z.string().optional(),
    tone: z.enum(LEVEL_TONES).optional(),
  }),
  description:
    'One band of a LayerStack. name is the layer; items are short words inside it (protocols, tools). tag is an index like "L4" or "07" at the left. tone tints the band (strong = the one layer under discussion). Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const LayerStack = austereComponent({
  name: "LayerStack",
  group: "Diagrams",
  tier: "extended",
  family: "Hierarchy",
  keywords: [
    "layers",
    "layer stack",
    "stack",
    "tech stack",
    "osi",
    "abstraction",
    "levels",
    "tiers",
    "cascade",
    "memory hierarchy",
    "context hierarchy",
    "bottom up",
  ],
  guide,
  limits: [
    {
      prop: "layers",
      max: 6,
      message: "Group layers: 4 to 6 bands stay readable, more hide which one matters.",
    },
  ],
  props: z.object({
    layers: z.array(Layer.definition.ref),
    top: z.string().optional(),
    bottom: z.string().optional(),
  }),
  description:
    'Abstraction levels stacked top to bottom, 4 to 6 usual: one Layer for each, with a name and short items. top and bottom label the two ends ("more abstract", "closer to hardware"). Each Layer is its own click target.',
  renderer: LayerStackView,
  example: [
    `osiStack = LayerStack([lsApp, lsTransport, lsNetwork, lsLink])
lsApp = Layer("Application", ["HTTP", "DNS", "TLS"], "L7")
lsTransport = Layer("Transport", ["TCP", "UDP"], "L4")
lsNetwork = Layer("Network", ["IP", "ICMP"], "L3")
lsLink = Layer("Link", ["Ethernet", "Wi-Fi"], "L2")`,
    `cascadeStack = LayerStack([lcPage, lcSkill, lcRepo, lcUser, lcSystem], "narrower, wins", "broader, loses")
lcPage = Layer("This request", ["prompt", "attached files"], "1", "strong")
lcSkill = Layer("Skill", ["SKILL.md", "its references"], "2")
lcRepo = Layer("Repository", ["AGENTS.md", ".agents/"], "3")
lcUser = Layer("User", ["~/.config/agent"], "4")
lcSystem = Layer("System", ["built-in rules"], "5")`,
  ],
  stress: [
    `stressLayers = LayerStack([ylA, ylB, ylC, ylD, ylE, ylF], "a caption for the top end that is rather long and keeps going", "a caption for the bottom end that is also rather long and keeps going")
ylA = Layer("APPLICATION_LAYER_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", ["an-item-with-a-very-long-unbroken-token-that-must-be-cut-at-the-edge-of-its-chip", "short"], "LAYER_SEVEN_TAG_THAT_IS_TOO_LONG")
ylB = Layer("支払いサービス層", ["東京リージョン", "大阪リージョン"], "L6")
ylC = Layer("📦 Ship it", [], "", "danger")
ylD = Layer("d", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t"])
ylE = Layer("Layer with a long human readable name that wraps over two lines and then some more", ["item"], "L3", "strong")
ylF = Layer("Sixth layer")`,
  ],
});

export default [LayerStack, Layer];
