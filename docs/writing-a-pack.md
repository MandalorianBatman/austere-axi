# Writing a pack

A pack adds components to austere-axi review pages. It is an npm package that ships two files: `dist/pack.js`, the components in a few KB, and `dist/catalog.json`, their signatures, examples and schema. This guide builds one from nothing and uses [`austere-pack-gantt`](https://github.com/MandalorianBatman/austere-pack-gantt) as the worked example. That repo is a real third-party pack: it builds only against the public `austere-axi/pack` API and the catalog format, and imports nothing from inside austere-axi. Read it next to this page, or copy it.

It adds a Gantt chart:

```
plan = Gantt([design, build, launch], "Q4 rollout")
design = GanttTask("Design", "2026-11-02", "2026-11-13", 100, "Ada")
build = GanttTask("Build", "2026-11-09", "2026-12-04", 45, "Grace")
launch = GanttTask("Launch", "2026-12-14")
```

## 1. Scaffold

```sh
austere-axi components new austere-pack-gantt
cd austere-pack-gantt && npm install && npm run build
austere-axi components add .
```

`new` writes a working one-component pack (`Milestones`), a `package.json` with `austere-axi` and `esbuild` as dev dependencies, and a README. Delete the sample component and keep the layout:

| File | Role |
|---|---|
| `src/index.js` | The entry. Default-exports `{ components: [...], css }` |
| `src/Gantt.jsx` | One or more components, each an `austereComponent(...)` |
| `src/style.css` | Optional CSS. The runtime adds it to the page once |
| `package.json` | `name`, `version` (`x.y.z`), `files: ["dist"]`, `scripts.build` |
| `dist/` | Build output |

The entry in the example is three lines:

```js
import { Gantt, GanttTask } from "./Gantt.jsx";
import css from "./style.css";

export default { components: [Gantt, GanttTask], css };
```

## 2. Define a component

`austereComponent` from `austere-axi/pack` is the same contract the core components follow. The Gantt pack has two. `GanttTask` is a value-only child: it renders nothing itself, and `Gantt` reads its props.

```jsx
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

export const GanttTask = austereComponent({
  name: "GanttTask",
  group: "Data",
  props: z.object({
    name: z.string(),
    start: z.string(),
    end: z.string().optional(),
    progress: z.number().optional(),
    owner: z.string().optional(),
  }),
  description: 'One bar in a Gantt. start and end are "YYYY-MM-DD" (end inclusive; omit or "" for a one-day milestone). progress is 0-100; owner is a short label.',
  renderer: () => null,
  slots: null,     // value-only: it can't stand alone on a page
  tagged: false,
});

export const Gantt = austereComponent({
  name: "Gantt",
  group: "Data",
  props: z.object({ tasks: z.array(GanttTask.definition.ref), title: z.string().optional() }),
  description: "Gantt chart: GanttTasks as bars on a shared date axis, in the order given. Each bar is a click target.",
  renderer: GanttView,
  example: `plan = Gantt([design, build], "Q4 rollout")
design = GanttTask("Design", "2026-11-02", "2026-11-13", 100, "Ada")
build = GanttTask("Build", "2026-11-09", "2026-12-04", 45, "Grace")`,
});
```

What each field does:

- **`name`**: PascalCase, the word the agent writes. It must not collide with a core component; the build warns if it does, and pages get the core one.
- **`props`**: a zod object. **Props are positional**: the order in `z.object` is the order in the call. Once you publish, append only, and make new props optional. Reordering breaks every page that uses the pack.
- **`description`**: one line the agent reads in `components show`. Say what the props mean, including formats (`"YYYY-MM-DD"`).
- **`group`**: a core group (`Layout`, `Content`, `Data`, `Charts`, `Forms`, `Buttons`) or a short capitalized category of your own.
- **`example`**: statements whose first one calls this component. Required except for value-only parts (`slots: null`), whose parent's example shows them. It lands in `catalog.json`, so an agent that runs `components show Gantt` gets something to copy. Every example should pass `austere-axi check`.
- **`stress`** (optional): the same with hostile input: a bad date, a very long name. It never reaches the prompt. Render it yourself at phone width.
- **`slots`**: where it may be placed besides a `Stack`. The default is `Card.children`, `TabItem.content` and `AccordionItem.content`. `null` for value-only parts; `"Parent.prop"` names (the parent must be in your pack or core) to fill another component's slot.
- **`tier: "extended"`**: keeps it out of `spec`, still findable with `components search`. Use it for rare components.
- **`tagged`**: wraps the output with its statement name, which is what annotations address. Default `true`.

To nest components, put `Child.definition.ref` in the parent's props, as `Gantt` does with `GanttTask`.

## 3. Render

The renderer is a React component that receives `{ props, renderNode, statementId }`. React and zod are the page's own copies; the build maps those imports, so never bundle your own.

Rules the Gantt pack follows, and any pack should:

- **Be lenient.** Props come from an agent. Treat every one as possibly missing or wrong. In the Gantt pack a bad date keeps its row, shows `start "next tuesday" is not YYYY-MM-DD` and draws no bar, so one typo never hides the chart. Keep that logic in a plain module (`src/dates.js`) with its own `node --test` tests; it needs no browser.
- **Render text as React text.** Never `dangerouslySetInnerHTML` with agent input. A title of `<img src=x onerror=alert(1)>` shows as text.
- **Mark click targets.** Put `data-austere-part="Design"` on an element and a reviewer can annotate just that piece. The note returns to the agent with `part: Design`.
- **Use the theme.** The page defines these CSS variables: `--austere-accent`, `--austere-accent-bg`, `--austere-surface`, `--austere-surface-2`, `--austere-line`, `--austere-text`, `--austere-muted`, `--austere-queued` (green), `--austere-changed` (amber) and `--austere-del-strong` (red). Use them instead of fixed colors. Prefix every class with your pack's name (`pack-gantt-…`) so nothing collides.
- **Work at 390 px wide.** The label column in the Gantt pack is `clamp(88px, 28%, 200px)` and the bars use percentages.
- **Touch no `window` or `document` at module level.** `components build` also loads the pack in Node to read its component definitions. Use them inside renderers and effects.

## 4. Build

```sh
npm run build        # austere-axi components build .
```

The build bundles `src/index.js` into `dist/pack.js`, an IIFE that calls `registerPack({ name, version, api, components, css })` when the page loads it. It then loads the same module in Node and writes `dist/catalog.json` with each component's signature, group, examples and slots, the JSON schema `check` merges into the core one, the pack's `size` and a `sha384` `integrity` hash. The Gantt pack comes to about 8 KB.

The build runs the pack's own code, so build only packs you trust. The pack's `esbuild` does the bundling; austere-axi ships none.

## 5. Try it

```sh
austere-axi components add .          # a folder counts as your own: no --trust
austere-axi components show Gantt     # the signature and example an agent sees
austere-axi check --fix plan.html     # declares the pack in the page head
austere-axi plan.html                 # review it
```

`check --fix` writes `<meta name="austere-packs" content="austere-pack-gantt@0.1.0 sha384-…">` into the page. The hash pins the exact build, so after you rebuild and run `components add` again, `check` warns `pack-integrity` and `check --fix` updates it.

Before you publish, try the install your users will do. Pack the folder and install the `.tgz`:

```sh
npm pack
austere-axi components add ./austere-pack-gantt-0.1.0.tgz --trust
austere-axi check --fix examples/rollout.html
```

`AUSTERE_AXI_STATE_DIR=$(mktemp -d)` keeps that off your real `~/.austere-axi`. The Gantt repo does exactly this in `scripts/check-example.mjs`.

## 6. CI

The Gantt pack's [`ci.yml`](https://github.com/MandalorianBatman/austere-pack-gantt/blob/main/.github/workflows/ci.yml) runs on every push and pull request:

1. `npm ci` and `npm run build`.
2. `git diff --exit-code -- dist`: `dist/` is committed so the repo works as a folder pack, and CI fails when it is stale.
3. `npm test`: the date and layout logic.
4. `npm run check:example`: packs the folder, installs the `.tgz` with `--trust`, copies `examples/rollout.html`, expects `check` to report `missing-pack`, runs `check --fix`, and expects a clean `check`.

The example page does not declare the pack on purpose. That keeps the committed file free of a hash that changes with every build, and it proves `check --fix` works.

## 7. Publish

Pin `austere-axi` as a dev dependency (`^0.4.1`) and publish only `dist`, `README.md` and `LICENSE`:

```json
{
  "name": "austere-pack-gantt",
  "version": "0.1.0",
  "keywords": ["austere-axi-pack"],
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": { "build": "austere-axi components build .", "prepublishOnly": "npm run build && npm test" },
  "devDependencies": { "austere-axi": "^0.4.1", "esbuild": "^0.28.0" }
}
```

```sh
npm publish
```

Once it is published, users install it with `austere-axi components add austere-pack-gantt --trust`. The Gantt pack is not on npm yet, so until then use `austere-axi components add <path-to-clone> --trust` or the `.tgz` from step 5. `--trust` is required for any pack outside `@austere-axi/`: its code runs inside the review page, so tell users what it does and keep it small enough to read. The README of the Gantt pack is a template for that.

A GitHub Release can publish through npm trusted publishing instead of a token. Copy [`publish.yml`](https://github.com/MandalorianBatman/austere-pack-gantt/blob/main/.github/workflows/publish.yml) and set the trusted publisher once on npmjs.com.

## Rules to keep once you publish

- Props are positional and append-only. New props go last and are optional.
- `registerPack` takes `api: 1`, which the build sets. A pack built for another major version of the pack API is refused. austere-axi changes `austere-axi/pack` and the catalog format additively; a breaking change bumps `PACK_API` or `CATALOG_FORMAT`.
- Bump `version` for every change to `dist/`. The page pins `name@version` plus the hash.
- The pack runs only in the sandboxed artifact frame. It has no access to the CLI, the server or the user's files, but it does see the page's content and the reviewer's input.
