// What a component pack can import as "austere-axi/pack". Pack bundles never
// include React, zod or this module: the pack build maps those imports onto
// the objects the runtime (or the catalog build, in Node) puts on
// globalThis.__austereHost, so a pack shares the page's single React and the
// library's zod. Keep this surface small: third-party packs build against it.
import { austereComponent } from "./define.js";
import { assetUrl, reportRuntimeError } from "./env.js";

/** Version of this API. A pack built for another major version is refused. */
export const PACK_API = 1;

const registered = [];
const listeners = new Set();

/**
 * Called once by each pack bundle when it loads:
 *   registerPack({ name: "austere-pack-gantt", version: "1.0.0", api: 1, components: [Gantt, Task], css })
 * `components` are austereComponent() results; `css` is optional text the
 * runtime adds to the page once.
 */
export function registerPack(pack) {
  if (!pack || typeof pack.name !== "string" || !pack.name) throw new Error("registerPack needs a name");
  if (typeof pack.version !== "string" || !pack.version) throw new Error(`pack ${pack.name}: registerPack needs a version`);
  if ((pack.api ?? PACK_API) !== PACK_API) {
    throw new Error(`pack ${pack.name} targets pack API ${pack.api}; this runtime has ${PACK_API}`);
  }
  const components = [].concat(pack.components || []).flat();
  for (const c of components) {
    if (!c || !c.definition) throw new Error(`pack ${pack.name}: components must be austereComponent(...) results`);
  }
  const entry = { name: pack.name, version: pack.version, components, css: typeof pack.css === "string" ? pack.css : "" };
  const i = registered.findIndex((p) => p.name === entry.name);
  if (i >= 0) registered[i] = entry;
  else registered.push(entry);
  for (const fn of listeners) fn(entry);
  return entry;
}

/** Packs registered so far, in load order. */
export function registeredPacks() {
  return registered.slice();
}

export function onPackRegistered(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export { austereComponent, assetUrl, reportRuntimeError };
