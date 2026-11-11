// Configuration of the stock OpenUI components we ship. Custom components do
// NOT go here: each lives in its own file in ./components/ (see
// .agents/skills/add-component/SKILL.md).
import { StaticTabsRenderer } from "./overrides/Tabs.jsx";
import { GROUP_NAMES } from "./groups.js";

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

// Stock components that stay in the library but leave the prompt: rarely the
// right choice in a review page. Each group's notes name them, and
// `austere-axi components show <Name>` prints the signature on demand. A
// required prop of a core component must keep a core option (Text stays for
// OverviewCardItem's top); test/library.test.js checks this.
export const EXTENDED = [
  "ScatterChart",
  "ScatterSeries",
  "Point",
  "AreaChart",
  "HorizontalBarChart",
  "Slider",
  "SwitchGroup",
  "SwitchItem",
  "Chips",
  "ChipItem",
  "CheckBoxGroup",
  "CheckBoxItem",
  "Label",
  "EditableTable",
  "TagBlock",
  "IconText",
  "BoldText",
];

/** Stock renderers replaced with page-appropriate behavior (props unchanged). */
export const STOCK_RENDERERS = { Tabs: StaticTabsRenderer };

// Value-only components are read by their parent (never rendered as DOM on
// their own) or must stay direct children of a list; leave them untagged.
export const STOCK_UNTAGGED = [
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
];

/**
 * Prompt groups, in the order `austere-axi spec` prints them. Custom
 * components join the group they name, after the stock ones, and add their
 * own notes after the group's notes.
 */
export const STOCK_GROUPS = [
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
      "- Tabs for alternative views, Accordion for detail the reader may skip, Steps for ordered procedures. Several blocks in one Card: label each with InlineHeader.",
      "- Card children must match its list; anything else (Accordion, Tag, a Callout row) can sit in a Stack inside the Card, or directly in root's Stack.",
    ],
  },
  {
    name: "Content",
    components: ["TextContent", "MarkDownRenderer", "Callout", "CodeBlock", "Image"],
    notes: [
      "- MarkDownRenderer for prose, bullet lists and inline code; one statement per paragraph group so each is annotatable.",
      "- Callout for the one thing the reader must not miss: a risk, a decision needed, a caveat.",
      "- CodeBlock for a whole snippet. Image src may be a path relative to the artifact file.",
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
      '- Table is COLUMN-oriented: Table([Col("Option", names), Col("Effort", efforts), Col("Risk", risks)]). Col data may mix strings and components, e.g. ["n/a", Tag("high", null, "sm", "danger")]. Cells are plain text (no markdown) and wrap; Col type "number" for figures.',
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
      '- To ask the reviewer to decide: OptionCards or RadioGroup inside a Form whose button is Button("Send decision", @ToAssistant("Decision: rollout strategy"), "primary"). The values arrive with that message as form: {<formName>: {<fieldName>: value}}; no context needed. Reviewers can always annotate and message, so add a notes field only when it belongs with the decision.',
      '- OptionCards("pick", "single", [OptionCard("a", "Option A", "why", Icon("zap")), OptionCard("b", "Option B")], {required: true}, "a") — the last argument pre-selects.',
      "- rules: {required: true, minLength: 10, ...}; the renderer shows the messages.",
    ],
  },
  {
    name: "Buttons",
    components: ["Button", "Buttons"],
    notes: [
      "- @ToAssistant(message, context?) queues a message to the agent; @OpenUrl(url) opens a link. A Button with no action sends its label.",
      '- Use buttons for follow-ups the reviewer can pick in one click: "Go with option B", "Split this into two PRs".',
    ],
  },
];

export { GROUP_NAMES };

if (STOCK_GROUPS.map((g) => g.name).join() !== GROUP_NAMES.join()) {
  throw new Error("stock.js STOCK_GROUPS and groups.js GROUP_NAMES list different groups");
}
