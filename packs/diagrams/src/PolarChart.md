## Use for
One series across 4 to 8 categories whose clockwise order means something: requests by 3-hour window, incidents by weekday, signups by month. The length of each ray is the value.

## Not for
- Several entities scored on the same criteria: Radar (`RadarChart`).
- Categories with no cycle: BarChart.
- More than 8 ordered buckets, or a trend: LineChart.
- Parts of a whole: UnitGrid or Treemap.

## Limits
- `PolarChart(labels, values, unit?, focus?, max?)`. One value for each label, in circular order, starting at the top and going clockwise. Never sort by value.
- 4 to 8 categories. `check` warns above 8.
- The scale starts at 0 at the centre. `max` sets the outer ring; without it the ring is the next round number above the largest value. A value above `max` raises it.
- `focus` is the label of the one ray to stress. Use none when no category is the point.
- A value of 0 draws no ray and prints `0`. A missing value (`null`, text) prints `–` and is reported: it is not drawn as 0. A negative value is not drawn.
- A click on a ray or its label reaches the agent as `label: value`.

## Usual errors
- Labels and values of different length. They pair by position; the extra are dropped.
- Categories sorted by size. The circle then means nothing.
- A `focus` that does not match a label exactly.
- Several series: use Radar, or two charts.
