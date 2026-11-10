# AGENTS.md

austere-axi is a CLI, a local review server, and a browser runtime for agent review artifacts written in OpenUI Lang. This file keeps only the rules that apply to almost every change.

## Where things are owned

- **User-facing contract:** `README.md`.
- **What agents are told while using the tool:** CLI output: `--help` (`src/cli/main.js`), and `spec` (generated from `src/runtime/prompt.js`, the component files and `src/runtime/stock.js`).
- **Shipped skills:** `skills/austere/SKILL.md` stays a stub that points at the CLI, so don't copy CLI guidance into it. `skills/austere-setup/SKILL.md` walks an agent through setup; keep its commands in step with the CLI.
- **MCP server and Claude Code plugin:** `austere-axi mcp` (`src/cli/mcp.js`) runs the CLI as a child process for each tool call and returns its output; keep logic in the CLI commands, not there. A new tool argument maps to an existing CLI flag. `.claude-plugin/` holds the marketplace and plugin manifests; it lives in git, not in the npm package.
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
npm run site         # _site/: landing page + example gallery for GitHub Pages; needs Chrome or CHROME_PATH
npm run bench        # austere-axi vs lavish-axi benchmark (model keys from env); see docs/benchmark.md
npm run demo         # re-record docs/demo.{gif,mp4,webm} (after build; needs Chrome and ffmpeg)
npm run social       # re-render docs/social-preview.png, 1200x630 (after build; needs Chrome)
```

## Rules

- Released component props are positional and append-only (`test/fixtures/signatures.json`).
- Third-party packs build against `src/runtime/pack-api.js` (what `austere-axi/pack` exports) and the catalog format in `src/shared/catalog.js`. Change either additively; a breaking change bumps `PACK_API` or `CATALOG_FORMAT`.
- The component reference has a token budget (`test/library.test.js`). Raise it only deliberately.
- The served artifact must equal the file on disk, except for the runtime `<script>` tag.
- The server binds to loopback, plus the Tailscale IP when Tailscale is up, and never to `0.0.0.0`.
  - `/api/*` answers loopback callers only, and only with the owner key (`x-austere-key`), except `/api/health`.
  - Loopback is not the owner; the owner key (header) or the cookie derived from it is. Never put the key on a command line, in printed output, or in a cookie; browsers sign in with a single-use login code.
  - Browser POST routes reject a foreign `Origin`.
  - Artifact files are served from the artifact's own directory only, with no dotfiles.
- Tests that start the server, or read packs or the hub, set `AUSTERE_AXI_STATE_DIR` and use an ephemeral port.
- Nothing an installed pack ships runs in the CLI or the server; its code runs only in the sandboxed artifact frame. (`components build` does load the pack being built, in Node, to read its components.)
- Only `dist`, `skills`, `README.md` and `LICENSE` are published (`package.json` `files`). `.agents/`, `.dev/`, `bench/`, `docs/`, `scripts/` and `test/` are maintainer-only.
- The website lives in `site/` (hand-written) and `examples/` (gallery source), built to `_site/` by `scripts/site.mjs` and deployed by `.github/workflows/pages.yml`. Keep links relative (the site is served under `/austere-axi/`) and keep `site/` out of `package.json` `files`.
- The playground (`site/play/`) runs `src/shared/check-program.js`, `src/shared/feedback.js` and `src/shared/statements.js` in the browser, and the artifact frame over the review bridge in `src/runtime/index.jsx`. Keep those shared modules free of Node APIs; if a bridge message changes, change `site/play/play.js` with it.
