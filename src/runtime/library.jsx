import React from "react";
import { z } from "zod";
import { createLibrary, defineComponent } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { DiffRenderer } from "./components/Diff.jsx";
import { MermaidRenderer } from "./components/Mermaid.jsx";
import { StaticTabsRenderer } from "./components/Tabs.jsx";

const RENDERER_OVERRIDES = { Tabs: StaticTabsRenderer };

// Stock components that do not earn their prompt tokens in review artifacts
// (chat/commerce cards, image-first blocks, modals, carousels, duplicates).
export const REMOVED = [
  "Carousel",
  "Modal",
  "TextCallout",
  "ImageBlock",
  "ImageGallery",
  "IconButton",
  "DatePicker",
  "RadialChart",
  "SingleStackedBarChart",
  "RadarChart",
  "Slice",
  "SnippetCardBlock",
  "SnippetCardItem",
  "ContextCardBlock",
  "ContextCardItem",
  "CompositeCardBlock",
  "CompositeCardItem",
  "VisualCardBlock",
  "VisualCardItem",
  "ImageText",
  "ImageTextLarge",
  "MetricIndicatorWithStrikethrough",
  "ListBlock",
  "ListItem",
];

const CONTENT_SLOTS = ["Card.children", "TabItem.content", "AccordionItem.content"];

export const Mermaid = defineComponent({
  name: "Mermaid",
  props: z.object({
    source: z.string(),
    caption: z.string().optional(),
  }),
  description:
    "Diagram from Mermaid source (flowchart, sequence, state, class, ER, gantt). source is a raw multi-line string. Keep node labels to a few words; clicked nodes reach the agent by label.",
  component: MermaidRenderer,
});

export const Diff = defineComponent({
  name: "Diff",
  props: z.object({
    patch: z.string(),
    title: z.string().optional(),
  }),
  description:
    "Unified diff (git diff output, one or more files) with line numbers. patch is a raw multi-line string. Clicked lines reach the agent as file:+line.",
  component: DiffRenderer,
});

export const GROUPS = [
  {
    name: "Layout",
    components: [
      "Stack",
      "Card",
      "CardHeader",
      "InlineHeader",
      "Separator",
      "Tabs",
      "TabItem",
      "Accordion",
      "AccordionItem",
      "Steps",
      "StepsItem",
    ],
    notes: [
      '- A page is root = Stack([...sections], "column", "l"). Each section is a Card([CardHeader(title, subtitle), ...content]).',
      '- Side by side: Stack([a, b], "row", "m", "stretch", "start", true). Cards in a row share the width.',
      "- Tabs for alternative views, Accordion for detail the reader may skip, Steps for ordered procedures.",
      "- Card children must match its list; anything else (Accordion, Tag, a Callout row) can sit in a Stack inside the Card, or directly in root's Stack.",
    ],
  },
  {
    name: "Content",
    components: ["TextContent", "MarkDownRenderer", "Callout", "CodeBlock", "Diff", "Mermaid", "Image"],
    notes: [
      "- MarkDownRenderer for prose, bullet lists and inline code; one statement per paragraph group so each is annotatable.",
      '- Callout for the one thing the reader must not miss: a risk, a decision needed, a caveat.',
      "- Mermaid for flows, architecture, sequences and state; Diff for code changes; CodeBlock for a whole snippet.",
      "- Image src may be a path relative to the artifact file.",
    ],
  },
  {
    name: "Data",
    components: [
      "Table",
      "Col",
      "EditableTable",
      "EntityList",
      "Tag",
      "TagBlock",
      "Icon",
      "OverviewCardBlock",
      "OverviewCardItem",
      "IconText",
      "Text",
      "BoldText",
      "MetricIndicatorInline",
    ],
    notes: [
      '- Table is COLUMN-oriented: Table([Col("Option", names), Col("Effort", efforts), Col("Risk", risks)]). Col data may mix strings and components, e.g. ["n/a", Tag("high", null, "sm", "danger")]. Cells are plain text and wrap; Col type "number" for figures.',
      "- EntityList for key/value facts; OverviewCardBlock + OverviewCardItem + MetricIndicatorInline for a KPI row.",
      "- EditableTable when the reviewer should correct or fill in values; edits arrive with the next @ToAssistant from its Form.",
      "- Icon names are lucide kebab-case (circle-check, triangle-alert, git-branch).",
    ],
  },
  {
    name: "Charts",
    components: [
      "BarChart",
      "LineChart",
      "AreaChart",
      "HorizontalBarChart",
      "Series",
      "PieChart",
      "ScatterChart",
      "ScatterSeries",
      "Point",
    ],
    notes: [
      '- Charts take column arrays: BarChart(labels, [Series("p50", [..]), Series("p99", [..])], "grouped", "Week", "ms").',
      "- PieChart(labels, values) with plain number arrays.",
    ],
  },
  {
    name: "Forms",
    components: [
      "Form",
      "FormControl",
      "Label",
      "Input",
      "TextArea",
      "Select",
      "SelectItem",
      "Slider",
      "CheckBoxGroup",
      "CheckBoxItem",
      "RadioGroup",
      "RadioItem",
      "SwitchGroup",
      "SwitchItem",
      "Chips",
      "ChipItem",
      "OptionCards",
      "OptionCard",
    ],
    notes: [
      "- Form(name, buttons, fields). Define each FormControl as its own statement. Never nest a Form in a Form.",
      '- To ask the reviewer to decide: OptionCards or RadioGroup inside a Form whose button is Button("Send decision", @ToAssistant("Decision: rollout strategy"), "primary"). The values arrive with that message as form: {<formName>: {<fieldName>: value}}; no context needed.',
      '- OptionCards("pick", "single", [OptionCard("a", "Option A", "why", Icon("zap")), OptionCard("b", "Option B")], {required: true}, "a") — the last argument pre-selects.',
      "- rules: {required: true, minLength: 10, ...}; the renderer shows the messages.",
    ],
  },
  {
    name: "Buttons",
    components: ["Button", "Buttons"],
    notes: [
      "- @ToAssistant(message, context?) queues a message to the agent; @OpenUrl(url) opens a link. A Button with no action sends its label.",
      "- Use buttons for follow-ups the reviewer can pick in one click: \"Go with option B\", \"Split this into two PRs\".",
    ],
  },
];

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

// Value-only components are read by their parent (never rendered as DOM on
// their own) or must stay direct children of a list; leave them untagged.
const UNTAGGED = new Set([
  "Col",
  "Series",
  "ScatterSeries",
  "Point",
  "SelectItem",
  "RadioItem",
  "CheckBoxItem",
  "SwitchItem",
  "ChipItem",
  "OptionCard",
  "TabItem",
  "AccordionItem",
  "StepsItem",
  "OverviewCardItem",
  "Icon",
  "Text",
  "BoldText",
  "IconText",
  "MetricIndicatorInline",
  "Label",
  "Input",
  "TextArea",
  "Select",
  "Slider",
  "CheckBoxGroup",
  "RadioGroup",
  "SwitchGroup",
  "Chips",
  "OptionCards",
]);

function build() {
  const curated = openuiLibrary.extend({
    components: {
      remove: REMOVED,
      add: [
        { component: Mermaid, slots: CONTENT_SLOTS },
        { component: Diff, slots: CONTENT_SLOTS },
      ],
    },
  });
  const overrides = Object.values(curated.components)
    .filter((c) => !UNTAGGED.has(c.name))
    .map((c) =>
      defineComponent({
        name: c.name,
        props: c.props,
        description: c.description,
        component: tagged(RENDERER_OVERRIDES[c.name] || c.component, c.name),
      }),
    );
  const tagged_ = curated.extend({ components: { override: overrides } });
  return createLibrary({
    id: "austere",
    root: "Stack",
    components: Object.values(tagged_.components),
    componentGroups: GROUPS,
  });
}

export const austereLibrary = build();
