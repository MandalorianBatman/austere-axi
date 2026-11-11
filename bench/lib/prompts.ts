// What each tool's agent is told. The system prompt is the tool's own guidance,
// captured live from its CLI at the start of a run (an agent would read the same
// output), so it never drifts from the version being measured.
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Task } from "../tasks.ts";
import { ROOT, LAVISH_CLI, lavishEnv } from "./paths.ts";

export type Tool = "austere" | "lavish";

/** A tool's captured guidance: its version and the system prompt for a task. */
export interface ToolGuidance {
  system: (task: Task) => string;
  version: string;
}

/**
 * Where the reviewer's note is attached, as each tool's `poll` names it: an
 * austere-axi statement, or a lavish-axi element selector and its text.
 */
export interface ReviewAnchor {
  found?: boolean;
  statement?: string;
  component?: string;
  line?: number;
  source?: string;
  selector?: string;
  text?: string;
}

/** SEARCH/REPLACE outcome: the new text and edit count, or an error. */
export interface SearchReplaceResult {
  text?: string;
  edits?: number;
  error?: string;
}

const PREAMBLE = (tool: string) =>
  `You are a coding agent. The user uses ${tool} for review pages. Earlier in this session you ran the commands below; their output follows. You cannot run commands now, so answer with file contents in the exact format the user asks for.`;

const sh = (cmd: string, args: string[], env?: Record<string, string>) => execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 16 << 20 }).trim();

export function captureGuidance(): Record<Tool, ToolGuidance> {
  const austereCli = path.join(ROOT, "dist", "cli.mjs");
  const austereHelp = sh("node", [austereCli, "--help"]);
  const austereSpec = sh("node", [austereCli, "spec"]);
  const austereVersion = /austere-axi (\S+)/.exec(austereHelp)?.[1] ?? "?";

  const lav = (...args: string[]) => sh("node", [LAVISH_CLI, ...args], lavishEnv());
  const lavishHelp = lav("--help");
  const lavishDesign = lav("design");
  const playbooks = new Map<string, string>();
  const playbook = (id: string) => {
    if (!playbooks.has(id)) playbooks.set(id, lav("playbook", id));
    return playbooks.get(id) ?? "";
  };
  const lavishVersion = sh("node", [LAVISH_CLI, "--version"], lavishEnv());

  const block = (cmd: string, out: string) => `$ ${cmd}\n${out}\n`;
  return {
    austere: {
      version: austereVersion,
      system: () => [PREAMBLE("austere-axi"), block("austere-axi --help", austereHelp), block("austere-axi spec", austereSpec)].join("\n"),
    },
    lavish: {
      version: lavishVersion,
      system: (task) =>
        [
          PREAMBLE("lavish-axi"),
          block("lavish-axi --help", lavishHelp),
          block("lavish-axi design", lavishDesign),
          ...task.playbooks.map((id) => block(`lavish-axi playbook ${id}`, playbook(id))),
        ].join("\n"),
    },
  };
}

/** First turn: the same words for both tools. */
export function firstPrompt(task: Task, tool: Tool): string {
  const file = tool === "austere" ? "page.html" : ".lavish/page.html";
  return `${task.prompt}

Write the page to \`${file}\`. Reply with the complete file in one \`\`\`html code block and nothing else.`;
}

/**
 * Revision turn: the reviewer's note, in the shape the tool's `poll` reports it,
 * and the tool's cheapest edit path. austere-axi: changed statements for
 * `austere-axi patch`. lavish-axi: search/replace edits, the way an agent's Edit
 * tool changes a file without writing it again.
 */
export function revisionPrompt(task: Task, tool: Tool, anchor: ReviewAnchor): string {
  const note = task.feedback.note;
  if (tool === "austere") {
    return `You opened the page for review and ran \`austere-axi poll page.html\`. It returned:

\`\`\`yaml
status: feedback
items:
  - annotation: ${anchor.statement} (${anchor.component})
    line: ${anchor.line}
    source: ${JSON.stringify(anchor.source)}
    selection: ${JSON.stringify(task.feedback.anchor)}
    note: ${JSON.stringify(note)}
\`\`\`

Apply the feedback. Reply with only the statements to add or replace, in one \`\`\`openui code block and nothing else. It is applied with \`austere-axi patch page.html\`: a statement with an existing name replaces it, a new name adds it.`;
  }
  return `You opened the page for review and ran \`lavish-axi poll .lavish/page.html\`. It returned:

\`\`\`yaml
status: feedback
prompts[1]:
  - kind: annotation
    selector: ${JSON.stringify(anchor.selector)}
    text: ${JSON.stringify(anchor.text)}
    note: ${JSON.stringify(note)}
\`\`\`

Apply the feedback by editing the file in place. Reply with only your edits and nothing else, as one or more blocks in this exact format:

<<<<<<< SEARCH
exact lines from the current file
=======
the lines that replace them
>>>>>>> REPLACE

Each SEARCH must match the current file exactly, once.`;
}

/** The file body from a reply: the first fenced block of the given language, else the whole reply. */
export function fencedBlock(text: string, langs: string[]): string {
  const re = /```([\w-]*)[^\n]*\n([\s\S]*?)\n?```/g;
  let first: string | null = null;
  for (const m of text.matchAll(re)) {
    if (langs.includes(m[1].toLowerCase())) return m[2];
    first ??= m[2];
  }
  if (first != null) return first;
  // An unterminated fence (reply cut off) still counts as the file.
  const open = /```[\w-]*[^\n]*\n([\s\S]*)$/.exec(text);
  return open ? open[1] : text.trim();
}

/** Applies SEARCH/REPLACE blocks. Returns the new text, or an error naming the first block that did not match once. */
export function applySearchReplace(source: string, reply: string): SearchReplaceResult {
  const re = /<{5,9} ?SEARCH\n([\s\S]*?)\n?={5,9}\n([\s\S]*?)\n?>{5,9} ?REPLACE/g;
  let out = source;
  let count = 0;
  for (const m of reply.matchAll(re)) {
    count++;
    const [, search, replace] = m;
    const at = out.indexOf(search);
    if (at < 0) return { error: `edit ${count}: SEARCH text not found` };
    if (out.indexOf(search, at + 1) >= 0) return { error: `edit ${count}: SEARCH text matches more than once` };
    out = out.slice(0, at) + replace + out.slice(at + search.length);
  }
  if (!count) return { error: "no SEARCH/REPLACE blocks in the reply" };
  return { text: out, edits: count };
}
