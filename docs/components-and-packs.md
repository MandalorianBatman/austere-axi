# Components and packs

`spec` covers the common components (~5.7k tokens). Rare ones (area and scatter charts, sliders, switches, editable tables, …) are in the library but not in `spec`. Find them with `components`:

```sh
austere-axi components                  # every component, by group (names only)
austere-axi components list Diagrams    # a group's chooser: each component and recipe with what it is for
austere-axi components search scatter   # search by name, keywords, group, description; also packs on npm
austere-axi components search lanes --group Diagrams   # only that group's entries
austere-axi components show AreaChart   # signature, its parts' signatures, where it sits, usage guide, two examples
austere-axi components show Milestones --pack austere-pack-orbit   # one pack's, when several share the name
```

- `list <Group>`: one line per standalone component (value-only parts such as `Node` are left out) and per recipe: name + first sentence of its usage guide. `Diagrams` is filed by family.
- **Recipe**: a diagram type an existing component draws well, e.g. `Swimlane` (`Architecture` with lanes). No component of its own; `show` prints the components to write, and `check` answers a page that calls it with the same. [Diagrams](diagrams.md) lists every type and its status.
- A list prop longer than a component's declared limit is a `check` warning (`limit`), with the statement and line.

## Packs

A pack is an npm package that adds components: `dist/pack.js` (the components, a few KB) and `dist/catalog.json` (signatures, examples, schema).

```sh
austere-axi components add austere-pack-gantt --trust   # npm name, folder, or .tgz
austere-axi check --fix plan.html                       # adds the pack tag to the page
```

### Packs on npm

`components search` and `show` also cover uninstalled npm packages with the keyword `austere-axi-pack`.

- Search lists up to 8 core and installed components under `results`, then up to 3 from npm packs under `npm`; an npm pack never pushes out a core component.
- An npm result names its pack, says `not installed`, and says first-party, `trusted` (on your trust list) or third-party. `show` cuts such a component's description, example and notes short.
- `show <Name>` returns the first component by that name, core and installed packs first. `--pack <pack>` looks only in that pack; search names it for an npm result whose name another result or local component shares.
- The CLI reads the pack's catalog from its tarball, checked against the registry's integrity hash, and runs none of its code.
- Caching, under `~/.austere-axi/npm-packs/`:
  - pack list: one hour;
  - each pack version: for good once read, once it fails the install checks, or once the registry answers 404 or 410; any other failure is retried on the next search.
- Third-party pack: the agent is told to ask you to review it and run `components add <pack> --trust`.
- Registry unreachable: search shows local results, says so, and retries the registry after 5 minutes. A pack the registry fails to serve is left out; search says how many.

### The pack tag

A page names its packs in the head, so it renders anywhere:

```html
<meta name="austere-packs" content="austere-pack-gantt@1.2.0 sha384-…">
```

- Under review, the server serves an installed pack only while it matches its hash in `~/.austere-axi/packs.json`. Opened directly, the page loads packs from jsDelivr with Subresource Integrity.
- `export` inlines the runtime and packs gzipped (base64); a short loader unpacks them with `DecompressionStream` (Chrome 80, Firefox 113, Safari 16.4). Review and patch the source page; the exported copy is for sharing. `check` flags an exported copy; review serves it as is, with no second runtime.
- A pack component with no pack tag is a `missing-pack` error; `check --fix` repairs it.

### Bundled packs

Need no tag; load only when used.

- `shadcn` (read-only): `Progress`, `Avatar`, `AvatarGroup`, `Tooltip`, `HoverCard`, `Breadcrumb` (`BreadcrumbItem`), `Kbd`, `Skeleton`, `Calendar`, `Timeline` (`TimelineItem`).
  ```
  rollout = Progress(64, "Rows migrated")
  freeze = Calendar("2026-11", ["2026-11-04 Code freeze"])
  ```
- `diagrams` (read-only): the diagram types that need no graph layout, each with its parts (see [Diagrams](diagrams.md)): `Sequence`, `Nested`, `LayerStack`, `Kanban`, `StoryMap`, `UserJourney`, `ServiceBlueprint`, `EventModel`, `Heatmap`, `PermissionMatrix`, `UnitGrid`, `Traceability`, `Gantt`, `GitGraph`, `ScheduleNetwork`, `Quadrant`, `Venn`, `Pyramid`, `Loop`, `Fishbone`, `WardleyMap`, `Radar`, `PolarChart`, `Waterfall`, `Treemap`, `Sankey`.
- Types that need graph layout (`Architecture`, `Flowchart`, `StateMachine`, `Tree`, `OrgChart`, `ERDiagram`, `ClassDiagram`) are in core. Recipes draw the rest with `Architecture`, `ERDiagram` and the stock charts.

## Trust

Pack code runs inside your review pages, where notes and button presses also come from.

- Packs under `@austere-axi/` on npm install directly.
- Other npm packs and any `.tgz` need `--trust`: read them first.
- A local folder counts as your own.
- A page with third-party packs shows a warning, and `poll` tells the agent.

Your trust list, `~/.austere-axi/trusted.json`, names npm packs your agent may install without `--trust`:

```sh
austere-axi trust add austere-pack-gantt@1.2.0   # pins that version and the hash of its pack.js
austere-axi trust add @acme                      # every pack in a scope on the current registry, e.g. your company's
austere-axi trust list
austere-axi trust remove @acme
```

- **Pin**: trusts one exact version with the same `pack.js`. A later publish, or the same version with other code, still needs `--trust`. `components add <pack>` with no version installs the pinned one.
- **Scope**: bound to the registry it was added from: its private registry if the scope is mapped (see [Private registries](#private-registries)), else the default (`AUSTERE_AXI_NPM_REGISTRY`, else `npm_config_registry`, else npmjs). On another registry its packs are third-party again (anyone may own the scope name there).
- Search marks listed packs `trusted` and tells the agent it may add them.
- `trust add` asks for confirmation at a terminal and refuses when stdin is not one (as when an agent runs it). This stops accidental additions, not an agent set on editing the file.
- Only this file in your home folder counts; a project cannot ship its own list.
- File unreadable:
  - search counts every npm pack third-party and says so;
  - `trust` refuses until you fix or delete it;
  - `components add` refuses only a third-party npm pack without `--trust`. First-party packs, local folders and `--trust` installs are unaffected.

## Private registries

Map an npm scope to a registry (Verdaccio, Artifactory, GitHub Packages) in `~/.austere-axi/registries.json` to find and install your team's packs:

```sh
austere-axi registry add @acme https://npm.acme.dev/ --token-env ACME_NPM_TOKEN
austere-axi registry list
austere-axi registry remove @acme
```

- `components search` and `show` query the default registry and each mapped one (same `austere-axi-pack` keyword). A mapped hit names its host, e.g. `npm @acme/pack-flows@0.3.0 (npm.acme.dev), not installed, third-party`. If one registry does not answer, the others still do and the result names the unavailable one.
- `components add @acme/<pack>` installs from @acme's registry. A mapped registry counts only for its own scope: its packs under other names are ignored, and the default registry's packs in that scope are left out.
- `--token-env` names an env var holding a bearer token. The file stores the name, never the token. The token goes only to that registry's own origin, never to the default registry or a tarball on another host.
- URL must be https, or http on localhost. `@austere-axi` cannot be mapped.
- `registry add` runs only at a terminal (the mapping decides which host gets the token); an agent without one is told to ask you. `registry remove` works anywhere.
- Mapping grants no trust: packs stay third-party until you trust the scope (`trust add @acme`, which records the mapped registry) or pin a pack.
- Only this file in your home folder counts. If unreadable, search covers the default registry only and says so; `components add`, `trust add` and `registry` refuse until you fix it.

## Write a pack

[Writing a pack](writing-a-pack.md) goes from scaffold to `npm publish`, using [austere-pack-gantt](https://github.com/MandalorianBatman/austere-pack-gantt) as the example. Short version:

```sh
austere-axi components new austere-pack-milestones
cd austere-pack-milestones && npm install && npm run build
austere-axi components add .
```

Each component uses `austereComponent` from `austere-axi/pack`: a PascalCase name, zod props in positional order (append-only after you publish), a one-line description and an example. The build loads the pack in Node, so build only code you trust.
