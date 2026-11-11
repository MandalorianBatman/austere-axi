# Contributing to austere-axi

Bug reports, examples, docs fixes, component packs and code are all welcome. Issues labelled [`good first issue`](https://github.com/MandalorianBatman/austere-axi/labels/good%20first%20issue) are small and have a clear finish line; comment on one before you start so two people don't take it.

## Reporting a bug

Open an issue with:

- `npx -y austere-axi --version`, your OS, and `node --version` (22.18 or later is required).
- The page that shows the problem (the `.html` file, or the smallest OpenUI Lang program that still fails).
- What the CLI printed. For a review-page problem, the browser and a screenshot help.

Security problems: do not open a public issue. Use [private vulnerability reporting](https://github.com/MandalorianBatman/austere-axi/security/advisories/new).

## Setting up

```sh
git clone https://github.com/MandalorianBatman/austere-axi
cd austere-axi
npm ci
npm run build
npm test
```

`npm run test:browser`, `npm run gallery` and `npm run shot` need Chrome, or `CHROME_PATH` pointing at a Chrome or Chromium binary. Run the CLI you just built with `node dist/cli.mjs <command>`.

## Making a change

[`AGENTS.md`](AGENTS.md) lists the commands and the rules that apply to almost every change: which file owns what, how component props evolve, what the server may bind to, and what gets published. Read it first; it is short. It applies to people too.

- **A new component** in core: follow `.agents/skills/add-component/SKILL.md`. Released props are positional and append-only, and the component reference has a token budget, so most new components belong in a pack instead.
- **A new pack:** you do not need a PR here. Build it in your own repo against `austere-axi/pack` (see [`docs/writing-a-pack.md`](docs/writing-a-pack.md), and [austere-pack-gantt](https://github.com/MandalorianBatman/austere-pack-gantt) as a worked example), publish it to npm, then open an issue so we can link it.
- **User-facing behaviour** (CLI output, flags, the review page): update `README.md` in the same PR. Agents read `--help` and `spec`, so change those in `src/cli/main.ts` and `src/runtime/prompt.ts` when the workflow changes.

Before you open the PR:

```sh
npm run build
npm test
npm run typecheck
```

If you use a coding agent, `.agents/skills/review-change/SKILL.md` runs these checks and the review agents in `.agents/agents/`.

## Repository layout

| Path | Contents |
|---|---|
| `src/runtime/components/` | Custom components (`Architecture` family, `Diff`, `FileTree`), one file each |
| `src/runtime/stock.ts` | Which stock components ship, which stay out of `spec`, their groups |
| `docs/` | [Writing a pack](docs/writing-a-pack.md) |
| `packs/` | Packs bundled with austere-axi (`mermaid`, `shadcn`) |
| `src/runtime/pack-api.ts`, `src/pack-kit/` | `austere-axi/pack` and the `components build` pipeline |
| `src/shared/catalog.ts` | Component catalog and prompt tiers |
| `src/runtime/` | Library, annotation layer, review bridge, styles |
| `src/chrome/` | Review UI around the page iframe |
| `src/cli/` | CLI, server, sessions, `check`, `export`, packs, hub |
| `action/` | The [GitHub Action](README.md#github-action) (not published to npm) |
| `skills/` | Published skills: `austere`, `austere-setup` |
| `.claude-plugin/` | Claude Code marketplace and plugin manifest (in git, not in the npm package) |

Maintainer guides (not published): [`AGENTS.md`](AGENTS.md), [`.agents/skills/add-component`](.agents/skills/add-component/SKILL.md) to add a component, [`.agents/skills/review-change`](.agents/skills/review-change/SKILL.md) before you commit. Tests enforce the component rules: every component has a group, `spec` stays in its token budget, released prop orders are append-only (`npm run signatures`), and every example passes `check`.

**Visual checks:** `npm run gallery`, `npm run shot`, and `npm run test:browser` (real review loop in headless Chrome; needs Chrome or `CHROME_PATH`).

**Website:** `npm run site` builds `_site/` (needs Chrome or `CHROME_PATH`). `site/` holds the hand-written pages and CSS, `examples/` feeds the gallery (add a file there and it appears with a generated thumbnail), `scripts/site.ts` builds `_site/`, and `.github/workflows/pages.yml` deploys it to GitHub Pages on every push to `main`. Examples need a `<meta name="description">` for the gallery blurb. None of it is published to npm.

**Playground** (`/play/`, source in `site/play/`): a textarea editor beside a sandboxed frame running `dist/austere.js`. It plays the part of the review chrome over the same `postMessage` bridge, so edits re-render in place and clicks arrive as the annotations `poll` prints. Problems come from `src/shared/check-program.ts`, the same code as `austere-axi check`, bundled for the browser by `scripts/site.ts` (with the spec, the component catalog and one template per example in `play/data.json`). The program travels in the URL hash (`#code=v1.<deflate-raw, base64url>`), so there is no server. `test/browser/play.browser.test.ts` drives it in headless Chrome as part of `npm run test:browser`. Packs other than the bundled ones are not available there.

**Benchmark** against lavish-axi: `npm run bench` (needs model keys; see [docs/benchmark.md](docs/benchmark.md)). `npm run bench:report` rebuilds its tables from the committed results.

**CI** builds and tests every push to `main` and every pull request (Node 22, 24, 26 on Linux; Node 24 on Windows; browser suite). `action.yml` runs the GitHub Action on fixture pages (`test/fixtures/action/`).

**Release:** bump `version` in `package.json`, push, and publish a GitHub Release. `publish.yml` tests again and publishes to npm with trusted publishing.

## Pull requests

- One change per PR, with a description of what changed and how you checked it. For a visual change, attach a screenshot at 1280 and 390 px wide (`npm run shot -- <page> --width 390`).
- CI runs on Node 22, 24 and 26 on Linux, Node 24 on Windows, and a headless-Chrome suite. All of it has to pass.
- Keep commits focused; the maintainer squashes or rebases on merge.

By contributing you agree that your work is released under the [MIT License](LICENSE).
