# Accessibility

We want everyone who reviews an agent's work to be able to use austere-axi: the review page, the hub, and the pages agents write. This file says what works today, what does not, and how to tell us about a barrier.

## Supported environments

- **Browsers:** current Chrome and Firefox. The browser test suite runs the review loop in headless Chrome, with one check in Firefox.
- **Screens:** desktop, and narrow screens down to 390 px wide, where the conversation panel becomes a bottom sheet.
- **CLI:** plain-text output, readable by a screen reader in any terminal.

## What works

- The review page's controls are native buttons, inputs, selects and `<dialog>` elements, with labels on icon-only buttons (`More`, `Close`) and on the mode switch, presence and attach controls. Toggle controls like Changes (`aria-pressed`) and Agent attach (`aria-expanded`) expose their state.
- Keyboard: `Ctrl+I` (`⌘I` on macOS) switches between Annotate and Explore. In the note box and the composer, `Enter` sends or queues and `Shift+Enter` starts a new line. `Escape` closes the note box when it is empty, the attach popover, and the conversation sheet.
- Text selected with the keyboard (`Shift` + arrow keys) can be annotated, the same as text selected with a mouse.
- The hub has labelled search and filter fields and a visible focus outline.

## Known limitations

- **Picking a part of the page to annotate needs a pointer.** Annotate mode finds the part under the mouse or a tap. There is no keyboard way to move between parts yet. Workaround: select the text with the keyboard and annotate the selection, or write the note in the composer and name the part.
- **Mode switch:** the Annotate and Explore buttons switch with `Ctrl+I` or click, but do not yet expose their selected state (`aria-pressed`) to screen readers.
- **Motion:** changed parts flash after the agent updates the page. The page does not yet follow `prefers-reduced-motion`.
- **Screen readers:** the review page has not been tested with a screen reader. New notes and agent replies are not announced as they arrive.
- **Agent-written pages:** components come from OpenUI and from packs. How accessible a page is depends on those components and on what the agent writes; `austere-axi check` does not check accessibility.

## Report a barrier

Open an issue at <https://github.com/MandalorianBatman/austere-axi/issues/new> and say:

- what you were trying to do and what stopped you,
- your browser, OS, and any assistive technology (screen reader, magnifier, voice control, switch access) with its version,
- the output of `austere-axi --version` (or `npx -y austere-axi --version`).

If you would rather not report it in public, write to sid.kasat@gmail.com.
