// What the server wrote into the hub page (src/cli/server.ts; austere-cloud for the cloud), and the one formatter that needs it.
import type { HubBoot } from "../shared/hub-api.ts";
export const BOOT: HubBoot = (window as Window & { __AUSTERE_HUB__?: HubBoot }).__AUSTERE_HUB__ ?? {
  version: "",
  home: "",
  sep: "/",
};

/** The shell runs on austere-cloud: the cloud's views, and no local machine behind it. */
export const CLOUD = BOOT.mode === "cloud";

/** `/home/me/code` as `~/code`. */
export function tilde(p: string): string {
  const home = BOOT.home;
  return home && (p === home || p.startsWith(home + BOOT.sep)) ? `~${p.slice(home.length)}` : p;
}
