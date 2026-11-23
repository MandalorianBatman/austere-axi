// What the server wrote into the hub page (src/cli/hub-page.ts), and the one formatter that needs it.
interface HubBoot {
  version: string;
  home: string;
  sep: string;
}

export const BOOT: HubBoot = (window as Window & { __AUSTERE_HUB__?: HubBoot }).__AUSTERE_HUB__ ?? {
  version: "",
  home: "",
  sep: "/",
};

/** `/home/me/code` as `~/code`. */
export function tilde(p: string): string {
  const home = BOOT.home;
  return home && (p === home || p.startsWith(home + BOOT.sep)) ? `~${p.slice(home.length)}` : p;
}
