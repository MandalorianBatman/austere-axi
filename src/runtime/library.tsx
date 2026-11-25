import React from "react";
import { createLibrary, defineComponent } from "@openuidev/react-lang";
import type {
  ComponentGroup,
  ComponentRenderProps,
  ComponentRenderer,
  DefinedComponent,
  Library,
} from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
// Every file in ./components/ (not starting with "_"), collected at build time.
import customComponents from "austere:components";
import type { EntryDetails } from "../../types/catalog.d.ts";
import type { AustereComponent } from "../../types/pack.d.ts";
import {
  EXTENDED,
  REMOVED,
  STOCK_GROUPS,
  STOCK_PROPS,
  STOCK_RENDERERS,
  STOCK_UNTAGGED,
} from "./stock.ts";
import { CONTENT_SLOTS } from "./define.ts";
import { CORE_DETAILS } from "./guides/index.ts";
import { storingShownDefault } from "./overrides/FieldDefaults.tsx";

export interface BuildLibraryOptions {
  /** Called for each pack component left out (its name is taken) or with a slot dropped. */
  onSkip?: (component: AustereComponent, message: string) => void;
}

/** A prompt group with its notes always present. */
export interface PromptGroup extends ComponentGroup {
  notes: string[];
}

/** AustereComponent.definition is typed loosely in types/pack.d.ts; it holds a defineComponent() result. */
function definitionOf(c: AustereComponent): DefinedComponent {
  return c.definition as DefinedComponent;
}

function messageOf(err: unknown): unknown {
  return err && typeof err === "object" && "message" in err ? err.message : undefined;
}

/**
 * A Button with no variant is secondary: the prompt writes "primary" on the one action that decides,
 * so a page with two actions shows one primary, not two equal blue ones. A button that does not
 * say "primary" also no longer blocks on form validation (stock validates only primary buttons).
 */
function quietButton<P extends { variant?: string }>(
  Comp: ComponentRenderer<P>,
): ComponentRenderer<P> {
  function QuietButton(props: ComponentRenderProps<P>) {
    return React.createElement(Comp, {
      ...props,
      props: { ...props.props, variant: props.props.variant ?? "secondary" },
    });
  }
  return QuietButton;
}

/**
 * Stock charts take their colours from one hue family and cap a bar at 16 px, so series look alike and
 * bars look like needles. The stock renderer builds the chart element; props that the stock schema
 * leaves out of its call (palette, bar cap, a scatter's axis titles) are set on that element.
 */
const CHART_PALETTE = ["#7fa7ff", "#74d3a0", "#f2c46d", "#e08a5b", "#c4a7ff", "#5fb4e6"];
const CHART_STYLE: Record<string, Record<string, unknown>> = {
  BarChart: { customPalette: CHART_PALETTE, maxBarWidth: 44, barRadius: 3 },
  HorizontalBarChart: { customPalette: CHART_PALETTE },
  LineChart: { customPalette: CHART_PALETTE },
  AreaChart: { customPalette: CHART_PALETTE },
  ScatterChart: { customPalette: CHART_PALETTE },
};
function styledChart<
  P extends { xLabel?: unknown; yLabel?: unknown; series?: unknown; datasets?: unknown },
>(Comp: ComponentRenderer<P>, style: Record<string, unknown>): ComponentRenderer<P> {
  // The stock renderer calls no hooks: it maps props to one chart element, which gets the extras.
  function StyledChart(props: ComponentRenderProps<P>) {
    const el = (Comp as (p: ComponentRenderProps<P>) => React.ReactElement | null)(props);
    if (!React.isValidElement(el)) return el;
    const labels: Record<string, unknown> = {};
    if (typeof props.props.xLabel === "string") labels.xAxisLabel = props.props.xLabel;
    if (typeof props.props.yLabel === "string") labels.yAxisLabel = props.props.yLabel;
    // One colour per series, in order: the chart spreads a longer palette over its series.
    const count = [props.props.series, props.props.datasets].find(Array.isArray)?.length;
    const palette = count ? CHART_PALETTE.slice(0, Math.max(count, 2)) : CHART_PALETTE;
    const extra: Record<string, unknown> = { ...style, customPalette: palette, ...labels };
    return React.cloneElement(el as React.ReactElement<Record<string, unknown>>, extra);
  }
  return StyledChart;
}

/**
 * A Table on a phone shows each row as a block of label/value lines (see "Table on a phone" in
 * austere.css), so no column sits off-screen. The stock table is drawn as it is; each cell then gets
 * its column's heading in `data-label`, which the CSS prints before the cell.
 */
function stackedTable<P>(Comp: ComponentRenderer<P>): ComponentRenderer<P> {
  function StackedTable(props: ComponentRenderProps<P>) {
    const box = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
      const table = box.current?.querySelector("table");
      if (!table) return;
      const labels = [...table.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
      for (const row of table.querySelectorAll("tbody tr"))
        [...row.children].forEach((td, i) => td.setAttribute("data-label", labels[i] ?? ""));
    });
    return React.createElement(
      "div",
      { ref: box, className: "austere-table" },
      React.createElement(Comp, props),
    );
  }
  return StackedTable;
}

/** Wrap a renderer so its DOM carries the statement name it came from. */
function tagged<P>(Comp: ComponentRenderer<P>, name: string): ComponentRenderer<P> {
  function Tagged(props: ComponentRenderProps<P>) {
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
export function tiersFor(
  components: AustereComponent[] = customComponents,
): Record<string, string> {
  return Object.fromEntries([
    ...EXTENDED.map((n) => [n, "extended"] as const),
    ...components.filter((c) => c.tier === "extended").map((c) => [c.name, "extended"] as const),
  ]);
}

/** Example programs by component name, for the catalog. */
export function examplesFor(
  components: AustereComponent[] = customComponents,
): Record<string, string[]> {
  return Object.fromEntries(
    components
      .filter((c): c is AustereComponent & { example: string[] } => !!c.example)
      .map((c) => [c.name, c.example] as const),
  );
}

/** Guide, keywords, family, limits and alsoIn by component name, for the catalog: CORE_DETAILS, then each component's own. */
export function detailsFor(
  components: AustereComponent[] = customComponents,
): Record<string, EntryDetails> {
  const out: Record<string, EntryDetails> = { ...CORE_DETAILS };
  for (const c of components) {
    const own: EntryDetails = {};
    if (c.guide) own.guide = c.guide;
    if (c.keywords) own.keywords = c.keywords;
    if (c.family) own.family = c.family;
    if (c.limits) own.limits = c.limits;
    if (c.alsoIn) own.alsoIn = c.alsoIn;
    if (Object.keys(own).length) out[c.name] = { ...out[c.name], ...own };
  }
  return out;
}

/**
 * Where each component of a library spec may sit, for the catalog: the content slots
 * (Card.children, ...) whose printed list names it, or null for a value-only part.
 */
export function slotsFor(
  spec: { components: Record<string, { signature: string }> },
  components: AustereComponent[] = customComponents,
): Record<string, string[] | null> {
  const valueOnly = new Set([
    ...STOCK_UNTAGGED,
    ...components.filter((c) => c.slots === null).map((c) => c.name),
  ]);
  const lists = CONTENT_SLOTS.map((slot) => {
    const [parent, prop] = slot.split(".");
    const m = new RegExp(`\\b${prop}\\??: \\(([^)]*)\\)\\[\\]`).exec(
      spec.components[parent]?.signature || "",
    );
    return { slot, names: new Set(m ? m[1].split(" | ") : []) };
  });
  return Object.fromEntries(
    Object.keys(spec.components).map((name) => [
      name,
      valueOnly.has(name) ? null : lists.filter((l) => l.names.has(name)).map((l) => l.slot),
    ]),
  );
}

export const TIERS = tiersFor();
export const EXAMPLES = examplesFor();

/**
 * Prompt groups: the stock groups with custom (and pack) components appended
 * to the one they name; a group no stock group has (a pack's own category)
 * comes after them, in the order it first appears.
 */
export function groupsFor(components: AustereComponent[] = customComponents): PromptGroup[] {
  const groups: PromptGroup[] = STOCK_GROUPS.map((g) => ({
    name: g.name,
    components: [...g.components],
    notes: [...g.notes],
  }));
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
export function buildLibrary(
  extra: AustereComponent[] = [],
  { onSkip }: BuildLibraryOptions = {},
): Library {
  const stockNames = new Set(Object.keys(openuiLibrary.components));
  for (const c of customComponents) {
    if (stockNames.has(c.name) && !REMOVED.includes(c.name)) {
      throw new Error(`custom component ${c.name} collides with a stock OpenUI component`);
    }
  }
  const taken = new Set([
    ...[...stockNames].filter((n) => !REMOVED.includes(n)),
    ...customComponents.map((c) => c.name),
  ]);
  const added: AustereComponent[] = [];
  for (const c of extra) {
    if (taken.has(c.name)) {
      onSkip?.(c, `component ${c.name} is already defined; the pack's version is ignored`);
      continue;
    }
    taken.add(c.name);
    added.push({ ...c, slots: c.slots ? [...c.slots] : c.slots });
  }
  const components = [...customComponents, ...added];
  const extendWith = () =>
    openuiLibrary.extend({
      components: {
        remove: REMOVED,
        add: components.map((c) =>
          c.slots && c.slots.length
            ? { component: definitionOf(c), slots: c.slots }
            : definitionOf(c),
        ),
      },
    });
  // A pack slot this library cannot place ("Nope.children") is dropped, not fatal:
  // the component still works in a Stack, and the page still renders.
  let curated: ReturnType<typeof extendWith>;
  for (let attempt = 0; ; attempt++) {
    try {
      curated = extendWith();
      break;
    } catch (err) {
      const m = /Slot "([^"]+)" for "([^"]+)"/.exec(String(messageOf(err)));
      const victim = m && added.find((c) => c.name === m[2]);
      if (!victim || attempt > 50) throw err;
      onSkip?.(
        victim,
        `${victim.name}: ${String(messageOf(err)).replace(/^\[extend\] /, "")} It can still be used in a Stack.`,
      );
      victim.slots = (victim.slots ?? []).filter((x) => x !== m[1]);
    }
  }
  const untagged = new Set([
    ...STOCK_UNTAGGED,
    ...components.filter((c) => !c.tagged).map((c) => c.name),
  ]);
  // Tagged components get their statement name in the DOM; form fields stay untagged but may store their shown default.
  const overrides = Object.values(curated.components).flatMap((c) => {
    const stock =
      STOCK_RENDERERS[c.name] ||
      (c.name === "Button"
        ? quietButton(c.component)
        : c.name === "Table"
          ? stackedTable(c.component)
          : c.name in CHART_STYLE
            ? styledChart(c.component, CHART_STYLE[c.name])
            : c.component);
    const renderer = storingShownDefault(c.name, stock);
    if (untagged.has(c.name) && renderer === c.component && !(c.name in STOCK_PROPS)) return [];
    const component = untagged.has(c.name) ? renderer : tagged(renderer, c.name);
    const own = (STOCK_PROPS as Record<string, { props: typeof c.props; description: string }>)[
      c.name
    ];
    return [
      defineComponent({
        name: c.name,
        props: own?.props ?? c.props,
        description: own?.description ?? c.description,
        component,
      }),
    ];
  });
  const final = curated.extend({ components: { override: overrides } });
  return createLibrary({
    id: "austere",
    root: "Stack",
    components: Object.values(final.components),
    componentGroups: added.length ? groupsFor(components) : GROUPS,
  });
}

export const austereLibrary = buildLibrary();
