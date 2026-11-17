// The prompt the owner hands to an agent so it starts polling a review page. The review page's
// "Copy agent prompt" menu item fetches it from the server (`GET /s/:id/agent-prompt`), which
// knows the file, its project and whether it is published. It teaches the loop `austere-axi --help`
// documents (one poll for the page's project); it carries no key, token or invite link.
import { quote } from "./paths.ts";

const BIN = "austere-axi";

export interface AgentPromptInput {
  /** The review's file (canonical path); `poll` takes it, and a peer machine finds the same page by it. */
  file: string;
  /** Set when the file is published: the service's page address and whether notes skip the owner's hold. */
  hosted?: { url: string; auto: boolean };
  /** The page's project, when no agent polls it yet: `ref` names it for `--project` from any folder. Absent: the prompt names the page poll. */
  project?: { name: string; ref: string };
}

export function agentPrompt({ file, hosted, project }: AgentPromptInput): string {
  const f = quote(file);
  const lines = [
    `Listen for feedback on my austere-axi review page and revise it as notes arrive.`,
    ``,
    `File: ${file}`,
  ];
  if (hosted) lines.push(`Shared page: ${hosted.url}`);
  // One loop: a project poll covers this page and every other page of its project. Without a project, the page poll, which takes only this page.
  const poll = project ? `${BIN} poll --project ${quote(project.ref)}` : `${BIN} poll ${f}`;
  lines.push(
    ``,
    `1. Run \`${poll}\`. It returns when I send notes${project ? `, one batch per page of ${project.name} (this one included), each naming its file` : ""}. If it returns status: timeout, run it again. If your harness wakes you when a background job ends, run it as one.`,
    `2. For each batch: change that page with \`${BIN} patch <file>\` (send only the changed statements on stdin), then \`${BIN} reply <file> --cursor <n> --agent-reply "<one line: what changed>"\` with the cursor the poll printed. Then \`${poll} --cursor <n>\` to listen again.`,
    `3. A batch with \`final: true\` means I pressed Send & End: that page is done. Apply it and reply; keep polling while another page you opened is still in review, else stop and continue in chat. A note I send later waits for your next poll. On status: replaced, a newer poll took over (maybe your own): stop that one.`,
  );
  if (hosted) {
    lines.push(
      ``,
      hosted.auto
        ? `Notes from reviewers on the shared page arrive through the same poll, marked remote: true, as they are posted.`
        : `Notes from reviewers on the shared page arrive through the same poll, marked remote: true, but only after I send them on in the review page; the poll stays quiet until then.`,
    );
  }
  lines.push(``, `Do not open, screenshot or inspect the page, and do not run publish; I will ask if I want either.`);
  return lines.join("\n");
}
