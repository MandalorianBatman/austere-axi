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

`list <Group>` prints one line for each component that can stand on its own (value-only parts such as `Node` are left out) and each recipe: its name and the first sentence of its usage guide. `Diagrams` files them by family. A **recipe** is a diagram type an existing component draws well, such as `Swimlane` (`Architecture` with lanes): it has no component of its own, `show` prints the components to write, and `check` answers a page that calls it with the same. [Diagrams](diagrams.md) lists every diagram type and its status.

A list prop longer than a component's declared limit is a `check` warning (`limit`), with the statement and the line.

**Packs** add components. A pack is an npm package with `dist/pack.js` (the components, a few KB) and `dist/catalog.json` (signatures, examples, schema).

```sh
austere-axi components add austere-pack-gantt --trust   # npm name, folder, or .tgz
austere-axi check --fix plan.html                       # adds the pack tag to the page
```

`components search` and `components show` also cover packs on npm that are not installed, meaning any package with the keyword `austere-axi-pack`. Search lists up to 8 core and installed components under `results`, then up to 3 from packs on npm under `npm`, so a pack on npm never pushes a core component out. A result names its pack, says `not installed`, and says whether the pack is first-party, `trusted` (on your trust list) or third-party; `show` cuts such a component's description, example and notes short. `show <Name>` returns the first component by that name, core and installed packs first; `--pack <pack>` looks only in that pack, and search names it for an npm result whose name another result or a local component shares. The CLI reads the pack's catalog from its tarball, checked against the registry's integrity hash, and runs none of its code. It caches the pack list for an hour, under `~/.austere-axi/npm-packs/`. It caches each pack version for good once it is read, fails the install checks, or the registry answers 404 or 410 for it; any other failure is tried again on the next search. For a third-party pack, the agent is told to ask you to review it and run `components add <pack> --trust`. With the registry unreachable, search shows local results, says so, and tries the registry again after 5 minutes. A pack the registry fails to serve is left out, and search says how many were.

A page names its packs in the head, so it renders anywhere:

```html
<meta name="austere-packs" content="austere-pack-gantt@1.2.0 sha384-…">
```

- Under review, the server serves an installed pack only while it matches its hash in `~/.austere-axi/packs.json`. Opened directly, the page loads packs from jsDelivr with Subresource Integrity. `export` inlines them.
- `export` inlines the runtime and packs gzipped (base64), and a short loader unpacks them with `DecompressionStream` (Chrome 80, Firefox 113, Safari 16.4). Review and patch the source page; the exported copy is for sharing. `check` flags an exported copy, and review serves it as it is, with no second runtime.
- A pack component with no pack tag is a `missing-pack` error. `check --fix` repairs it.
- **Bundled packs** need no tag and load only when used:
  - `shadcn`: `Progress`, `Avatar`, `AvatarGroup`, `Tooltip`, `HoverCard`, `Breadcrumb` (`BreadcrumbItem`), `Kbd`, `Skeleton`, `Calendar` and `Timeline` (`TimelineItem`). Read-only.
  ```
  rollout = Progress(64, "Rows migrated")
  freeze = Calendar("2026-11", ["2026-11-04 Code freeze"])
  ```
  - `diagrams`: the diagram types that need no graph layout: `Sequence` (`Actor`, `Message`, `Branch`), and more as they ship (see [Diagrams](diagrams.md)). Read-only.

**Trust.** Pack code runs inside your review pages, where notes and button presses also come from. Packs under `@austere-axi/` on npm install directly. Other npm packs and any `.tgz` need `--trust`, so read them first. A local folder counts as your own. A page with third-party packs shows a warning, and `poll` tells the agent.

Your trust list, `~/.austere-axi/trusted.json`, names npm packs your agent may install without `--trust`:

```sh
austere-axi trust add austere-pack-gantt@1.2.0   # pins that version and the hash of its pack.js
austere-axi trust add @acme                      # every pack in a scope on the current registry, e.g. your company's
austere-axi trust list
austere-axi trust remove @acme
```

- A pin trusts one exact version with the same `pack.js`. A later publish, or the same version with other code, still needs `--trust`. `components add <pack>` with no version installs the pinned one.
- A scope is bound to the registry it was added from: its private registry when the scope is mapped to one (see Private registries), else the default (`AUSTERE_AXI_NPM_REGISTRY`, else `npm_config_registry`, else npmjs). Pointed at another registry, packs in that scope are third-party again, since anyone may own the same scope name there.
- Search marks packs on the list `trusted` and tells the agent it may add them.
- `trust add` asks you to confirm at a terminal and refuses when stdin is not one, which is how agents run commands. That stops an agent adding a search hit to the list by accident. It does not stop an agent set on editing the file.
- Only this file in your home folder counts. A project cannot ship its own list.
- If the file is unreadable, search counts every npm pack third-party and says so, and `trust` refuses until you fix or delete it. `components add` refuses only the installs the list would decide: a third-party npm pack without `--trust`. First-party packs, local folders and `--trust` installs are unaffected.

**Private registries.** Packs your team publishes to Verdaccio, Artifactory or GitHub Packages are found and installed once you map their npm scope to that registry, in `~/.austere-axi/registries.json`:

```sh
austere-axi registry add @acme https://npm.acme.dev/ --token-env ACME_NPM_TOKEN
austere-axi registry list
austere-axi registry remove @acme
```

- `components search` and `show` query the default registry and each mapped one, with the same `austere-axi-pack` keyword search. A hit from a mapped registry names its host, e.g. `npm @acme/pack-flows@0.3.0 (npm.acme.dev), not installed, third-party`. If one registry does not answer, the others still do and the result says which one was unavailable.
- `components add @acme/<pack>` installs from @acme's registry. A mapped registry counts only for its own scope: packs it lists under other names are ignored, and the default registry's packs in that scope are left out.
- `--token-env` names an environment variable that holds a bearer token. The file stores the name, never the token. The token goes only to that registry's own origin, never to the default registry or to a tarball on another host.
- The URL must be https, or http on localhost. `@austere-axi` cannot be mapped.
- `registry add` runs only at a terminal, like `trust add`: a mapping decides which host receives the token, so an agent without a terminal is told to ask you. `registry remove` works anywhere.
- Mapping a scope grants no trust: its packs stay third-party until you trust the scope (`trust add @acme`, which records the mapped registry) or pin a pack.
- Only this file in your home folder counts. If it is unreadable, search covers the default registry only and says so, while `components add`, `trust add` and `registry` refuse until you fix it.

**Write a pack:** [Writing a pack](writing-a-pack.md) goes from scaffold to `npm publish`, with [austere-pack-gantt](https://github.com/MandalorianBatman/austere-pack-gantt) as the example. Short version:

```sh
austere-axi components new austere-pack-milestones
cd austere-pack-milestones && npm install && npm run build
austere-axi components add .
```

Each component uses `austereComponent` from `austere-axi/pack`: a PascalCase name, zod props in positional order (append-only after you publish), a one-line description and an example. The build loads the pack in Node, so build only code you trust.
