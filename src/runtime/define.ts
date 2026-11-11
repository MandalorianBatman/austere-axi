// The contract every custom component file in ./components/ follows.
// Files there are collected automatically at build time (the
// `austere:components` module); a file whose name starts with "_" is a helper,
// not a component.
import { defineComponent } from "@openuidev/react-lang";
import type { ComponentRenderer } from "@openuidev/react-lang";
import type { ZodObject, ZodRawShape, infer as ZodInfer } from "zod";
import type { AustereComponent, ComponentSpec } from "../../types/pack.d.ts";
import { GROUP_NAMES } from "./groups.ts";

/** Where a content component may appear besides a Stack (which takes anything). */
export const CONTENT_SLOTS = ["Card.children", "TabItem.content", "AccordionItem.content"];

/**
 * c.name          PascalCase component name the agent writes.
 * c.group         Prompt group: one of GROUP_NAMES (a pack may name its own category).
 * c.props         Props IN POSITIONAL ORDER. Append-only once released.
 * c.description   One line the agent reads in `spec`. Costs tokens in every session.
 * c.renderer      React renderer: ({ props, renderNode, statementId }) => node.
 * c.example       OpenUI statements whose first statement calls this
 *                 component; a list shows several uses, one gallery card each.
 *                 Required, except for value-only parts (slots: null), which the
 *                 container's example already shows.
 * c.stress        Like example, with hostile input (long tokens, deep nesting,
 *                 the malformed shapes agents write). Never in the prompt; the tests
 *                 and the browser suite render it at phone width.
 * c.notes         Extra prompt lines ("- ...") appended to the group's notes.
 * c.slots         Parent slots it may fill; null for value-only sub-components.
 * c.tagged        Wrap the output with its statement name (default true).
 * c.tier          "extended" keeps it out of the prompt (searchable with
 *                 `components search|show`); default "core".
 */
export function austereComponent<Shape extends ZodRawShape>(c: ComponentSpec<Shape>): AustereComponent {
  const where = `component ${c?.name || "(unnamed)"}`;
  if (!c || typeof c.name !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(c.name)) {
    throw new Error(`${where}: name must be PascalCase`);
  }
  // A stock group, or (packs) a category of its own, which `spec` lists after the stock ones.
  if (typeof c.group !== "string" || !(GROUP_NAMES.includes(c.group) || /^[A-Z][A-Za-z0-9 ]{1,23}$/.test(c.group))) {
    throw new Error(`${where}: group must be one of ${GROUP_NAMES.join(", ")}, or a short capitalized category name`);
  }
  if (typeof c.description !== "string" || !c.description.trim()) throw new Error(`${where}: description is required`);
  if (typeof c.renderer !== "function") throw new Error(`${where}: renderer must be a React component`);
  const valueOnly = c.slots === null;
  const programs = (field: "example" | "stress", required: boolean): string[] | null => {
    const value = c[field];
    if (value === undefined && !required) return null;
    const list = ([] as unknown[]).concat(value ?? []);
    const callsIt = new RegExp(`^\\s*[A-Za-z_]\\w*\\s*=\\s*${c.name}\\(`);
    if (!list.length || !list.every((p): p is string => typeof p === "string" && callsIt.test(p))) {
      throw new Error(`${where}: each ${field} program must start with a statement that calls ${c.name}(...)`);
    }
    return list.map((p) => p.trim());
  };
  const example = programs("example", !valueOnly);
  const stress = programs("stress", false);
  const notes = c.notes ?? [];
  for (const n of notes) if (!n.startsWith("- ")) throw new Error(`${where}: notes start with "- "`);
  return {
    name: c.name,
    group: c.group,
    notes,
    slots: c.slots === undefined ? CONTENT_SLOTS : c.slots,
    tagged: c.tagged !== false,
    tier: c.tier === "extended" ? "extended" : "core",
    example,
    stress,
    // types/pack.d.ts gives the renderer's result as unknown (packs need not depend on React's types); it renders a React node.
    definition: defineComponent({ name: c.name, props: c.props, description: c.description, component: c.renderer as ComponentRenderer<ZodInfer<ZodObject<Shape>>> }),
  };
}
