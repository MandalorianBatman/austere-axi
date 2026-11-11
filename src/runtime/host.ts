// The objects a component pack imports (see src/pack-kit/shim.ts), put where
// pack bundles look for them. Installed before any pack script runs.
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as zod from "zod";
import * as pack from "./pack-api.ts";

/** What globalThis.__austereHost holds: one key per module a pack bundle reads (HOST_MODULES in the shim). */
export interface AustereHost {
  api: typeof pack.PACK_API;
  React: typeof React;
  jsxRuntime: typeof jsxRuntime;
  zod: typeof zod;
  pack: typeof pack;
}

declare global {
  var __austereHost: AustereHost | undefined;
}

export function installHost(): AustereHost {
  if (globalThis.__austereHost) return globalThis.__austereHost;
  globalThis.__austereHost = { api: pack.PACK_API, React, jsxRuntime, zod, pack };
  return globalThis.__austereHost;
}

installHost();
