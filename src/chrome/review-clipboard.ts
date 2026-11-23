// Copying text, and the agent prompt the owner can hand to an agent.
import { BASE } from "./review-env.ts";
import { flash, showBanner } from "./review-banner.ts";

/**
 * The agent prompt, fetched when the menu opens (the file may have been published since the page
 * opened) so a click can copy it at once: Firefox allows a legacy copy only inside the click itself.
 */
let agentPrompt: Promise<string> | null = null;
let agentPromptText: string | null = null;
export function loadAgentPrompt(): Promise<string> {
  agentPromptText = null;
  const p = fetch(`${BASE}/agent-prompt`).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  });
  agentPrompt = p;
  p.then(
    (t) => {
      if (agentPrompt === p) agentPromptText = t;
    },
    () => {
      // A failed fetch must not stay cached: the next click asks again.
      if (agentPrompt === p) agentPrompt = null;
    },
  );
  return p;
}

/** Copies through a hidden textarea. Works where `navigator.clipboard` does not exist, but only while a click is being handled. */
function copyLegacy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  // A modal dialog makes everything outside it inert: copy from inside the open one.
  (document.querySelector("dialog[open], [role=dialog][data-state=open]") ?? document.body).append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    // refused
  }
  ta.remove();
  return ok;
}

/**
 * Copies `text` and says so. `navigator.clipboard` is there only in a secure context (https or
 * localhost), and the review page is often opened at an http tailnet address, where it is undefined:
 * the legacy copy covers that. When nothing can copy, the text is shown to copy by hand.
 */
export async function copyText(text: string, what: string): Promise<void> {
  let ok = false;
  if (navigator.clipboard?.writeText) {
    ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
  if (!ok) ok = copyLegacy(text);
  if (ok) return flash(`${what} copied.`);
  window.prompt(`Your browser blocked copying. Copy ${what.toLowerCase()} from here:`, text);
}

export async function copyAgentPrompt(): Promise<void> {
  let text = agentPromptText;
  if (text == null) {
    try {
      text = await (agentPrompt ?? loadAgentPrompt());
    } catch {
      return showBanner(
        "Could not get the agent prompt from austere-axi. Check that it is still running.",
      );
    }
  }
  await copyText(text, "Agent prompt");
}
