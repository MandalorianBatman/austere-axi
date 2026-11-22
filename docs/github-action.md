# GitHub Action

Posts an austere review page on every pull request: runs `austere-axi check` on the pages you commit, exports each with `austere-axi export`, uploads them as a workflow artifact, and posts or updates **one** PR comment with a summary and a download link.

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

- **A failing check fails the job.** The log and the job summary show each error with its statement and line. Pages that passed are still exported.
- **Fork PRs** get a read-only token, so the comment is skipped with a warning. The job summary and the artifact still carry the report.
- **Sticky comment:** the action updates only a marked comment posted by its own token's account (a bot account for `github.token`). If someone else posts a comment with the same marker, the action leaves it alone and posts its own.
- **Triggers:** use `pull_request`. Do not use `pull_request_target` to run pages from a fork.
- **Artifact:** GitHub zips it and needs a login to download. Unzip and open the HTML in a browser; it works offline. No Pages preview.
- The action lives in this repo under `action/`, so one ref pins both the action and the CLI contract it calls. `version` still picks the CLI.
