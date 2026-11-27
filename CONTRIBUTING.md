# Contributing to austere-axi

Bug reports, examples, docs fixes, component packs and code are welcome.

- Issues labelled [`good first issue`](https://github.com/MandalorianBatman/austere-axi/labels/good%20first%20issue) are small with a clear finish line. Comment on one before starting so two people don't take it.
- Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Accessibility barriers are bugs: see [ACCESSIBILITY.md](ACCESSIBILITY.md).

## Reporting a bug

Open an issue with:

- `npx -y austere-axi --version`, your OS, and `node --version` (22.18 or later required).
- The page that shows the problem (the `.html` file, or the smallest OpenUI Lang program that still fails).
- What the CLI printed. For a review-page problem, the browser and a screenshot.

Security problems: no public issue. Use [private vulnerability reporting](https://github.com/MandalorianBatman/austere-axi/security/advisories/new).

## Setting up

```sh
git clone https://github.com/MandalorianBatman/austere-axi
cd austere-axi
npm ci
npm run build
npm test
```

- `npm run test:browser`, `npm run gallery` and `npm run shot` need Chrome, or `CHROME_PATH` pointing at Chrome or Chromium.
- `npm run test:browser` also needs Firefox for one engine-specific check: `npx playwright-core install firefox`, or `FIREFOX_PATH`.
- Run your build with `node dist/cli.mjs <command>`, e.g. `node dist/cli.mjs examples/session-migration.html`.
- From a checkout, state lives in `.dev/state` and the server uses its own port, not your installed `~/.austere-axi` and 4388. Set `AUSTERE_AXI_STATE_DIR` to a scratch dir to choose one ([Environment](docs/cli.md#environment)).

## Making a change

Read [`AGENTS.md`](AGENTS.md) first (it is short and applies to people too): commands, file ownership, how component props evolve, what the server may bind to, what gets published.

- **New core component:** follow `.agents/skills/add-component/SKILL.md`. Released props are positional and append-only, and the component reference has a token budget, so most new components belong in a pack.
- **New pack:** no PR needed. Build it in your own repo against `austere-axi/pack` ([Writing a pack](docs/writing-a-pack.md); worked example: [austere-pack-gantt](https://github.com/MandalorianBatman/austere-pack-gantt)), publish to npm, then open an issue so we can link it.
- **User-facing behaviour** (CLI output, flags, review page): update the matching guide in [`docs/`](docs/README.md) in the same PR, and `README.md` when it changes what a reviewer sees or how they start. Agents read `--help` and `spec`: update `src/cli/main.ts` and `src/runtime/prompt.ts` when the workflow changes.

Before opening the PR:

```sh
npm run build
npm test
npm run typecheck
npm run lint
npm run format:check   # npm run format fixes it
```

With a coding agent, `.agents/skills/review-change/SKILL.md` runs these checks and the review agents in `.agents/agents/`.

## Repository layout

| Path | Contents |
|---|---|
| `src/runtime/components/` | Custom components (`Architecture` family, `Diff`, `FileTree`), one file each |
| `src/runtime/stock.ts` | Which stock components ship, which stay out of `spec`, their groups |
| `docs/` | User guides ([index](docs/README.md)), [Writing a pack](docs/writing-a-pack.md), benchmark, sync protocol |
| `packs/` | Packs bundled with austere-axi (`shadcn`) |
| `src/runtime/pack-api.ts`, `src/pack-kit/` | `austere-axi/pack` and the `components build` pipeline |
| `src/shared/catalog.ts` | Component catalog and prompt tiers |
| `src/runtime/` | Library, annotation layer, review bridge, styles |
| `src/chrome/` | Review UI around the page iframe |
| `src/cli/` | CLI, server, sessions, `check`, `export`, packs, hub |
| `action/` | The [GitHub Action](docs/github-action.md) (not published to npm) |
| `skills/` | Published skills: `austere`, `austere-setup` |
| `.claude-plugin/` | Claude Code marketplace and plugin manifest (in git, not in the npm package) |

- **Maintainer guides** (not published): [`AGENTS.md`](AGENTS.md); [`.agents/skills/add-component`](.agents/skills/add-component/SKILL.md) to add a component; [`.agents/skills/review-change`](.agents/skills/review-change/SKILL.md) before committing.
- **Tests enforce component rules:** every component has a group, `spec` stays in its token budget, released prop orders are append-only (`npm run signatures`), every example passes `check`.
- **Visual checks:** `npm run gallery`, `npm run shot`, `npm run test:browser` (real review loop in headless Chrome; needs Chrome or `CHROME_PATH`).

### Website

`npm run site` builds `_site/`. Needs Chrome or `CHROME_PATH`, and the npm registry (the footer shows npm's latest version, not `package.json`'s). None of it is published to npm.

- `site/`: hand-written pages and CSS.
- `examples/`: feeds the gallery; a new file appears with a generated thumbnail. Examples need `<meta name="description">` for the blurb.
- `docs/*.md`: become `/docs/` pages; the next push to `main` publishes edits. The build fails on a broken link.
- `scripts/site.ts`: builds `_site/`.
- `.github/workflows/pages.yml`: deploys to GitHub Pages on every push to `main` and after each npm release.

### Playground

`/play/`, source in `site/play/`: a textarea editor beside a sandboxed frame running `dist/austere.js`.

- Acts as the review chrome over the same `postMessage` bridge: edits re-render in place; clicks arrive as the annotations `poll` prints.
- Problems come from `src/shared/check-program.ts` (same code as `austere-axi check`), bundled by `scripts/site.ts` with the spec, the component catalog and one template per example in `play/data.json`.
- The program travels in the URL hash (`#code=v1.<deflate-raw, base64url>`); no server.
- `test/browser/play.browser.test.ts` drives it in headless Chrome as part of `npm run test:browser`.
- Only bundled packs are available.

### Benchmark, CI, release

- **Benchmark** vs lavish-axi: `npm run bench` (needs model keys; see [docs/benchmark.md](docs/benchmark.md)). `npm run bench:report` rebuilds its tables from committed results.
- **CI** builds and tests every push to `main` and every PR: Node 22, 24, 26 on Linux; Node 24 on Windows; browser suite. `action.yml` runs the GitHub Action on fixture pages (`test/fixtures/action/`).
- **Release:** bump `version` in `package.json`, date its entry in [`CHANGELOG.md`](CHANGELOG.md), push, and publish a GitHub Release whose notes are that entry. `publish.yml` tests again and publishes to npm with trusted publishing; `pages.yml` then redeploys the site.

## Pull requests

- One change per PR, describing what changed and how you checked it. Visual change: attach screenshots at 1280 and 390 px wide (`npm run shot -- <page> --width 390`).
- All CI (Node 22, 24, 26 on Linux, Node 24 on Windows, headless-Chrome suite) must pass.
- Keep commits focused; the maintainer squashes or rebases on merge.

By contributing you agree your work is released under the [MIT License](LICENSE).
