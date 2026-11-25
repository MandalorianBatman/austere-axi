## Use for
Which requirements have a design element that satisfies them and a test that verifies them, and which do not. Use it only when the IDs and links come from sources you were given.

## Not for
- Package or service dependencies: Architecture.
- Cells that hold a number: Heatmap.
- Types and inheritance: ClassDiagram.
- Many-to-many data with dozens of rows: a Table.

## Limits
- 6 requirements. `check` warns above that. Split the trace by area.
- Each `TraceReq` has a stable `id` and a `source` (optional; the Source column shows only when one is set). Each `TraceItem` has its own `id`, a `kind` (`design` satisfies, `test` verifies) and `covers`, the requirement IDs it links to.
- One item may cover several requirements and shows in each row.
- A requirement with no design element or no test shows `No linked element` or `No verification`, marked as a gap. Never invent a link to fill it.
- IDs match ignoring case.

## Usual errors
- A `covers` ID no requirement has. The link is dropped and reported.
- An item that covers nothing, or has `kind` other than `design` or `test`. It is not drawn.
- One test reused for every requirement without checking it verifies each. A link is a claim.
- An illustrative trace presented as evidence. Say in the text that it is an example.
