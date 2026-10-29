// The Mermaid pack, bundled with austere-axi. It loads only on pages whose
// program calls Mermaid(...), so pages without a diagram never fetch it.
import Mermaid from "./Mermaid.jsx";
import css from "./mermaid.css";

export default { components: [Mermaid], css };
