// The prompt the owner hands to an agent so it starts polling a review page. The review page's
// "Copy agent prompt" menu item fetches it from the server (`GET /s/:id/agent-prompt`), which
// knows the file and whether it is published. It names the page and the poll commands the CLI
// documents (`austere-axi --help`); it carries no key, token or invite link.
import { quote } from "./paths.ts";

const BIN = "austere-axi";

export interface AgentPromptInput {
  /** The review's file (canonical path); `poll` takes it, and a peer machine finds the same page by it. */
  file: string;
  /** Set when the file is published: the service's page address and whether notes skip the owner's hold. */
  hosted?: { url: string; auto: boolean };
}

export function agentPrompt({ file, hosted }: AgentPromptInput): string {
  const f = quote(file);
  const lines = [
    `Listen for feedback on my austere-axi review page and revise it as notes arrive.`,
    ``,
    `File: ${file}`,
  ];
  if (hosted) lines.push(`Shared page: ${hosted.url}`);
  lines.push(
    ``,
    `1. Run \`${BIN} poll ${f}\` in the foreground and leave it running until it returns. If the call times out (status: timeout), run it again.`,
    `2. When it returns feedback, change the page with \`${BIN} patch ${f}\` (send only the changed statements on stdin), then run \`${BIN} poll ${f} --cursor <n> --agent-reply "<one line: what changed>"\` with the cursor it printed. That acknowledges the feedback, posts your reply and listens again.`,
    `3. When the batch has \`final: true\`, I pressed Send & End: apply it, reply, then stop polling and continue in chat. A note I send later waits for your next poll. When it returns status: replaced, a newer poll took over this page: stop polling here.`,
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
