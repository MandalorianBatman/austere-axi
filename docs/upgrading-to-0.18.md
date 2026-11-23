# Upgrading to 0.18

0.18 rebuilds the page around the artifact, the review page and the hub, in React on shadcn/ui and Tailwind. No command, flag, route, stored note or published page changes. What changes is the markup of the owner's chrome, so this page matters only if you script the page (Playwright, a userscript) or load your own CSS into it, and for the new sidebar.

The artifact (the agent's page in its iframe) is untouched: it does not share React with the chrome, and its sandbox is as before. The full list is in the [changelog](../CHANGELOG.md).

## Class names and markup

| Before | In 0.18 |
|---|---|
| Hand-built DOM with the page's own classes (`.crumbs`, `.copy-switch`, `.qs*`, `.menu-pop`, `.seg*`, `.attach-state`, `.link-btn`, …) | shadcn components with Tailwind utility classes. The old classes are gone, so CSS or a selector that used them matches nothing. |
| Select by class | Select by role, name or `data-*`: `role="menu"`, `role="menuitem"` (the `⋯` items keep their `data-cmd`), `role="dialog"`, `role="option"`, `role="radio"`. |
| Tabs and toggles report `aria-current` / `aria-pressed` | Tabs report `aria-selected`; Annotate/Explore and the attach On/Off/default are `role="radio"` with `aria-checked` (the attach items carry `data-attach`, not `data-state`). |
| Dialogs are `<dialog>` | `role="dialog"` (Radix). Share and Archive are dialogs; the quick switcher is the dialog named "Go to page". |
| The `⋯` menu items are in the DOM | Radix menu: items exist only while it is open; a disabled item has `data-disabled`. |
| The Agent panel overlays the notes | A popover hung from the Agent pill. |
| The Conversation scrolls in its own element | It scrolls in the ScrollArea viewport (`[data-slot="scroll-area-viewport"]`). |
| The copy switcher is a `<select>` | A dropdown menu with radio items. |

`dist/chrome/chrome.js` grew because it carries React: 83 KB gzip before, 238 KB after. A hosted page loads under the service's CSP as before (no inline script, no `eval`; `style-src 'unsafe-inline'` is what Radix needs and austere-cloud already sends it).

## `dom.ts` and `nav.ts` are gone

| Before | In 0.18 |
|---|---|
| `src/chrome/dom.ts` (the `h()` helper) and the DOM icon builders in `icons.ts` | Deleted. Chrome code is `.tsx`; icons are components. |
| `nav.ts`, `nav.css` | Deleted. The header's breadcrumb, copy switcher, Ctrl/Cmd+K switcher and `⋯` menu are `review-nav.tsx` and `review-viewer.tsx`, state in `review-nav.ts`. |
| `chrome.ts` (one 3,800-line file, module-level state, `renderX()` calls) | A short boot. The page is `review-*.tsx` over one `zustand` store (`review-store.ts`); the hub is `shell.tsx` over `hub-store.ts`. |

This matters only if you patched or forked the chrome sources. The iframe bridge (`{ austere: 1 }` messages), the outbox, the boot object and the server routes are as they were.

## The projects sidebar

New on the owner's review page (local server only; a reviewer or a hosted page has none).

| Question | Answer |
|---|---|
| Open or folded at first | The **review page starts folded**; the **hub starts open**. A saved choice wins on both. |
| Where the choice is kept | `localStorage`, key `austere:sidebar-open` (`true` or `false`), shared by the hub and the review page. Folded projects share `austere:hub:closed-projects`. shadcn's `sidebar_state` cookie is no longer written. |
| Toggle | The button at the left of the header, or **Ctrl/⌘ B** (also with focus in the page). |
| Wide screens | The review page: 1100 px and up, a column that pushes the page. The hub: 768 px and up. |
| Narrower | A sheet over the page with a scrim; Escape closes it and focus returns to the toggle. The review page switches at **1100 px**, the hub at **768 px**. |

To reset a browser to the defaults, remove `austere:sidebar-open` from its `localStorage`. A folded sidebar is `inert`: it has no Tab stop.
