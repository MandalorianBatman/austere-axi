## Use for
Several entities (3 to 5) scored on the same 3 to 5 criteria, on one scale from 0: storage backends, frameworks, vendors, team scorecards. The shape of each polygon is the point; a Table runs out of room first.

## Not for
- One series across a cycle (hours, months): PolarChart.
- Two entities: a Table with two columns, or BarChart.
- More than 5 criteria or 5 entities: a Table or Heatmap.
- Criteria on different scales: normalise them to one scale first.

## Limits
- `Radar(labels, series, max?, unit?)`. `labels` are the criteria, one word each. One `RadarSeries(name, values, focus?)` for each entity, with one score for each label, in the same order.
- 3 to 5 criteria (`check` warns above 5) and 3 to 5 entities (warns above 5). A Radar with 2 entities reads better as a Table.
- The grid starts at 0 and the outer ring is the best score. `max` sets it; without it the ring is the next round number above the largest score. Never score from a higher floor to show gaps.
- Make outward mean better on every axis: invert a criterion where lower is better (cost, effort) and say so in the text.
- Name the scale in the text around the figure ("0 to 10, higher is better").
- `focus` marks one entity: its polygon is stressed and gets dots. Use none when no entity is the point.
- A missing, text or negative score is drawn as 0 and reported. A short `values` list is padded with 0 and reported.
- A click on a polygon or its legend entry reaches the agent as `name: label score, …`.

## Usual errors
- A `RadarSeries` with fewer values than labels.
- Mixed scales (0 to 100 next to 0 to 1).
- 6 or more entities: the polygons become a mat.
- Criteria that cannot be measured (colour, year).
