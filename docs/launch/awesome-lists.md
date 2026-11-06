# Awesome-list submissions

Prepared 2026-11-06. Every list state, rule, heading and neighbour entry below was read from the list's own README / CONTRIBUTING / templates / workflows on 2026-11-06 (GitHub API, default branch). Nothing has been opened, forked, starred or commented on; the maintainer submits each one by hand.

State of austere-axi when this was checked (2026-11-06):

- Repo: 1 star, created 2026-10-26, first commit on `main` 2026-10-25, MIT detected by GitHub.
- npm `latest` is 0.4.1. It has no `mcp` command. Every MCP entry waits for the next release.
- `main` has `skills/austere/SKILL.md` (frontmatter has `name` and `description`). It does not have `.claude-plugin/` or `action/` yet, so the plugin install commands and the GitHub Action only work after the release branch merges.
- The site https://mandalorianbatman.github.io/austere-axi/ returned 404. None of the lines below link to it, so it blocks nothing.
- `https://glama.ai/mcp/servers/MandalorianBatman/austere-axi` returned 404, so the server is not listed on Glama.
- No list below already mentions austere-axi or lavish-axi.

| # | List | Method | Section | Prerequisite / blocker |
|---|------|--------|---------|------------------------|
| 1 | hesreallyhim/awesome-claude-code | Issue form, web UI only | Design & UI/UX | Submit on or after 2026-11-09 (14 days after first commit, or 100 stars). Plugin must be on `main` first. |
| 2 | punkpeye/awesome-mcp-servers | PR | 💻 Developer Tools | Needs 0.5.0 on npm with `mcp`. Needs a Glama listing that passes Glama's checks, plus the score badge. |
| 3 | kyrolabs/awesome-agents | PR (bottom of section) | Software Development | Their bot auto-closes "brand new repo with no history" and repos with no traction. Wait for some stars. |
| 4 | heilcheng/awesome-agent-skills | PR (end of category) | Community Skills > Development and Testing | Hard rule: at least 20 stars and repo older than 14 days. Below 20 stars the PR is put on hold. |
| 5 | VoltAgent/awesome-agent-skills | PR (end of category) | Community Skills > Development and Testing | "Brand new skills ... are not accepted." Needs visible community usage. |
| 6 | jamesmurdza/awesome-ai-devtools | PR, template checked by a bot | Terminal > CLI Utilities | No merge since 2026-06-29; 100+ open PRs. Low odds, no hard gate. |
| 7 | ai-for-developers/awesome-ai-coding-tools | PR | Code Review and Refactoring | Merges in batches (last batch 2026-09-18); 100+ open PRs. No hard gate. |
| 8 | mcpservers.org (wong2/awesome-mcp-servers) | Website form | Category "Development" | Needs 0.5.0 on npm with `mcp`. The repo README says "We do not accept PRs." |

Dropped:

- e2b-dev/awesome-ai-agents (30,822 stars, pushed 2026-08-21): a directory of AI agents, and austere-axi is a tool, not an agent. The only PR merged since 2026-08-01 is the owner's docs change (#1419); recent submission PRs (#1925, #1923, #1917, ...) were closed without merging.
- travisvn/awesome-claude-skills (15,727 stars): last push 2026-04-28, more than 6 months ago; last merged PR #29 on 2026-01-07.
- ComposioHQ/awesome-claude-skills (78,940 stars, pushed 2026-09-18): no PR merged since 2026-05-22.
- appcypher/awesome-mcp-servers and agarrharr/awesome-cli-apps: archived.
- Shubhamsaboo/awesome-llm-apps: a repo of runnable app tutorials with code in the repo, not a link list. Recent merges are code fixes.
- jqueryscript/awesome-claude-code (544 stars): its "Contribution Guidelines" section says only "Under Construction". The owner adds entries in batches himself, so there is no submission path.
- ccplugins/awesome-claude-code-plugins (998 stars, last push 2026-08-12): the repo has a `plugins/` directory and a `.claude-plugin` marketplace, so entries look like vendored plugin sources rather than link lines `[INFERENCE]`. Worth a second look after the plugin ships.
- joho/awesome-code-review: last push 2024-09-09.

---

## 1. hesreallyhim/awesome-claude-code

- URL: https://github.com/hesreallyhim/awesome-claude-code
- Observed 2026-11-06: 57,403 stars, last push 2026-11-06, not archived.
- Method: the web UI issue form only: https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml . CONTRIBUTING says "Do not open a PR", "It is **not** possible to submit a resource recommendation using the `gh` CLI", and recommendations "must be created by human beings".
- Rules from CONTRIBUTING / the form:
  - The resource must be at least 14 days old with commits after the first day, or have at least 100 stars. Failing entries are closed automatically. The first commit on `main` is 2026-10-25, so the earliest safe date is 2026-11-09.
  - One resource at a time.
  - The description must describe what the software does, not pitch it. Do not address the reader. One line. No emojis. 1-3 sentences, 10-500 characters.
  - Resources should be specific to Claude Code. Lead with the plugin and skill.
- Section: `## Design & UI/UX` (form dropdown value `Design & UI/UX`). The closest existing entries are in this section: `Snip`, `Pinpoint`, `visual-explainer`.
- Neighbour entry, copied from the README (a bot renders the line and adds a badge row under it):

  ```markdown
  - [visual-explainer](https://github.com/nicobailon/visual-explainer) by [nicobailon](https://github.com/nicobailon) - Agent skill and plugin that turns complex terminal output into styled HTML pages or slide decks for diagrams, diff reviews, plan audits, data tables, and project recaps. Generates self-contained browser-readable artifacts with Mermaid diagrams, responsive layouts, themes, and sharing commands.  
  ```

- Form field values:
  - Display Name: `austere-axi`
  - Category: `Design & UI/UX`
  - Link: `https://github.com/MandalorianBatman/austere-axi`
  - Author Name: `MandalorianBatman`
  - Author Link: `https://github.com/MandalorianBatman`
  - Description (405 characters):

    ```text
    Claude Code plugin, agent skill and CLI for review pages. Claude writes a short OpenUI Lang program instead of HTML; austere-axi validates it in Node and opens it in a local browser tab. The reviewer clicks a table cell, diff line, diagram node or selected text and writes a note; Claude gets each note addressed by statement name and line and patches only those statements, and the page updates in place.
    ```
  - Checklist: tick the five required boxes only after actually doing what each says. Leave the last box ("Do not check the following box") unticked.
- Line the bot should render:

  ```markdown
  - [austere-axi](https://github.com/MandalorianBatman/austere-axi) by [MandalorianBatman](https://github.com/MandalorianBatman) - Claude Code plugin, agent skill and CLI for review pages. Claude writes a short OpenUI Lang program instead of HTML; austere-axi validates it in Node and opens it in a local browser tab. The reviewer clicks a table cell, diff line, diagram node or selected text and writes a note; Claude gets each note addressed by statement name and line and patches only those statements, and the page updates in place.  
  ```

- Issue title: the form fills `[Resource]: <name of your resource>`; set it to `[Resource]: austere-axi`.
- Blockers: wait until 2026-11-09, and until the plugin (`claude plugin marketplace add MandalorianBatman/austere-axi`) works from `main`, because the reviewer will try it.

---

## 2. punkpeye/awesome-mcp-servers

- URL: https://github.com/punkpeye/awesome-mcp-servers
- Observed 2026-11-06: 97,384 stars, last push 2026-11-06, not archived. Many PRs merged per week.
- Method: fork, edit `README.md` only, open a PR. There is no PR template.
- Rules from CONTRIBUTING.md and `.github/workflows/check-glama.yml`:
  - Scope: servers with a public GitHub repo that you install and run yourself.
  - Keep alphabetical order within a category (the existing order is loose). One server per line.
  - The bot labels the PR `missing-glama` unless the new line has a Glama score badge `[![OWNER/REPO MCP server](https://glama.ai/mcp/servers/OWNER/REPO/badges/score.svg)](https://glama.ai/mcp/servers/OWNER/REPO)`. The server must be listed on Glama and pass its checks (Glama says a Dockerfile must be added on Glama, and the server only needs to start and answer introspection).
  - The line needs at least one permitted emoji and no other emojis. Permitted: 🎖️ 🐍 📇 🏎️ 🦀 #️⃣ ☕ 🌊 💎 ☁️ 🏠 📟 🍎 🪟 🐧.
  - The link text must be `owner/repo`. The first link must be a `https://github.com/` URL.
  - CONTRIBUTING has an opt-in `🤖🤖🤖` PR-title suffix for automated agents. A human-opened PR does not use it.
- Section: `### 💻 <a name="developer-tools"></a>Developer Tools`. The closest entry in it is `maple-kit/maple` (review comments read by an agent over MCP).
- Neighbour entry, copied from the README:

  ```markdown
  - [maple-kit/maple](https://github.com/maple-kit/maple) [![maple-kit/maple MCP server](https://glama.ai/mcp/servers/maple-kit/maple/badges/score.svg)](https://glama.ai/mcp/servers/maple-kit/maple) 📇 🏠 🍎 🪟 🐧 - Frontend review on deployed previews. Your agent reads reviewers' comments over MCP and resolves them, and a CI check holds the merge until they are.
  ```

- Line to add, directly above `maple-kit/maple` ("Man" sorts before "map"):

  ```markdown
  - [MandalorianBatman/austere-axi](https://github.com/MandalorianBatman/austere-axi) [![MandalorianBatman/austere-axi MCP server](https://glama.ai/mcp/servers/MandalorianBatman/austere-axi/badges/score.svg)](https://glama.ai/mcp/servers/MandalorianBatman/austere-axi) 📇 🏠 🪟 🐧 - Review pages for coding agents: the agent writes a short OpenUI Lang program, the server validates it and opens it in a local browser tab, and reviewer notes on table cells, diff lines or diagram nodes come back addressed by statement so the agent patches only those statements. Tools: spec, check, open, poll, reply, patch, end.
  ```

  The emojis are 📇 (JavaScript), 🏠 (local loopback server), 🪟 and 🐧 (CI runs on windows-latest and ubuntu-latest). Add 🍎 only after checking that macOS works.
- PR title: `Add MandalorianBatman/austere-axi`
- PR body:

  ```markdown
  Adds austere-axi to Developer Tools.

  - Repo: https://github.com/MandalorianBatman/austere-axi (MIT, JavaScript)
  - Run: `npx -y austere-axi mcp` (stdio)
  - MCP registry name: `io.github.MandalorianBatman/austere-axi`
  - Glama: https://glama.ai/mcp/servers/MandalorianBatman/austere-axi

  A local MCP server for review pages: the agent writes a short OpenUI Lang program, the server validates and opens it in a browser tab on loopback, and the reviewer's notes come back addressed by statement so the agent patches only those statements. No hosted service.
  ```

- Blockers: (1) 0.5.0 (or whatever ships `mcp`) must be `latest` on npm; (2) the server must be listed and scored on Glama, or the PR stays labelled `missing-glama`.

---

## 3. kyrolabs/awesome-agents

- URL: https://github.com/kyrolabs/awesome-agents
- Observed 2026-11-06: 2,995 stars, last push 2026-11-04, not archived. Several submission PRs merged on 2026-11-03 and 2026-11-04.
- Method: PR editing the README. CONTRIBUTING says "Submit a PR, not an issue." There is no template.
- Rules from CONTRIBUTING.md:
  - "When adding a new item, please place it at the _bottom_ of the list."
  - Content must be open source and in English, and must show traction and be maintained.
  - "Criteria that most often trigger closing a PR without merging it: brand new repo with no history, brand new user, or wrong place in the list." These are applied automatically. The GitHub account dates from 2016, so the account is fine; the repo is the risk.
- Section: `## Software Development`
- Neighbour entry (currently the last line of the section), copied from the README:

  ```markdown
  - [Happier](https://github.com/happier-dev/happier): Open-source, end-to-end encrypted, cross-device app to orchestrate Claude Code, Codex and other coding agents on your own machines from desktop, phone and web. ![GitHub Repo stars](https://img.shields.io/github/stars/happier-dev/happier?style=social)
  ```

- Line to add, at the bottom of `## Software Development`:

  ```markdown
  - [austere-axi](https://github.com/MandalorianBatman/austere-axi): Open-source (MIT) review pages for coding agents. The agent writes a short OpenUI Lang program instead of HTML, austere-axi validates it and opens it in a local browser tab, and reviewer notes on table cells, diff lines or diagram nodes come back addressed by statement so the agent edits only those statements. ![GitHub Repo stars](https://img.shields.io/github/stars/MandalorianBatman/austere-axi?style=social)
  ```

- PR title: `Add austere-axi to Software Development`
- PR body:

  ```markdown
  Adds austere-axi at the bottom of Software Development.

  austere-axi (MIT, Node) gives coding agents a review step: the agent writes a short OpenUI Lang program, the CLI validates it and opens it locally, and the reviewer's notes on specific cells, diff lines or diagram nodes are returned addressed by statement so the agent patches only those parts. It ships as a CLI, agent skills and a Claude Code plugin.

  Repo: https://github.com/MandalorianBatman/austere-axi
  ```

- Blocker: likely auto-closed while the repo has about 1 star. Submit after the repo has some stars and history.

---

## 4. heilcheng/awesome-agent-skills

- URL: https://github.com/heilcheng/awesome-agent-skills
- Observed 2026-11-06: 6,349 stars, last push 2026-11-02, not archived. The maintainer merges accepted entries in weekly batch commits.
- Method: PR. Issues are not reviewed. Rules are in AGENTS.md and apply to humans too, plus `.github/PULL_REQUEST_TEMPLATE.md`; a `Check submission` bot comments on every PR.
- Rules from AGENTS.md:
  - Public GitHub repo with a `SKILL.md` that has `name` and `description` frontmatter. `skills/austere/SKILL.md` on `main` qualifies.
  - **At least 20 GitHub stars**, or the PR is labelled `on hold`. Do not open a PR for a repo created in the last 14 days.
  - Edit `README.md` only. Append one line to the end of an existing category under `## Community Skills`, inside its `<details>` block and before `</details>`. Keep the diff purely additive.
  - Format: `- [owner/repo](https://github.com/owner/repo) - Short description, under 100 characters, no marketing language`. Link the folder if the skill is in a subfolder.
  - Title: `Add owner/repo to <Category>`. One open PR per repo.
- Section: `<summary><strong>Development and Testing</strong></summary>` under `## Community Skills`
- Neighbour entry (currently the last line of that category), copied from the README:

  ```markdown
  - [ukorvl/lightweight-charts-react-components](https://github.com/ukorvl/lightweight-charts-react-components/tree/main/skills/lightweight-charts-react-components) - React financial-chart integration recipes for coding agents
  ```

- Line to add, last line before `</details>` in Development and Testing (description is 86 characters):

  ```markdown
  - [MandalorianBatman/austere](https://github.com/MandalorianBatman/austere-axi/tree/main/skills/austere) - Review pages in OpenUI Lang; reviewer notes come back per statement for targeted edits
  ```

- PR title: `Add MandalorianBatman/austere-axi to Development and Testing`
- PR body (their template):

  ```markdown
  **Skill repository:** https://github.com/MandalorianBatman/austere-axi

  **Category:** Development and Testing

  ### Checklist

  - [x] The link is a public GitHub repository (or folder) that contains a `SKILL.md` with `name` and `description` frontmatter
  - [x] The repository has at least 20 stars and is older than 14 days
  - [x] I searched `README.md` and this repository is not already listed or in another open PR
  - [x] I only edited `README.md`, adding at most 5 lines to the end of an existing category
  - [x] Each line uses the format `- [owner/repo](https://github.com/...) - Description under 100 characters`
  - [x] This is not a directory, marketplace, badge, or promotional link

  ### Disclosure

  - [x] I am the author or a maintainer of this skill
  - [ ] This PR was written by an AI agent (name it: ______ )
  ```

  Only tick the second box when it is true. Tick the last box and name the agent if an agent drafted the PR text.
- Blocker: needs 20 stars (1 observed).

---

## 5. VoltAgent/awesome-agent-skills

- URL: https://github.com/VoltAgent/awesome-agent-skills
- Observed 2026-11-06: 36,931 stars, last push 2026-11-05, not archived. `Add skill:` PRs were merged on 2026-11-05.
- Method: PR editing `README.md`.
- Rules from CONTRIBUTING.md:
  - Format: `- **[author/skill-name](https://github.com/author/repo/path)** - Short description of what it does`
  - Add to the end of the matching subcategory under "Community Skills".
  - Author/org prefix in the name. Description "10 words or fewer".
  - "Skill must have real community usage ... Brand new skills that were just created are not accepted."
  - PR title: `Add skill: author/skill-name`
- Section: `<summary><h3 style="display:inline">Development and Testing</h3></summary>` under `### Community Skills`
- Neighbour entry (currently the last line of that subcategory), copied from the README:

  ```markdown
  - **[swiftlysingh/excalidraw-cli](https://github.com/swiftlysingh/excalidraw-cli/tree/main/skills/excalidraw-cli)** - Turn text, JSON, or Graphviz DOT into editable Excalidraw diagrams
  ```

- Line to add, last line before `</details>` in Development and Testing (9 words):

  ```markdown
  - **[MandalorianBatman/austere](https://github.com/MandalorianBatman/austere-axi/tree/main/skills/austere)** - Annotatable review pages; reviewer notes come back per statement
  ```

- PR title: `Add skill: MandalorianBatman/austere`
- PR body:

  ```markdown
  Adds the `austere` skill to Community Skills > Development and Testing.

  - Skill: https://github.com/MandalorianBatman/austere-axi/tree/main/skills/austere (SKILL.md + README)
  - Install: `npx skills add MandalorianBatman/austere-axi --skill austere`
  - License: MIT

  The skill has the agent write a review page as a short OpenUI Lang program, open it with the austere-axi CLI, and apply the reviewer's notes, which arrive addressed by statement.
  ```

- Blocker: they reject brand-new skills without usage. Submit after adoption is visible (stars, skills.sh installs).

---

## 6. jamesmurdza/awesome-ai-devtools

- URL: https://github.com/jamesmurdza/awesome-ai-devtools
- Observed 2026-11-06: 3,996 stars, last push 2026-08-27, not archived. Last submission merge 2026-06-29 (#688). 100+ open PRs.
- Method: PR. The README says "Please read the contribution rules ... before submitting a PR", which point at `.github/PULL_REQUEST_TEMPLATE.md`. The `pr-template-check.yml` workflow requires the `## Description` and `## Checklist` headings, all four checklist lines verbatim, and at least one `- [x]`.
- Template rules: developer tools only, and not general-purpose AI agents/assistants, general AI frameworks, or data-analysis tools.
- Section: `### CLI Utilities` (under `## Terminal`). Entries are not alphabetical; new ones go at the end.
- Neighbour entry, copied from the README:

  ```markdown
  - [prpack](https://github.com/Lucas2944/prpack) — Zero-dep CLI that packs a pull request (diff + commits + full post-change file contents) into one markdown file optimized for LLM code review. Drop the file into Claude / Cursor / your model. MIT.
  ```

- Line to add, at the end of `### CLI Utilities` (after `Octomind`):

  ```markdown
  - [austere-axi](https://github.com/MandalorianBatman/austere-axi) — CLI that turns a short OpenUI Lang program written by a coding agent into a local review page. Reviewer notes on table cells, diff lines or diagram nodes go back to the agent addressed by statement, and the agent patches only those statements. Also ships agent skills and a Claude Code plugin. MIT.
  ```

- PR title: `Add austere-axi to CLI Utilities`
- PR body (template; the bot checks it):

  ```markdown
  ## Description

  Adds austere-axi to Terminal > CLI Utilities. It is a Node CLI used by coding agents: the agent writes a short OpenUI Lang program, the CLI validates it and opens it as a local review page, and the reviewer's notes return to the agent addressed by statement so it edits only those parts.

  ## Checklist

  - [x] The entry is a tool that uses AI
  - [x] The entry is a developer-focused tool
  - [x] The description is unambiguous and clear
  - [x] The description matches the style of other entries
  ```

- Blocker: none hard. Merges stopped in late June, so odds are low. Drop "and a Claude Code plugin" if the plugin is not on `main` at submission time.

---

## 7. ai-for-developers/awesome-ai-coding-tools

- URL: https://github.com/ai-for-developers/awesome-ai-coding-tools
- Observed 2026-11-06: 2,267 stars, last push 2026-09-18, not archived. Merges come in batches (several on 2026-09-18). 100+ open PRs.
- Method: PR, using `.github/PULL_REQUEST_TEMPLATE.md`.
- Rules from CONTRIBUTING.md: AI-powered or AI-enhanced, useful to developers, publicly accessible with at least a free tier. Add to the end of the relevant section. Format `- **[Tool Name](https://example.com)** – One-line description of what it does.` (en dash).
- Section: `## Code Review and Refactoring`
- Neighbour entry (currently the last line of the section), copied from the README:

  ```markdown
  - **[OpenFiles](https://github.com/devgiordane/openfiles)** – VS Code extension that opens every file an AI agent edits so linters and type checkers run on it, lists the changes for review, and returns the problems to Claude Code, Codex, Copilot, Gemini CLI or Cursor. Free and open source (MIT).
  ```

- Line to add, at the end of `## Code Review and Refactoring`:

  ```markdown
  - **[austere-axi](https://github.com/MandalorianBatman/austere-axi)** – Review pages for coding agents: the agent writes a short OpenUI Lang program, the reviewer annotates table cells, diff lines or diagram nodes in a local browser tab, and the agent patches only the statements each note addresses. Free and open source (MIT).
  ```

- PR title: `Add austere-axi to Code Review and Refactoring`
- PR body (template):

  ```markdown
  ## 🚀 Summary

  Adds austere-axi to the end of Code Review and Refactoring.

  ## ✅ Checklist

  - [x] I have read the [contribution guidelines](https://github.com/ai-for-developers/awesome-ai-coding-tools/blob/main/CONTRIBUTING.md)
  - [x] The tool is **AI-related and useful for developers**
  - [x] I have **added a short, clear description** of the tool
  - [x] The link is not a **duplicate** of an existing one
  - [x] The title of the link is **properly capitalized**
  - [x] The link follows the **Awesome List format** (`- [Tool Name](link) – description`)
  - [x] My change does not include unrelated files or changes

  ## 📌 Why is this tool awesome?

  A coding agent writes the review page as a short OpenUI Lang program instead of HTML. In 36 paired runs on 2 models, the HTML-based lavish-axi used a median 3.2× the output tokens, 2.4× the time and 2.5× the cost to produce the same page. Reviewer notes are tied to specific statements, so the agent edits only those. Runs locally with no hosted service.

  ## 🔗 Link

  https://github.com/MandalorianBatman/austere-axi

  ## 📝 Additional context

  Node 22.18+. CLI: `npx -y austere-axi`. Agent skill: `npx skills add MandalorianBatman/austere-axi --skill austere`.
  ```

  The emoji headings come from their template; keep them.
- Blocker: none hard. Review happens in batches.

---

## 8. mcpservers.org (wong2/awesome-mcp-servers)

- URL: https://github.com/wong2/awesome-mcp-servers, form at https://mcpservers.org/submit
- Observed 2026-11-06: 4,403 stars, last push 2026-07-13 (sponsor removals), not archived. Line 4 of the README: "We do not accept PRs. Please submit your MCP on the website: https://mcpservers.org/submit".
- Method: website form. Free plan: "Review within 2 weeks". A paid plan exists; it is not needed.
- Section: no README section applies. The form category is `Development` (other options: Productivity, Database, Search, Web Scraping, File System, Version Control, Communication, Cloud Service, Cloud Storage, Marketing, Finance, Design, Memory, Other).
- Neighbour format in the README, for reference (bold link):

  ```markdown
  - **[Gitee](https://github.com/oschina/mcp-gitee)** - Gitee API integration, repository, issue, and pull request management, and more.
  ```

- Form field values:
  - Server Name: `austere-axi`
  - Category: `Development`
  - Short Description: `Review pages for coding agents. The agent writes a short OpenUI Lang program; the server validates and opens it locally, and reviewer notes come back addressed by statement for targeted patches.`
  - Repository, Website or Documentation: `https://github.com/MandalorianBatman/austere-axi`
  - Official MCP Registry Name (optional): `io.github.MandalorianBatman/austere-axi`
  - "This server supports remote connections": leave unticked (stdio, local only).
  - Contact Email: the maintainer's address.
  - Submission plan: Free.
- Blocker: 0.5.0 with `mcp` must be on npm. Fill in the registry name only after the server is published to the MCP registry.
