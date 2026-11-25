## Use for
Rows against columns with a number in every cell, where one cell or a cluster of cells is the story: failure rate by service and sprint, tickets by team and weekday, a confusion matrix, correlations.

## Not for
- Comparing a few values or a trend: BarChart or LineChart.
- Cells that are words, not numbers (access levels, status): PermissionMatrix, or a Table.
- Parts of one whole: UnitGrid.
- Rows and columns whose cells name linked items: Traceability.

## Limits
- 8 columns, 7 rows. `check` warns above both. Fewer than 3 rows or columns: a Table says it with less ink.
- Give every `HeatRow` one value for each column, in column order. `null` or text that is not a number shows `–` and takes no fill.
- The value is printed in every cell, so the fill is never the only signal. A lighter fill is a higher value.
- `focus` on a `HeatRow` names a column: that cell is ringed and left out of the scale, so an outlier does not flatten the rest. One focal cell at most; use none when no cell is the point.
- `unit` (`"%"`) is printed after each value.

## Usual errors
- A row with more or fewer values than columns. The extra are dropped; the missing show `–`.
- `focus` set on several rows. Only the first is drawn.
- A row or column left out because it spoils the pattern. Draw all of them and say what is excluded in the text around the figure.
- Asking for a colour for each row or column. There is one ramp; the labels carry the category.
