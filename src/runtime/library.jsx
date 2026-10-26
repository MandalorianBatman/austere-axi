import React from "react";
import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
// Every file in ./components/ (not starting with "_"), collected at build time.
import customComponents from "austere:components";
import { REMOVED, STOCK_GROUPS, STOCK_RENDERERS, STOCK_UNTAGGED } from "./stock.js";

/** Wrap a renderer so its DOM carries the statement name it came from. */
function tagged(Comp, name) {
  function Tagged(props) {
    const inner = React.createElement(Comp, props);
    if (!props.statementId) return inner;
    return React.createElement(
      "div",
      { "data-oui-id": props.statementId, "data-oui-c": name, className: "austere-node" },
      inner,
    );
  }
  Tagged.displayName = `Austere(${name})`;
  return Tagged;
}

export const CUSTOM_COMPONENTS = customComponents;

export const GROUPS = STOCK_GROUPS.map((g) => {
  const mine = customComponents.filter((c) => c.group === g.name);
  return {
    name: g.name,
    components: [...g.components, ...mine.map((c) => c.name)],
    notes: [...g.notes, ...mine.flatMap((c) => c.notes)],
  };
});

function build() {
  const stockNames = new Set(Object.keys(openuiLibrary.components));
  for (const c of customComponents) {
    if (stockNames.has(c.name) && !REMOVED.includes(c.name)) {
      throw new Error(`custom component ${c.name} collides with a stock OpenUI component`);
    }
  }
  const curated = openuiLibrary.extend({
    components: {
      remove: REMOVED,
      add: customComponents.map((c) => (c.slots && c.slots.length ? { component: c.definition, slots: c.slots } : c.definition)),
    },
  });
  const untagged = new Set([...STOCK_UNTAGGED, ...customComponents.filter((c) => !c.tagged).map((c) => c.name)]);
  const overrides = Object.values(curated.components)
    .filter((c) => !untagged.has(c.name))
    .map((c) =>
      defineComponent({
        name: c.name,
        props: c.props,
        description: c.description,
        component: tagged(STOCK_RENDERERS[c.name] || c.component, c.name),
      }),
    );
  const final = curated.extend({ components: { override: overrides } });
  return createLibrary({
    id: "austere",
    root: "Stack",
    components: Object.values(final.components),
    componentGroups: GROUPS,
  });
}

export const austereLibrary = build();
