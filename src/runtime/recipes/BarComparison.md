Write it as `BarChart(labels, [Series(name, values)])`; use HorizontalBarChart when the labels are long. For a small chart, pass a height in pixels as the last argument: `BarChart(labels, series, null, null, null, 200)`.

## Use for
One value compared across categories or periods: sprint velocity, cost by service, adoption by team.

## Not for
- A trend over many periods: LineTrend (LineChart).
- How two values move together: ScatterPlot (ScatterChart).
- Parts of one whole: PieChart, for 2 to 5 parts.

## Limits
- 4 to 8 bars. More: group the categories, or split the chart.
- Up to 2 series side by side ("grouped"); "stacked" when the parts add up to a total.

## Usual errors
- Labels and values of different lengths. Each Series has one value for each label.
- Numbers as strings ("12"). Write numbers.
- Long labels under vertical bars. Shorten them or use HorizontalBarChart.
