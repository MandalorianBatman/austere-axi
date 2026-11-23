// Review chrome: artifact frame + conversation panel, in React (review-app.tsx) over one store (review-store.ts).
// This file starts it: it draws the page, then brings up what lives outside React (the roster of the others on the
// page, the owner's navigation, the connection to the server or, hosted, the page socket).
//
// The local server inlines the boot object as window.__AUSTERE__. The hosted service's CSP forbids inline
// scripts, so it ships the same object as JSON in <script type="application/json" id="austere-boot">.
import "./zod-jitless.ts";
import { Presence } from "./presence.ts";
import { mountApp } from "./review-app.tsx";
import { post } from "./review-bridge.ts";
import { HOSTED, OWNER } from "./review-env.ts";
import { connect } from "./review-events.ts";
import { loadFrame } from "./review-frame.ts";
import { startHosted } from "./review-hosted.ts";
import { startNav } from "./review-nav.ts";
import { refreshPending } from "./review-outbox.ts";
import { getViewers, setRoster } from "./review-presence.ts";
import { S } from "./review-store.ts";

mountApp();

// Presence (Q17): chips for the others on the page and their last click in the frame. The
// transport calls connect/handle/disconnect: the page socket when hosted, the server's relay locally.
const presence = new Presence({
  // The page bar's boundary may have shown its fallback: the chips then have nowhere to go, and nothing else fails.
  chips: getViewers,
  showFocus: (marks) => post({ type: "presence", marks }),
  reveal: (id) => post({ type: "reveal", id }),
  name: () => S().viewerName || undefined,
});
setRoster(presence);
window.addEventListener("pagehide", () => presence.leave());

// The owner's way between pages and the hub (RLM-358): never for a reviewer or a hosted page. The header's
// breadcrumb, copy switcher and quick switcher are React (review-nav.tsx); this reads what the address asks for.
if (OWNER && !HOSTED) startNav();

refreshPending();
if (HOSTED) void startHosted();
else {
  loadFrame();
  connect();
}
