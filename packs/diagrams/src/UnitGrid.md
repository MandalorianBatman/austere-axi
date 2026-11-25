## Use for
One whole counted in 100 equal units and split into named parts: how much of a checklist passes, a share of survey replies, capacity used. The exact count is the point.

## Not for
- Comparing categories: BarChart.
- Parts of unequal size: BarChart. Parts inside parts: Nested.
- A value over time: LineChart.
- A whole that is not naturally 100 units: say what one unit is, or use a chart.

## Limits
- Exactly 100 squares, filled left to right, top to bottom, in the order of the parts.
- 6 parts at most. `check` warns above that. Each part has its own shape and colour, so the grid reads in grayscale.
- `count` is a whole number. A fraction is rounded, and the legend says so ("counted 63.4"): never round without saying.
- Counts that add up to less than 100 leave a `Remaining` part. More than 100 is cut and reported.
- `unit` says what one square is ("release check"); it shows under the grid.

## Usual errors
- Percentages that do not add up. Check the sum before drawing.
- A count of 0 for a part. It has a legend line and no squares.
- A denominator that is not 100 (47 of 60). Convert it, and say so, or use a BarChart.
- Reading rows or columns as categories. They carry no meaning here.
