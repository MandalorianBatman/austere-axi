// zod compiles object parsers with `new Function` when it may, and probes for that when a schema is
// built. The hosted page's CSP has no 'unsafe-eval', so even the caught probe is reported as a
// violation. Imported before src/shared/sync.ts, so its schemas are built without the probe.
import { config } from "zod";

config({ jitless: true });
