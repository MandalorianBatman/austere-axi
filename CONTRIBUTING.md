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
- **User-facing behaviour** (CLI output, flags, the review page): update `README.md` in the same PR. Agents read `--help` and `spec`, so change those in `src/cli/main.js` and `src/runtime/prompt.js` when the workflow changes.

Before you open the PR:

```sh
npm run build
npm test
npm run typecheck
```

If you use a coding agent, `.agents/skills/review-change/SKILL.md` runs these checks and the review agents in `.agents/agents/`.

## Pull requests

- One change per PR, with a description of what changed and how you checked it. For a visual change, attach a screenshot at 1280 and 390 px wide (`npm run shot -- <page> --width 390`).
- CI runs on Node 22, 24 and 26 on Linux, Node 24 on Windows, and a headless-Chrome suite. All of it has to pass.
- Keep commits focused; the maintainer squashes or rebases on merge.

By contributing you agree that your work is released under the [MIT License](LICENSE).
