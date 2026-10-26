// The contract every custom component file in ./components/ follows.
// Files there are collected automatically at build time (the
// `austere:components` module); a file whose name starts with "_" is a helper,
// not a component.
import { defineComponent } from "@openuidev/react-lang";
import { GROUP_NAMES } from "./stock.js";

/** Where a content component may appear besides a Stack (which takes anything). */
export const CONTENT_SLOTS = ["Card.children", "TabItem.content", "AccordionItem.content"];

/**
 * @param {object} c
 * @param {string} c.name          PascalCase component name the agent writes.
 * @param {string} c.group         Prompt group: one of GROUP_NAMES.
 * @param {import("zod").ZodObject} c.props  Props IN POSITIONAL ORDER. Append-only once released.
 * @param {string} c.description   One line the agent reads in `spec`. Costs tokens in every session.
 * @param {Function} c.renderer    React renderer: ({ props, renderNode, statementId }) => node.
 * @param {string} c.example       OpenUI statements; the first one must call this component.
 * @param {string[]} [c.notes]     Extra prompt lines ("- ...") appended to the group's notes.
 * @param {string[]|null} [c.slots] Parent slots it may fill; null for value-only sub-components.
 * @param {boolean} [c.tagged]     Wrap the output with its statement name (default true).
 */
export function austereComponent(c) {
  const where = `component ${c?.name || "(unnamed)"}`;
  if (!c || typeof c.name !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(c.name)) {
    throw new Error(`${where}: name must be PascalCase`);
  }
  if (!GROUP_NAMES.includes(c.group)) throw new Error(`${where}: group must be one of ${GROUP_NAMES.join(", ")}`);
  if (typeof c.description !== "string" || !c.description.trim()) throw new Error(`${where}: description is required`);
  if (typeof c.renderer !== "function") throw new Error(`${where}: renderer must be a React component`);
  if (typeof c.example !== "string" || !c.example.includes(`${c.name}(`)) {
    throw new Error(`${where}: example must contain a ${c.name}(...) call`);
  }
  const notes = c.notes ?? [];
  for (const n of notes) if (!n.startsWith("- ")) throw new Error(`${where}: notes start with "- "`);
  return {
    name: c.name,
    group: c.group,
    notes,
    slots: c.slots === undefined ? CONTENT_SLOTS : c.slots,
    tagged: c.tagged !== false,
    example: c.example.trim(),
    definition: defineComponent({ name: c.name, props: c.props, description: c.description, component: c.renderer }),
  };
}
