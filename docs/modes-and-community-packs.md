# Modes, token budgets and community packs: design

Status: Draft 2026-11-20, waiting for approval. Issue RLM-418. L1–L5 were settled with sid.kasat on RLM-418 on 2026-11-19 and 2026-11-20. C1–C12 are the designer's calls; the owner checks them while reading. Line numbers and names are from 0.14.1 (`f8488ab`).

## Why

[gtavi-claudecode](https://github.com/Bodila51/gtavi-claudecode) runs a whole job from 16 small skills. Each skill has a trigger-rich description, a short body with hard rules, and `references/*.md` that it reads only when needed. austere-axi already loads component detail on demand (`spec`, `spec <Group>`, `components search|show`). What it lacks:

1. **One look.** Every page is dark and dense. A newspaper-style brief or a lesson cannot look different.
2. **Weak for some content.** Core components do not serve number-heavy reports (trading, finance), math or learning well.
3. **No writing guidance per kind of page.** A pack gives signatures and group notes. It does not say "every number has a unit and a sign".
4. **One token level.** The agent always loads the lean reference. A user who wants a better page and accepts the cost cannot ask for more.
5. **Only the owner writes packs.** Others can publish a pack, but it is plain third-party and needs `--trust`.

## Goals

- A user or agent selects a **mode**: a pack that can carry components, a theme and a short brief.
- The agent loads only what a page needs. With no mode and the default budget, the agent loads what it loads today, plus one line per installed mode.
- A user can choose to spend more tokens for a better page (`rich` budget).
- The agent finds modes with `components search`, as it finds components now.
- First-party modes live in one GitHub repo, `austere-packs`, and ship through npm.
- Other people can send packs. A pack the owner reviewed installs without `--trust`, at the exact version and hash that was reviewed.

## Non-goals

- Agent-written HTML or CSS on a page.
- One skill per mode. Guidance stays in the CLI (AGENTS.md: the shipped skill is a stub).
- Themes for the hub and the review chrome. They stay dark.
- Live data on a page.

## Anti-goals (failure even if it works)

- The default `spec` grows by more than one line per installed mode.
- Community code gets first-party trust.
- A theme makes the review layer (selection, changed flash, note markers) hard to see.
- A page renders differently on two machines because a GitHub branch or tag moved.

## Decisions

### Locked (sid.kasat, RLM-418)

| # | Decision |
|---|---|
| L1 | A mode is a pack with three optional parts: components, a theme, a brief. Approach B below. |
| L2 | A user can choose to spend more tokens for a better page. |
| L3 | Agents find packs and modes with `components search`. Pack source is kept on GitHub. |
| L4 | Other people can send packs. |
| L5 | Distribution approach C: first-party modes in `austere-packs`, community packs through a reviewed index. |

### Designer's calls (check these)

| # | Call | Why |
|---|---|---|
| C1 | A mode has a default theme, and the agent applies it: `spec --mode` tells the agent to write `<meta name="austere-theme" content="<name>">`. The runtime never picks a theme by itself. A page can name another theme, for example a newspaper look with trading components. One page has one theme tag, so two modes cannot conflict. | The runtime cannot see `catalog.json` (it gets only what `pack.js` registers), so an implicit theme would need a pack-API change. An explicit tag keeps old pages and the runtime simple. |
| C2 | `rich` buys more guidance, every component signature and a self-check. It does not allow custom HTML or CSS. | Custom markup breaks the fixed look, small patches, statement-level notes and the sandbox rules. |
| C3 | Two budgets, `lean` and `rich`, not three. Selecting a mode already adds the mode's part on either budget. | The earlier `standard` level was just "lean + one mode", which `--mode` already gives. |
| C4 | Packs ship through npm only, never from a GitHub URL. | An npm version cannot change after publish. A branch or tag can. The page pins a hash. |
| C5 | The community index is published as the npm package `@austere-axi/pack-index`, built from `index/packs.json` in `austere-packs`. | Same trust path as every other first-party package. No new fetch host in the CLI. |
| C6 | New trust level `reviewed`. It covers one name and version, pinned by the `pack.js` hash and npm's whole-tarball `dist.integrity` (so `catalog.json`, which feeds the agent's prompt, is pinned too). It counts on the default registry only. The only things it changes: install without `--trust`, the notice text, and briefs printed in full. Every other third-party rule stays (`isThirdParty` callers: chrome restriction, server 409 on auto-queued render errors, `poll` caution). | Smallest step from third-party. Matches the per-registry rule in `trust.ts`. Keeps the anti-goal "community code gets first-party trust". |
| C7 | The default budget is stored in `<state>/preferences.json`, set from hub Settings or `austere-axi prefs set budget rich` at a terminal. An agent can pass `--budget rich` for one call but cannot change the default. | Matches `trusted.json` and `registries.json`: a home-folder file, terminal-only writes. |
| C8 | This note lives in `docs/`, like `docs/review-loop-v2.md`. | Existing convention for design contracts in this repo. |
| C9 | Briefs from third-party packs (installed with `--trust`, not reviewed) are labelled and clipped like third-party search text now (`src/cli/components.ts:205`), and `rich` leaves them out. | Pack text reaches the agent's prompt. Unreviewed text stays data, not instructions. |
| C10 | The index can list several reviewed versions of one name. `components add <name>`, search and `spec --mode` resolve to the newest reviewed version, not the newest on npm. `revoked` applies to one version. A revoked version keeps its install-time trust in `packs.json`; `check`, `poll` and `components add` report it. | An author's unreviewed release must not make a reviewed pack look third-party. |
| C11 | `spec --mode <name>` finds a mode that is not installed through the index only. The index lists first-party modes too. `spec` reads the cached index (24 h) and fetches it only when the cache is missing or old; offline it uses the cache or says the mode is unknown. Index CI refuses a mode name that another entry already uses. | `spec` makes no registry search. Mode names stay unique. |
| C12 | `rich` ships as an opt-in in stage 2, with no feature flag. The stage 6 benchmark reports tokens, time, cost and a model-judge rubric score for `lean`, `rich` and each mode. The owner decides from those numbers whether `rich` stays. | `rich` is never the default, so shipping it before the benchmark changes no existing page. |

## Approaches

### What a mode is (L1)

| | How | Trade-off | Pick |
|---|---|---|---|
| A. Mode = skill | One `austere-<mode>` skill each, the gtavi-claudecode way. | Easy to write. Installed copies go stale, every harness installs it again, breaks "guidance lives in the CLI". | No |
| B. Mode = pack + theme + brief | Add `mode` to the pack catalog. `spec --mode <name>` prints it. | Reuses packs, hashes, trust, npm search. Needs a theme layer in the runtime. | **Yes** |
| C. Theme switch only | `<meta name="austere-theme">`, no new components. | Smallest. Does not fix the weak number and math components. | No |

### Where packs live and who may send them (L4, L5)

| | How | Trade-off | Pick |
|---|---|---|---|
| A. One shared repo | Everyone sends PRs into `austere-packs`. All of it ships as `@austere-axi/…`. | Easy for users. The owner reviews and maintains all code forever. A missed bug runs as first-party. | No |
| B. Index only | Authors keep their own repo and npm name. A PR adds one line to an index. | Little upkeep. Each update needs a new review. | Part |
| C. Both | First-party modes in `austere-packs`; community packs through the index. | First-party stays code the owner wrote or fully owns. | **Yes** |

## Current state (0.14.1)

- **Reference.** `spec` prints `dist/prompt.md`, generated from `src/runtime/prompt.ts`. `spec <Group>` and `spec <pack>` print one part (`cmdSpec`, `src/cli/main.ts:1234`). The reference has a token budget, `PROMPT_BUDGET_TOKENS = 5950` (`test/library.test.ts:24`). Extended-tier components are left out of `spec` (`promptSpec`, `types/catalog.d.ts`).
- **Pack format.** `dist/pack.js` plus `dist/catalog.json` (`PackCatalog`, `types/catalog.d.ts`; `CATALOG_FORMAT` 1, `PACK_API` 1). `groups[].notes` is the only guidance slot. Pack CSS is added to the page once.
- **Page.** `<meta name="austere-packs">` names packs with version and SRI hash (`src/shared/packs-meta.ts`). The runtime loads them before render (`src/runtime/packs.ts`), from the review server when installed and matching, else from jsDelivr with SRI.
- **Trust.** First-party means a name under `@austere-axi/` installed from npm (`isFirstParty`, `src/cli/packs.ts:92`). `trustOf` returns `first-party`, `trust-list` or null (`src/cli/trust.ts:118`). Anything else needs `--trust`, and the page shows a warning that `poll` repeats.
- **Search.** `components search` reads core, installed packs, and the registry search for keyword `austere-axi-pack` (`src/cli/remote-packs.ts:55`).
- **Theme.** Tokens `--austere-*` and `--openui-*` sit on `:root, body` in `src/runtime/austere.css`. The same file holds the review layer. It has 99 hard-coded color values. CodeBlock uses `vscDarkPlus`; `oneLight` is already bundled (`src/runtime/highlighter-styles.ts`).

## Design

### 1. Catalog: the `mode` field

A pack's `catalog.json` gets an optional `mode` object. The change is additive, so `CATALOG_FORMAT` stays 1.

```ts
interface PackMode {
  name: string;          // "trading"; unique among installed packs
  summary: string;       // one line, max 100 chars; shown in `spec` and search
  triggers: string[];    // search words: "p&l", "portfolio", "earnings"
  brief: string[];       // writing rules for this kind of page; capped (see 6)
  theme: string | null;  // a theme the pack's CSS defines, or null
}
```

A pack can be components only (today), theme only, brief only, or any mix. `components build` in pack-kit validates the field.

### 2. Theme layer (runtime)

- A theme is a CSS block in a pack's CSS, scoped `html[data-austere-theme="<name>"]`, that sets only custom properties (`--austere-*`, `--openui-*`). `components build` refuses a theme block with any other declaration.
- The page selects a theme with `<meta name="austere-theme" content="<name>">`. With no tag, the page is the dark default (no change for old pages). The runtime never reads a mode's default theme; `spec --mode` tells the agent to write the tag (C1). The runtime sets `data-austere-theme` after packs load and before the first render.
- **Review tokens are separate.** The review layer moves to `--austere-review-*` tokens that a theme block cannot set (build check). The review layer keeps its contrast on any theme.
- **Hard-coded colors.** The 99 color values in `austere.css`, plus those in the custom components (Diff, Architecture, FileTree, Timeline), move to tokens before a light theme ships. CodeBlock picks `oneLight` when the theme declares `--austere-scheme: light`.
- `check` reports an unknown theme name (`unknown-theme`), as it reports a missing pack. `check --fix` keeps (or adds) in `austere-packs` the pack that defines the named theme, even when the program calls none of its components (`neededPacks`, `src/cli/packs.ts`, now only counts called components). Theme names are mode names, so they are unique (C11).
- `export` already inlines pack CSS, so themes export with no change.
- The hub, review chrome and `server.ts` shells keep `data-theme="dark"`.

### 3. CLI

**`spec` (lean, default).** Today's output, plus one line per installed mode:

```
## Modes
- trading: number-heavy reports, P&L, portfolios (`spec --mode trading`)
More: `austere-axi components search <topic>`.
```

**`spec --mode <name>`.** The lean reference, then the mode's brief, its component signatures and group notes, and the line to put in the head (`<meta name="austere-theme" …>`, plus "run `check --fix`" for the pack tag). If the mode is not installed:
- First-party, trust-listed or `reviewed`: the output tells the agent to run `components add <pack>` and run `spec --mode` again.
- Third-party: the output tells the agent to ask the user (unchanged rule).

**`--budget lean|rich`** on `spec`:
- `lean`: as above.
- `rich`: lean, plus every extended-tier component signature, plus the briefs of all installed modes when no `--mode` is given, plus a self-check rule: before you report the page, run `check`, then read your outline against the brief and the Size rule and patch what fails. The rule does not open, screenshot or inspect the page (skill rule stays).
- No flag: the default from `<state>/preferences.json` (C7), else `lean`.

**`prefs`.** `austere-axi prefs get|set budget <lean|rich>`. `set` needs a terminal, like `trust add`. Hub Settings gets a "Page budget" control that writes the same file over the owner-key API.

**`components search`.** Also matches `mode.name`, `summary` and `triggers`. A mode hit has `kind: "mode"` and names the next command (`spec --mode <name>`). Labels: first-party, `trusted`, `reviewed`, third-party.

**MCP.** The `spec` tool gets `mode` and `budget` arguments that map to the flags (`src/cli/mcp.ts`; no logic there).

**Skill.** `skills/austere/SKILL.md` description adds the trigger words ("trading report", "newspaper", "lesson", "math") and states that `/austere --rich <request>` means `spec --budget rich`. No guidance is copied into the skill.

### 4. `austere-packs` repo (first-party)

- New repo `MandalorianBatman/austere-packs`, npm workspaces, one folder per pack: `packs/trading`, `packs/newspaper`, then `packs/math`, `packs/learning`. Published as `@austere-axi/pack-<name>`.
- Each pack builds against `austere-axi/pack` only, like `austere-pack-gantt`.
- Release: a tag `pack-<name>@x.y.z` runs a GitHub Action that builds that pack and publishes it to npm with provenance.
- `CODEOWNERS`: the owner approves every change. Only the owner merges.
- `austere-pack-gantt` stays in its own repo.

First modes, from both ends (one number-heavy, one look-heavy). The component lists are proposals; the builder sets the final APIs:

| Mode | Theme | Components (proposal) | Brief (examples) |
|---|---|---|---|
| trading | dark, dense, tabular figures | `Kpi` (value, unit, signed delta, period), `NumTable` (right-aligned, sign colors, units in headers), `Sparkline` cell, `Waterfall` (P&L bridge), `Ohlc` | Every number has a unit and a sign. No chart without its table. Give the source and an as-of time. ISO dates. |
| newspaper | light paper, serif headings, columns | `Headline` (title, dek, byline, date), `Columns`, `PullQuote`, `Dateline` | Most important first. Headline max 10 words. One idea per column. |
| math (later) | default | `Equation` (KaTeX), `Proof` steps, `Theorem` box | Define every symbol before use. One step per line. |
| learning (later) | default | `Objectives`, `Quiz` (answers go back through the existing Form and `@ToAssistant`), `Flashcards`, `Recap` | State goals first. Every quiz question maps to one goal. |

### 5. Community index

- `austere-packs/index/packs.json`: entries `{ name, version, integrity, tarball, repo, mode?, reviewedBy, reviewedAt, status: "reviewed" | "revoked" }`. `integrity` is the `pack.js` hash; `tarball` is npm's `dist.integrity`. One entry per version (C10).
- A contributor keeps their own GitHub repo and npm name (with keyword `austere-axi-pack`) and opens a PR that adds one entry.
- `CONTRIBUTING.md` for packs: builds against `austere-axi/pack` only; no network calls, `eval`, `new Function`, dynamic `import()` or storage APIs; classes prefixed with the pack name; theme block sets tokens only; `pack.js` size limit (the builder sets it, about 50 KB gzipped); examples for every component; a mode brief within the cap.
- CI on each index PR: download the tarball from npm, check the `pack.js` hash against the entry, parse and validate `catalog.json` (including `mode`), run `check` on every example, check the size, run a static scan for the banned APIs. The scan is a hint; the owner's review decides.
- On merge, CI publishes `@austere-axi/pack-index` with a new version.
- CLI: reads the latest `@austere-axi/pack-index` from the default registry, caches it in `<state>/pack-index.json` for 24 h, and works from the cache when offline.
- `trustOf` returns `reviewed` when name, version, `pack.js` hash and tarball integrity match a `reviewed` entry, on the default registry (C6). A `reviewed` pack installs without `--trust`. Any version not in the index is third-party. `components add <name>` with no version installs the newest reviewed version (C10).
- The page notice for a reviewed pack says "community pack, reviewed" instead of the third-party warning; `poll` still names it.
- **Revoked** (one version): `components add` refuses it, `check` and `poll` report it, and the server keeps serving the installed copy so offline pages still open. Its trust in `packs.json` does not change (C10). The stricter option, stopping serving, is open for the owner.

### 6. Token limits (tests)

- `PROMPT_BUDGET_TOKENS` stays for the lean reference. A new test caps each mode line in `spec` (about 20 tokens).
- Each first-party brief: max about 600 tokens. Pack-kit warns over the cap; the index CI refuses it.
- `rich` gets its own cap (about 12k tokens, set by the builder from the first measurement).

### 7. Docs

`docs/components-and-packs.md` (modes, budgets, `reviewed`), `docs/writing-a-pack.md` (mode field, theme block, brief, how to send a pack to the index), `docs/security.md` (the `reviewed` level and revocation), `docs/cli.md`, README ("What it does not do yet: one look" goes), CHANGELOG.

## Stages

Each stage is one PR that can be merged and checked alone.

1. **Theme layer** (austere-axi): tokens for hard-coded colors, `--austere-review-*`, `austere-theme` meta, `unknown-theme` check, light CodeBlock. Proof: a test theme in a local pack renders light; the review layer stays readable (browser test).
2. **Modes and budgets** (austere-axi): catalog `mode`, `spec --mode`, `--budget`, `prefs`, Settings control, search for modes, MCP args, skill triggers, token tests.
3. **austere-packs with trading and newspaper** (new repo), after 1 and 2 are released.
4. **Community index** (both repos): `index/packs.json`, CI, `@austere-axi/pack-index`, `reviewed` trust level, CONTRIBUTING.
5. **math and learning modes** (austere-packs).
6. **Benchmark** (austere-axi `bench/`): the same pages at `lean`, `rich`, and with a mode: tokens, time, cost, and a quality score. `rich` stays only if it scores better.

## Risks

- **`@austere-axi` npm scope.** The CLI trusts every package under `@austere-axi/` by name. A public check on 2026-11-20 found no npm org of that name (`registry.npmjs.org/-/org/austere-axi/package` returned 404). If that is right, anyone can create it and publish first-party packs. Claim the org before stage 3. This risk exists today, apart from this design.
- **Light themes** need every hard-coded color moved to tokens. Stage 1 can grow.
- **Brief size creep.** Caps in tests and index CI.
- **KaTeX size** for the math mode (fonts and code). It may need fonts from jsDelivr with SRI, or a smaller renderer.
- **Review load.** Every community release needs a human review. The index pins one version, so updates queue behind the owner.
- **Pack CSS can already restyle anything inside the frame.** The theme-block check is a lint, not a security boundary. Review (first-party, index) is the boundary.

## Left to the builder

Component APIs and prop order, token names, exact caps and size limits, the Settings layout, CI details, and the format of the `reviewed` notice.
