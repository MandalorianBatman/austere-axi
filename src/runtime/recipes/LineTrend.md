Write it as `LineChart(labels, [Series(name, values)])`.

## Use for
A trend over time or over releases, where the direction and the rate of change are the message: latency by release, sign-ups by week.

## Not for
- A few categories with no order: BarComparison (BarChart).
- How two quantities relate: ScatterPlot (ScatterChart).

## Limits
- 4 to 12 points. More: add them up by week or month.
- Up to 5 series. More: split the chart or keep the ones that matter.

## Usual errors
- Uneven periods on equal spacing (Jan, Feb, Jun). Fill the gaps or say so in the axis label.
- Values of different lengths than the labels.
- "natural" smoothing on sampled data. The default straight lines are honest.
