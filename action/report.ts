// Step 3 of the action: job summary, and the sticky PR comment when the event is a pull request.
// A read-only token (fork PRs) cannot comment: that warns and the job summary still carries the report.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderComment, upsertComment } from "./lib.mjs";

const env = process.env;
const resultsFile = path.join(env.RUNNER_TEMP || os.tmpdir(), "austere-results.json");
if (!fs.existsSync(resultsFile)) {
  console.log("austere-axi: no results (the run step did not get as far as checking a page); nothing to report.");
  process.exit(0);
}
const results = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
const tag = (env.INPUT_COMMENT_TAG || "default").trim() || "default";
const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
  ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  : undefined;
const body = renderComment(results, { tag, artifactUrl: env.ARTIFACT_URL || undefined, runUrl });

if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, body + "\n");

if ((env.INPUT_COMMENT || "true") !== "true") process.exit(0);

let pr = 0;
try {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH || "", "utf8"));
  pr = event.pull_request?.number || 0;
} catch {}
if (!pr) {
  console.log("austere-axi: not a pull_request event; skipping the PR comment (the job summary has the report).");
  process.exit(0);
}

try {
  const { action, url } = await upsertComment({
    api: env.GITHUB_API_URL || "https://api.github.com",
    repo: env.GITHUB_REPOSITORY || "",
    pr,
    token: env.INPUT_TOKEN || "",
    body,
    tag,
  });
  console.log(`austere-axi: ${action} PR comment ${url}`);
} catch (err) {
  const msg = String(err?.message || err).replace(/[\r\n%]+/g, " ");
  const hint = err?.status === 403 || err?.status === 401
    ? " The token cannot write PR comments (fork PRs get a read-only token; otherwise grant `pull-requests: write`). The job summary has the report."
    : "";
  console.log(`::warning title=austere-axi::Could not post the PR comment: ${msg}.${hint}`);
}
