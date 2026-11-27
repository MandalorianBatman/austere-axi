# Accessibility

austere-axi should work for everyone who reviews an agent's work: the review page, the hub, and agent-written pages. Below: what works, what does not, and how to report a barrier.

## Supported environments

- **Browsers:** current Chrome and Firefox. The browser suite runs the review loop in headless Chrome, with one check in Firefox.
- **Screens:** desktop, and narrow screens down to 390 px, where the side panel becomes a bottom sheet.
- **CLI:** plain-text output, screen-reader readable in any terminal.

## What works

- Review page controls are native buttons, inputs, selects and `<dialog>` elements.
  - Labels on icon-only buttons (`More`, `Close`), the mode switch, presence and attach controls.
  - Toggles expose state: Annotate/Explore and Changes (`aria-pressed`), Agent attach (`aria-expanded`).
- Keyboard:
  - `Ctrl+I` (`⌘I` on macOS) switches Annotate and Explore.
  - In the note box and composer, `Enter` sends or queues; `Shift+Enter` adds a line.
  - `Escape` closes the empty note box, the Agent panel and the notes sheet.
  - While the Agent or History panel covers the notes, the notes, queue and composer take no focus.
- Text selected with the keyboard (`Shift` + arrows) can be annotated, like mouse selections.
- The hub has labelled search and filter fields and a visible focus outline.

## Known limitations

- **Picking a part to annotate needs a pointer.** No keyboard way to move between parts yet. Workaround: select text with the keyboard and annotate it, or write the note in the composer and name the part.
- **Motion:** changed parts flash after updates; `prefers-reduced-motion` is not followed yet.
- **Screen readers:** the review page is untested with one. New notes and agent replies are not announced.
- **Agent-written pages:** accessibility depends on the OpenUI and pack components and on what the agent writes; `austere-axi check` does not check accessibility.

## Report a barrier

Open an issue at <https://github.com/MandalorianBatman/austere-axi/issues/new> with:

- what you were trying to do and what stopped you,
- your browser, OS, and any assistive technology (screen reader, magnifier, voice control, switch access) with version,
- the output of `austere-axi --version` (or `npx -y austere-axi --version`).

To report privately, write to sid.kasat@gmail.com.
