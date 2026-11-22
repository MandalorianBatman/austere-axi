# AGENTS.md

austere-axi is a CLI, a local review server, and a browser runtime for agent review artifacts written in OpenUI Lang. This file keeps only the rules that apply to almost every change.

## Where things are owned

- **User-facing contract:** the guides in `docs/` (`docs/README.md` lists them). `README.md` is the product page for people who do not read flags: what it is, how to use it, how to start. Keep it plain and put reference detail in `docs/`.
- **What agents are told while using the tool:** CLI output: `--help` (`src/cli/main.ts`), and `spec` (generated from `src/runtime/prompt.ts`, the component files and `src/runtime/stock.ts`).
- **Shipped skills:** `skills/austere/SKILL.md` stays a stub that points at the CLI, so don't copy CLI guidance into it. The one exception is its line that the agent must not open, screenshot or inspect the page unless asked: it has to override a harness's "verify UI visually" rule before the agent reads the CLI. `skills/austere-setup/SKILL.md` walks an agent through setup; keep its commands in step with the CLI. Neither installs anything (no `npx`, `npm install`, `skills add`; `test/skills.test.ts`): they run the `austere-axi` the user installed, and installing lives in `README.md`, `docs/install.md` and the site.
- **MCP server and Claude Code plugin:** `austere-axi mcp` (`src/cli/mcp.ts`) runs the CLI as a child process for each tool call and returns its output; keep logic in the CLI commands, not there. A new tool argument maps to an existing CLI flag. `.claude-plugin/` holds the marketplace and plugin manifests; it lives in git, not in the npm package.
- **Review loop v2 (projects, inbox, attach, history, dashboard, wiki):** `docs/review-loop-v2.md` is the contract for RLM-332 to RLM-367: its decisions, data model, CLI changes and security rules. Change the note first when a build issue departs from it.
- **Adding or changing a component:** follow `.agents/skills/add-component/SKILL.md`.
- **Reviewing a change before committing:** follow `.agents/skills/review-change/SKILL.md`. It runs the checks and the agents in `.agents/agents/` (change-reviewer, visual-qa, cold-start-author).

## Commands

```sh
npm run build        # dist/: runtime, packs, pack-kit, spec.json, prompt.md, catalog.json, chrome, cli.mjs
npm test             # rebuilds spec first; unit, server loop, and library guards
npm run typecheck    # tsc over every source, script and test (strict)
npm run test:browser # real review loop in headless Chrome (one hover check also in Firefox): render checks + every part annotatable
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
- Third-party packs build against `src/runtime/pack-api.ts` (what `austere-axi/pack` exports) and the catalog format in `src/shared/catalog.ts`. Change either additively; a breaking change bumps `PACK_API` or `CATALOG_FORMAT`.
- austere-cloud builds against `austere-axi/sync` (`src/shared/sync.ts`, typed by `types/sync.d.ts`). Change it additively and bump `SYNC_VERSION`, by the rules in `docs/hosted-share-links.md` ("Versioning and compatibility"). Keep it free of Node APIs; the chrome and the Worker run it too.
- The component reference has a token budget (`test/library.test.ts`). Raise it only deliberately.
- The served artifact must equal the file on disk, except for the runtime `<script>` tag.
- The server binds to loopback, plus the Tailscale IP when Tailscale is up, plus one local-network address when the owner switches it on (`server lan`, Settings), and never to `0.0.0.0`.
  - `/api/*` answers loopback callers only, and only with the owner key (`x-austere-key`), except `/api/health`.
  - Loopback is not the owner; the owner key (header) or the cookie derived from it is. Never put the key on a command line, in printed output, or in a cookie; browsers sign in with a single-use login code.
  - Browser POST routes reject a foreign `Origin`.
  - Which listener accepted a connection decides what it may do (`via` in `src/cli/server.ts`), never what the request says. `tailscale whois` is asked only for connections accepted on the tailnet listener, with the socket's own remote address; never from a header (`Tailscale-User-*`, `X-Forwarded-For`). `tailscale` missing or failing, or a tagged device, means unknown, not an error.
  - An address or hostname is a label for the owner, never a credential.
  - The local-network listener serves reviewers only: owner sign-in, the owner's key link, the owner cookie, the hub and `/api/*` answer 403 there, and no link that carries the owner key points at it.
  - Artifact files are served from the artifact's own directory only, with no dotfiles.
  - The frame's subresources send no cookie (opaque origin), so the frame's URL carries a per-viewer token, `/s/:id/a/<token>/<file>` (`assetToken` in `src/cli/server.ts`). It opens only what that route already serves; keep `allow-same-origin` out of the sandbox. `export` reads sibling images through the same `resolveSibling` rules (`src/cli/assets.ts`).
- Any run of the CLI from a checkout sets `AUSTERE_AXI_STATE_DIR` to a scratch dir: tests, scripts, and commands you run by hand or from an agent. Tests that start the server also use an ephemeral port. Without the variable a checkout falls back to `.dev/state` and a port of its own (`src/cli/paths.ts`), never `~/.austere-axi` and 4388, but name the dir anyway. `test/dev-state.test.ts` fails when a test or script runs the CLI without it.
- A change to hub.db's schema goes in `migrate()` (`src/cli/hub.ts`), additive, and raises `SCHEMA_VERSION`.
- Nothing an installed pack ships runs in the CLI or the server; its code runs only in the sandboxed artifact frame. (`components build` does load the pack being built, in Node, to read its components.)
- Only `dist`, `skills`, `README.md` and `LICENSE` are published (`package.json` `files`). `.agents/`, `.dev/`, `bench/`, `scripts/` and `test/` are maintainer-only. `docs/` holds the user guides, read on GitHub and not shipped in the npm package.
- The website lives in `site/` (hand-written), `examples/` (gallery source) and `docs/*.md` (rendered to `_site/docs/` with `marked`; relative `.md` links become `.html`, and the build fails on a broken internal link or #fragment), built to `_site/` by `scripts/site.ts` and deployed by `.github/workflows/pages.yml`. Keep links relative (the site is served under `/austere-axi/`) and keep `site/` out of `package.json` `files`.
- The playground (`site/play/`) runs `src/shared/check-program.ts`, `src/shared/feedback.ts` and `src/shared/statements.ts` in the browser, and the artifact frame over the review bridge in `src/runtime/index.tsx`. Keep those shared modules free of Node APIs; if a bridge message changes, change `site/play/play.ts` with it.
- Sources are strict TypeScript (`tsconfig.json`; `npm run typecheck`): no `any`; only erasable syntax (Node runs `.ts` directly), so no `enum`, `namespace` or parameter properties; relative imports name the `.ts`/`.tsx` file; type-only imports use `import type`.
