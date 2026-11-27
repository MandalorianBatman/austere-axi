# GitHub Action

Posts an austere review on every pull request: runs `austere-axi check` on your committed pages, exports each with `austere-axi export`, uploads them as a workflow artifact, and posts or updates **one** PR comment with a summary and download link.

```yaml
# .github/workflows/austere.yml
name: austere review
on: pull_request

permissions:
  contents: read
  pull-requests: write   # to post the comment

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: MandalorianBatman/austere-axi/action@v0.17.0
        with:
          pages: reviews/*.html
```

| Input | Default | |
|---|---|---|
| `pages` | required | paths or globs, one per line, relative to the workspace |
| `version` | `latest` | austere-axi version from npm; pin it for reproducible runs |
| `artifact-name` | `austere-review` | workflow artifact that holds the exported pages |
| `retention-days` | repository default | artifact retention |
| `comment` | `true` | `false` leaves only the artifact and the job summary |
| `comment-tag` | `default` | names the sticky comment; use one per use of the action in the same PR |
| `github-token` | `github.token` | needs `pull-requests: write` to comment |

Outputs: `ok` (`true` when every page passed) and `artifact-url`.

- **A failing check fails the job.** The log and job summary show each error with its statement and line. Passing pages are still exported.
- **Fork PRs** get a read-only token: the comment is skipped with a warning; the job summary and artifact still carry the report.
- **Sticky comment:** updates only a marked comment posted by its own token's account (a bot for `github.token`). A same-marker comment by someone else is left alone; the action posts its own.
- **Triggers:** use `pull_request`, never `pull_request_target`, to run pages from a fork.
- **Artifact:** GitHub zips it and requires login to download. Unzip and open the HTML in a browser; works offline. No Pages preview.
- The action lives under `action/` in this repo, so one ref pins the action and the CLI contract it calls; `version` still picks the CLI.
