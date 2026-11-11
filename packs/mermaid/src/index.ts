// The Mermaid pack, bundled with austere-axi. It loads only on pages whose
// program calls Mermaid(...), so pages without a diagram never fetch it.
import Mermaid from "./Mermaid.tsx";
import css from "./mermaid.css";
import type { PackModule } from "austere-axi/pack";

export default { components: [Mermaid], css } satisfies PackModule;
