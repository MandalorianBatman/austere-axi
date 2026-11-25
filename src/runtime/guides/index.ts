// Read-path fields (guide, keywords, family, alsoIn) for core components that
// do not set them in their own austereComponent() call: stock OpenUI components,
// which have no file of ours, and Architecture. A component's own fields win.
// Never in `spec`; the runtime bundle loads the guides as empty.
import type { EntryDetails } from "../../../types/catalog.d.ts";
import architecture from "./Architecture.md";
import steps from "./Steps.md";

export const CORE_DETAILS: Record<string, EntryDetails> = {
  Architecture: {
    guide: architecture,
    family: "Architecture",
    keywords: [
      "system diagram",
      "architecture",
      "infrastructure",
      "services",
      "topology",
      "boxes and arrows",
      "trust boundary",
    ],
  },
  Steps: {
    guide: steps,
    family: "Flow",
    alsoIn: ["Diagrams"],
    keywords: ["steps", "procedure", "how it works", "playbook", "process", "stages"],
  },
};
