// Nested and LayerStack: parsed props → a list of levels. Pure TypeScript (no JSX), so Node tests can import it.
import { isElement } from "./element.ts";

export const LEVEL_TONES = ["info", "success", "warning", "danger", "strong"] as const;
export type LevelTone = (typeof LEVEL_TONES)[number];

export interface Level {
  /** The statement name; "#level0" and so on for an inline (unnamed) level. */
  id: string;
  named: boolean;
  label: string;
  /** Nested: the aside under the label. LayerStack: the index tag (L3, 07). */
  note: string;
  /** LayerStack: the short items inside the layer. */
  items: string[];
  tone: LevelTone | "";
}

export interface LevelModel {
  levels: Level[];
  problems: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export interface LevelSpec {
  /** What the part is called, for messages. */
  part: string;
  /** The container, for messages. */
  component: string;
  /** The props that hold the label and the one-line text next to it. */
  labelProp: string;
  noteProp: string;
  itemsProp?: string;
}

/**
 * The list of levels in order, outermost (Nested) or top (LayerStack) first.
 * A level listed twice is drawn once. Never throws.
 */
export function buildLevels(list: unknown, spec: LevelSpec): LevelModel {
  const problems: string[] = [];
  const levels: Level[] = [];
  const seen = new Set<unknown>();
  const ids = new Set<string>();
  let anon = 0;
  for (const el of Array.isArray(list) ? list : []) {
    if (!isElement<Record<string, unknown>>(el)) continue;
    const statementId =
      "statementId" in el && typeof el.statementId === "string" ? el.statementId : "";
    // Statement names are identifiers: "#" cannot collide with one.
    const id = statementId || `#level${anon++}`;
    if (seen.has(el) || ids.has(id)) {
      problems.push(`${spec.part} ${id} is listed twice in ${spec.component}. It is drawn once.`);
      continue;
    }
    seen.add(el);
    ids.add(id);
    const p = el.props;
    const tone = LEVEL_TONES.find((t) => t === p.tone);
    const items = spec.itemsProp ? p[spec.itemsProp] : undefined;
    levels.push({
      id,
      named: !!statementId,
      label: str(p[spec.labelProp]).trim() || id,
      note: str(p[spec.noteProp]).trim(),
      items: (Array.isArray(items) ? items : []).map((i) => str(i).trim()).filter(Boolean),
      tone: tone ?? "",
    });
  }
  return { levels, problems };
}

export const NESTED_SPEC: LevelSpec = {
  part: "NestedLevel",
  component: "Nested",
  labelProp: "label",
  noteProp: "note",
};

export const LAYER_SPEC: LevelSpec = {
  part: "Layer",
  component: "LayerStack",
  labelProp: "name",
  noteProp: "tag",
  itemsProp: "items",
};
