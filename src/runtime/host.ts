// The objects a component pack imports (see src/pack-kit/shim.js), put where
// pack bundles look for them. Installed before any pack script runs.
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as zod from "zod";
import * as pack from "./pack-api.js";

export function installHost() {
  if (globalThis.__austereHost) return globalThis.__austereHost;
  globalThis.__austereHost = { api: pack.PACK_API, React, jsxRuntime, zod, pack };
  return globalThis.__austereHost;
}

installHost();
