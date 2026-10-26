---
name: add-component
description: Add a component to the austere-axi OpenUI library, add a prop to one, or re-enable a stock OpenUI component. Maintainer-only (not shipped). Use for any change under src/runtime/components/ or src/runtime/stock.js.
user-invocable: true
metadata:
  internal: true
---

# Adding a component to austere-axi

Read this whole file before writing code. The tests enforce the mechanical rules (grouping, token budget, append-only props, valid example). This file covers the decisions they can't make.

## 1. Does it earn its place?

Every component's signature, description and notes are part of the reference every agent reads (`austere-axi spec`). They cost tokens in every session, in every agent, for good. The budget is 6.5k tokens, enforced in `test/library.test.js`; the build prints the current size.

Add a component only when all three hold:

- **Real demand:** review artifacts (plans, comparisons, decisions, code reviews, reports) keep needing it. Name two concrete artifacts that would use it.
- **Composition falls short:** existing components can't express it, or can only do it badly enough that agents get it wrong. A file tree built from nested Accordions is an example.
- **Better targets:** it gives the reviewer something more precise to point at than "the whole card" (see section 4).

Prefer, in this order:

1. A note on an existing component.
2. A new optional prop on an existing component.
3. Re-enabling a stock OpenUI component from `REMOVED` in `src/runtime/stock.js`.
4. A new component.

Never add raw HTML or JS escape hatches, components that fetch data, or theming knobs.

If a request fails the bar, say so and propose the cheaper option instead of building it.

## 2. Design the call the agent will write

Agents write positional calls, and saved artifacts keep those calls forever.

- **Argument order:** put the most-used arguments first, required before optional. The first one or two arguments should cover 90% of uses.
- **Input format:** prefer one string or string array in a format agents already know (git diff, `git status --short`, Mermaid, markdown) over nested objects. `FileTree(["M src/a.ts", ...])` beats `FileTree([{path, status}])`.
- **Enums:** lowercase strings, few values.
- **Name:** a PascalCase noun that does not collide with a stock OpenUI component (the build throws if it does).
- **After release:** props are append-only, and every appended prop must be optional. `npm run signatures` and the tests enforce this.
- **Description:** one line, at most 280 characters. Say what it is, what input it takes, and what a click on it reaches the agent as.
- **Notes:** optional `"- "` lines, only for things an author would otherwise get wrong. Every line costs tokens.

## 3. Write the file

A component is one file: `src/runtime/components/<Name>.jsx`, default-exporting `austereComponent({...})`. The contract is documented in `src/runtime/define.js`. The build picks the file up automatically, so there is no list to edit. Files whose names start with `_` are helpers, not components.

```jsx
import React from "react";
import { z } from "zod";
import { austereComponent } from "../define.js";

function ThingView({ props }) {
  return <div className="austere-thing">…</div>;
}

export default austereComponent({
  name: "Thing",
  group: "Content", // Layout | Content | Data | Charts | Forms | Buttons
  props: z.object({ items: z.array(z.string()), title: z.string().optional() }),
  description: "…one line…",
  notes: ["- …only if needed…"],
  renderer: ThingView,
  example: `myThing = Thing(["…realistic…"])`,
  stress: `stressThing = Thing(["…hostile…"])`, // optional; see section 5
  // slots: null, tagged: false  ← only for value-only sub-components (like Series)
});
```

Renderer rules:

- **Static:** no fetching and no timers. The only state allowed is UI state, such as expanded or collapsed.
- **Lenient:** render whatever you can from malformed input, and never throw. Show an inline `.austere-render-error` only when nothing at all can render. Also call `reportRuntimeError` from `../env.js` so the error reaches the reviewer's panel.
- **Dark only:** use the `--openui-*` and `--austere-*` variables. Put CSS in `src/runtime/austere.css` under a `/* ── Thing ── */` section, with an `austere-thing-` class prefix.
- **Never overflow the column:** long paths and code must wrap or scroll inside the component. Check this at 390px.
- **No interactive DOM for feedback:** let the annotation layer and OpenUI forms carry feedback. A toggle that only changes local UI state is fine.
- **Testable parsing:** keep input parsing in a plain-JS helper next to the component, named `_<name>-parse.js`, so Node can import it. Unit-test it in `test/components.test.js` against the near-miss shapes agents actually write, such as markdown bullets, lowercase codes, long-form variants, absolute paths and duplicates. `_filetree-parse.js` and `_diff-parse.js` are the existing examples.

## 4. Make it annotatable

The whole component is already a target, through its statement name. Mark the smaller things a reviewer would point at with `data-austere-part="<what the agent should hear>"`:

- a diff line, as `src/retry.ts:+15`
- a node label
- a file path

The part nearest the click wins, and its text becomes the quote. Keep chrome out of that text, including line numbers, status letters, counts and icons. Draw such labels with CSS `content: attr(data-…)`, as Diff does for line numbers and FileTree does for status letters and folder counts, and make icons `aria-hidden` SVGs.

Plain `<table>`s get row and column detail automatically, so don't mark their cells.

## 5. Example and stress

`example` holds one or more statements. The first one calls the component with realistic content, and every other statement must be reachable from it. The example is checked by the tests, rendered in the gallery, and serves as your design review: if it reads awkwardly, the call design is wrong.

`stress` is optional, but add it whenever the component takes free-form input. It has the same shape as `example`, filled with hostile input: very long unbroken tokens in every text slot, deep nesting, many items, empty values, and the malformed shapes agents write. It never appears in the prompt. The tests check it, and the browser suite renders it at phone width, where overflow bugs hide; realistic examples are too tidy to expose them.

## 6. Verify

Run all of these:

```sh
npm run build                    # prints prompt tokens; note before/after
npm run signatures               # records the new signature; refuses breaking changes
npm test                         # groups, budget, signatures, example check
npm run gallery -- Thing
npm run shot -- .dev/gallery.html --full --parts
npm run shot -- .dev/gallery.html --full --width 390 --out .dev/shot-390.png
```

`shot` needs Chrome, or `CHROME_PATH` pointing at a Chromium binary. Open both PNGs and look at them. Check for:

- no horizontal-scroll warning, no render errors and no page errors
- readable contrast in the dark theme
- the listed parts are exactly what a reviewer would point at, worded the way the agent should hear them

Then use it the way an agent would. Add it to a realistic page in `examples/` and run `node dist/cli.mjs check` on that page. If you have a browser, also run the loop once: `node dist/cli.mjs <page> --no-open`, open the printed url, click a part in Annotate mode, press Send, and confirm that `node dist/cli.mjs poll <page>` shows `detail: {part: …}`.

Finally, run the `review-change` skill. It runs the browser suite (`npm run test:browser`), which clicks every part through the real review loop, and launches the change-reviewer, visual-qa and cold-start-author agents.

## Other changes

- **New prop on an existing component:** append it, make it optional, then run `npm run signatures`. Never reorder, rename or remove a prop.
- **Re-enabling a stock component:**
  - remove it from `REMOVED`
  - add it to a group in `STOCK_GROUPS`
  - add it to `STOCK_UNTAGGED` if it is value-only
  - run `npm run signatures`
- **Stock renderer behaves wrongly on a static page:** override the renderer in `src/runtime/overrides/` and register it in `STOCK_RENDERERS`, keeping the props unchanged. `Tabs` is the existing example.

## Commit

Commit the component file, its CSS, `test/fixtures/signatures.json`, and any example change together. State the prompt-token delta in the commit message.
