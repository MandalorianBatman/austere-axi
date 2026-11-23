// Review chrome: artifact frame + conversation panel, in React (review-app.tsx) over one store (review-store.ts).
// This file starts it: it draws the page, then brings up what lives outside React (the roster of the others on the
// page, the owner's navigation, the connection to the server or, hosted, the page socket).
//
// The local server inlines the boot object as window.__AUSTERE__. The hosted service's CSP forbids inline
// scripts, so it ships the same object as JSON in <script type="application/json" id="austere-boot">.
import "./zod-jitless.ts";
import { Presence } from "./presence.ts";
import { installNav } from "./nav.ts";
import { mountApp } from "./review-app.tsx";
import { openAttach } from "./review-attach.ts";
import { flash } from "./review-banner.ts";
import { post } from "./review-bridge.ts";
import { HOSTED, OWNER, SID } from "./review-env.ts";
import { connect } from "./review-events.ts";
import { loadFrame, setNav } from "./review-frame.ts";
import { startHosted } from "./review-hosted.ts";
import { refreshPending } from "./review-outbox.ts";
import { setRoster } from "./review-presence.ts";
import { S } from "./review-store.ts";

/** An element of the markup mountApp drew: a query of an element that is known to be there (a cast at the boundary). */
const $ = <E extends Element = HTMLElement>(sel: string): E => document.querySelector(sel) as E;

mountApp();

// Presence (Q17): chips for the others on the page and their last click in the frame. The
// transport calls connect/handle/disconnect: the page socket when hosted, the server's relay locally.
const presence = new Presence({
  chips: $(".viewers"),
  showFocus: (marks) => post({ type: "presence", marks }),
  reveal: (id) => post({ type: "reveal", id }),
  name: () => S().viewerName || undefined,
});
setRoster(presence);
window.addEventListener("pagehide", () => presence.leave());

// The owner's way between pages and the hub (RLM-358): never for a reviewer or a hosted page.
if (OWNER && !HOSTED) {
  const nav = installNav({
    id: SID,
    bar: $(".bar-title"),
    menu: $(".menu-pop"),
    flash,
    highlight: (ids) => post({ type: "highlight", ids, scroll: true }),
    openAttach,
  });
  setNav(nav);
  // After this click has reached the document, as the menu's Go to page does.
  $(".goto-btn").addEventListener("click", () => setTimeout(() => nav.toggleSwitcher(), 0));
}

refreshPending();
if (HOSTED) void startHosted();
else {
  loadFrame();
  connect();
}
