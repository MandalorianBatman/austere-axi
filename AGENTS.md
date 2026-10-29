# AGENTS.md

austere-axi is a CLI, a local review server, and a browser runtime for agent review artifacts written in OpenUI Lang. This file keeps only the rules that apply to almost every change.

## Where things are owned

- **User-facing contract:** `README.md`.
- **What agents are told while using the tool:** CLI output: `--help` (`src/cli/main.js`), and `spec` (generated from `src/runtime/prompt.js`, the component files and `src/runtime/stock.js`).
- **Shipped skill:** `skills/austere/SKILL.md`. It stays a stub that points at the CLI, so don't copy CLI guidance into it.
- **Adding or changing a component:** follow `.agents/skills/add-component/SKILL.md`.
- **Reviewing a change before committing:** follow `.agents/skills/review-change/SKILL.md`. It runs the checks and the agents in `.agents/agents/` (change-reviewer, visual-qa, cold-start-author).

## Commands

```sh
npm run build        # dist/: runtime, packs, pack-kit, mermaid, spec.json, prompt.md, catalog.json, chrome, cli.mjs
npm test             # rebuilds spec first; unit, server loop, and library guards
npm run test:browser # real review loop in headless Chrome: render checks + every part annotatable
npm run signatures   # record new component signatures (refuses breaking changes)
npm run gallery      # .dev/gallery.html with every custom component's example
npm run shot -- <page> [--width 390] [--full] [--parts]   # needs Chrome or CHROME_PATH
```

## Rules

- Released component props are positional and append-only (`test/fixtures/signatures.json`).
- Third-party packs build against `src/runtime/pack-api.js` (what `austere-axi/pack` exports) and the catalog format in `src/shared/catalog.js`. Change either additively; a breaking change bumps `PACK_API` or `CATALOG_FORMAT`.
- The component reference has a token budget (`test/library.test.js`). Raise it only deliberately.
- The served artifact must equal the file on disk, except for the runtime `<script>` tag.
- The server binds to loopback, plus the Tailscale IP when Tailscale is up, and never to `0.0.0.0`.
  - `/api/*` answers loopback callers only.
  - Browser POST routes reject a foreign `Origin`.
  - Artifact files are served from the artifact's own directory only, with no dotfiles.
- Tests that start the server, or read packs or the hub, set `AUSTERE_AXI_STATE_DIR` and use an ephemeral port.
- Nothing a pack ships runs in the CLI or the server; pack code runs only in the sandboxed artifact frame.
- Only `dist`, `skills`, `README.md` and `LICENSE` are published (`package.json` `files`). `.agents/`, `.dev/`, `scripts/` and `test/` are maintainer-only.
