---
name: review-change
description: Test and review an austere-axi change before it is committed or merged — runs the mechanical checks, launches the change-reviewer, visual-qa and cold-start-author agents as needed, and triages their findings. Maintainer-only (not shipped).
user-invocable: true
metadata:
  internal: true
---

# Reviewing a change to austere-axi

Use this skill before committing a non-trivial change, or when asked to review a branch.

Mechanical checks run as code, because they are cheap and can't be talked out of a failure. Judgment comes from separate agents. They run in fresh contexts, so they are not anchored on how the change was made. Your job is to scope the change, brief the agents, and decide what to do with their findings.

## 1. Scope

```sh
git merge-base HEAD main      # base, unless you were given one
git diff --stat <base>        # includes uncommitted work
```

Classify the changed files:

| Area | Paths |
|---|---|
| components | `src/runtime/components/`, `src/runtime/stock.js`, `src/runtime/define.js`, `test/fixtures/signatures.json` |
| look | `src/runtime/austere.css`, `src/chrome/` |
| runtime | other `src/runtime/` |
| agent-facing text | `src/runtime/prompt.js`, the help text in `src/cli/main.js`, component descriptions and notes |
| cli/server | other `src/cli/` |
| docs/tooling | everything else |

## 2. Mechanical checks (always)

```sh
npm run build && npm test
npm run test:browser      # when components, look or runtime changed
```

`test:browser` needs Chrome, or `CHROME_PATH` pointing at a browser. If neither is available, say so in the report; do not silently skip it.

Fix every failure before launching any agent. Agents are slow and cost tokens, so don't spend them on a red build.

## 3. Launch the agents

Launch every relevant agent at once, in parallel. Only launch the ones the change needs:

| Changed | change-reviewer | visual-qa | cold-start-author |
|---|---|---|---|
| components | yes | yes | yes |
| look | yes | yes | |
| agent-facing text | yes | | yes |
| runtime, cli/server | yes | | |
| docs/tooling only | | | |

For a docs- or tooling-only change, read it yourself; no agent is needed.

Give each agent only these inputs:

- **change-reviewer:** the base ref, a head ref if you are reviewing a range, and the list of changed files.
- **visual-qa:** the changed component names, plus any pages under `examples/` that use them.
- **cold-start-author:** an output path under `.dev/cold-start/`, and a scenario: a realistic user request in which the changed component is the natural choice. **Do not name the component.** Whether the agent finds it is part of the test. For an agent-facing text change, choose a scenario that exercises the changed instruction.

Leave out your own assessment, what you think is fine, the commit message's claims, and why you made each decision. An agent handed your conclusions tends to return them confirmed.

**How to launch:**

- **Claude Code:** the agents live in `.claude/agents/`, symlinked to `.agents/agents/`. Use them as subagent types `change-reviewer`, `visual-qa` and `cold-start-author`.
- **Other harnesses:** start a fresh session or subagent per agent, give it the body of `.agents/agents/<name>.md` plus its inputs, and restrict it to the tools listed in the file's frontmatter where the harness allows.

## 4. Triage

Agents report confidently whether they are right or wrong. Before acting on a finding, verify it yourself: read the cited line, or reproduce the scenario.

- **Blockers and should-fix:** fix them, or decline in writing with the reason (the finding was wrong, or the fix would be out of scope).
- **Nits:** fix them if they are cheap, otherwise drop them.
- **cold-start-author:**
  - It did not pick the changed component for a scenario that needed it: the description or the group notes failed.
  - It picked the component but misused it: the call design or the description failed.
  - It needed several fix rounds: the first `check` output tells you which instruction was missing.

  Fix the docs, not the scenario.
- **Disagreements:** if change-reviewer and visual-qa disagree, the rules in `AGENTS.md` and the add-component skill decide. If the rules are silent, decide yourself and record the decision.

After fixes, re-run the mechanical checks. Re-run an agent only when a fix changed what that agent judged (for example, a reworked component design); individual fixes don't need it.

## 5. Report

Write one short block for the user, and put the same summary in the commit message:

```
Reviewed:
  tests: npm test ✓, test:browser ✓ (or: not run — no browser)
  change-reviewer: ship after fixes — 1 should-fix fixed, 1 nit declined (reason)
  visual-qa: looks right after 2 fixes
  cold-start-author: picked FileTree unprompted, 0 fix rounds; 1 doc fix
```
