import React from "react";
import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
// Every file in ./components/ (not starting with "_"), collected at build time.
import customComponents from "austere:components";
import { EXTENDED, REMOVED, STOCK_GROUPS, STOCK_RENDERERS, STOCK_UNTAGGED } from "./stock.js";

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

/** Components that leave the prompt but stay searchable (name → "extended"). */
export function tiersFor(components = customComponents) {
  return Object.fromEntries([
    ...EXTENDED.map((n) => [n, "extended"]),
    ...components.filter((c) => c.tier === "extended").map((c) => [c.name, "extended"]),
  ]);
}

/** Example programs by component name, for the catalog. */
export function examplesFor(components = customComponents) {
  return Object.fromEntries(components.filter((c) => c.example).map((c) => [c.name, c.example]));
}

export const TIERS = tiersFor();
export const EXAMPLES = examplesFor();

/**
 * Prompt groups: the stock groups with custom (and pack) components appended
 * to the one they name; a group no stock group has (a pack's own category)
 * comes after them, in the order it first appears.
 */
export function groupsFor(components = customComponents) {
  const groups = STOCK_GROUPS.map((g) => ({ name: g.name, components: [...g.components], notes: [...g.notes] }));
  for (const c of components) {
    let g = groups.find((x) => x.name === c.group);
    if (!g) groups.push((g = { name: c.group, components: [], notes: [] }));
    g.components.push(c.name);
    g.notes.push(...c.notes);
  }
  return groups;
}

export const GROUPS = groupsFor();

/**
 * The library the renderer and the parser use: stock OpenUI minus what we
 * removed, plus our components and any pack components (`extra`). A pack
 * component whose name is taken is skipped and reported through `onSkip`.
 */
export function buildLibrary(extra = [], { onSkip } = {}) {
  const stockNames = new Set(Object.keys(openuiLibrary.components));
  for (const c of customComponents) {
    if (stockNames.has(c.name) && !REMOVED.includes(c.name)) {
      throw new Error(`custom component ${c.name} collides with a stock OpenUI component`);
    }
  }
  const taken = new Set([...[...stockNames].filter((n) => !REMOVED.includes(n)), ...customComponents.map((c) => c.name)]);
  const added = [];
  for (const c of extra) {
    if (taken.has(c.name)) {
      onSkip?.(c, `component ${c.name} is already defined; the pack's version is ignored`);
      continue;
    }
    taken.add(c.name);
    added.push(c);
  }
  const components = [...customComponents, ...added];
  const curated = openuiLibrary.extend({
    components: {
      remove: REMOVED,
      add: components.map((c) => (c.slots && c.slots.length ? { component: c.definition, slots: c.slots } : c.definition)),
    },
  });
  const untagged = new Set([...STOCK_UNTAGGED, ...components.filter((c) => !c.tagged).map((c) => c.name)]);
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
    componentGroups: added.length ? groupsFor(components) : GROUPS,
  });
}

export const austereLibrary = buildLibrary();
