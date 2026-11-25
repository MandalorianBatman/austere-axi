## Use for
Where 2 or 3 sets meet: shared traits, "where A meets B", a frame such as desirable, feasible and viable. Each overlap has its own name.

## Not for
- 4 or more sets: Heatmap (sets against traits).
- Parts inside a whole, or one set inside another: Nested.
- Exact counts shared between sets: a table.

## Limits
- 2 or 3 sets. More are not drawn.
- `VennSet(name, size?, detail?)`. With a `size` on every set, circle area follows it; with none, circles are equal. Do not fake sizes.
- `VennOverlap(label, of, focus?)`. `of` lists the exact set names: two for a lens, three for the centre. With 3 sets, a pair means "these two and not the third".
- A region with no `VennOverlap` stays blank. Name the ones that matter.
- One overlap may have `focus`: the sweet spot. It is tinted.
- Long text is wrapped to the room in its region, then cut. Keep labels short.

## Usual errors
- An `of` name that differs from the set name. The overlap is dropped and the page says so.
- Two overlaps naming the same sets.
- An overlap naming one set. Name the set in its own label.
- Circles with no overlap: that is not a Venn. Use a list.
