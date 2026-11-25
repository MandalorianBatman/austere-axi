## Use for
Items scored on two measures at once, to see which quadrant each falls in: impact against effort, reach against frequency, a portfolio map. Position carries the meaning.

## Not for
- Four named futures with no positions inside: Architecture with groups, or a Heatmap.
- Many items or a trend: ScatterChart.
- A ranking on one measure: BarChart.

## Limits
- 12 items at most. `check` warns above that. Cluster or split beyond it.
- `QuadrantItem(label, x, y, focus?)`: `x` runs left to right and `y` bottom to top, both from 0 to 100. Out of range is drawn at the edge and reported.
- `Quadrant(items, xAxis, yAxis, quadrants?)`: axis names are one word each (`"Effort"`), shown at the end where the value is high. `quadrants` has four names in order: top left, top right, bottom left, bottom right.
- One item may have `focus`: the one to do first. Two erase the signal; the second is drawn plain.
- Labels are placed so none overlaps another or crosses an axis. If none can, the page reports it.

## Usual errors
- An item at 50 on either measure. It sits on an axis, so its quadrant is unclear.
- Axis names with "high" or "low" in them, or a long phrase. One word.
- Quadrant names that repeat the axis names. Name the action: "Do first", "Drop".
- Two items at the same point. Spread them or merge them.
