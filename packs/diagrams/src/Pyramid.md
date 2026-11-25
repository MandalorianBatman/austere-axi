## Use for
Ranked layers: a hierarchy of needs, a value stack, priority ranks. As a funnel (`"funnel"`), stages that lose members on the way down, with each layer as wide as its value.

## Not for
- Parts of a whole: UnitGrid or BarChart.
- Items with parents and children: Tree.
- A flow with branches: Flowchart.
- Many stages with exact figures to compare: BarChart.

## Limits
- 6 layers at most. `check` warns above that. Compress, or split in two.
- `PyramidLayer(name, value?, detail?, focus?)`. List layers top to bottom, as drawn. In a pyramid the top is the apex.
- Pyramid: the width is rank, not value. A `value` is printed as given.
- Funnel: give every layer a number. Widths are then to scale (widest layer is the first or largest) and the drop from the layer above is printed (`−38%`). Without values, the funnel is a taper and the caption says it is not to scale.
- One layer may have `focus`: the apex, the conversion layer or the bottleneck. Never the base.

## Usual errors
- A pyramid for data with no rank. Use a chart.
- Mixing both shapes. Pick one.
- Equal-looking steps when the values differ: give the values.
- A funnel whose values rise down the list. The widths show it honestly, but check the order.
