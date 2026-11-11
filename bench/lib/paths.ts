import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT = path.dirname(BENCH);
export const LAVISH_CLI = path.join(BENCH, "node_modules", "lavish-axi", "dist", "cli.mjs");

// lavish-axi, austere-axi and the claude CLI keep their state here for the run,
// never in ~. Removed on exit.
export const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-bench-"));
process.on("exit", () => fs.rmSync(STATE, { recursive: true, force: true }));

let lavishPort = 0;
export function setLavishPort(port: number): void {
  lavishPort = port;
}

export function lavishEnv(): Record<string, string> {
  return {
    LAVISH_AXI_STATE_DIR: path.join(STATE, "lavish"),
    ...(lavishPort ? { LAVISH_AXI_PORT: String(lavishPort) } : {}),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
  };
}
