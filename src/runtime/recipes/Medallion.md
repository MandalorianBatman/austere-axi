Write it as `Architecture(nodes, edges, lanes, "lanes")`: one Group for each tier, left to right (Raw, Cleaned, Curated, Archive). One Node for each bucket or table, with `"database"` kind, the format and the writer in the detail (`"Parquet\nData engineer"`). An Edge is a promotion: label it with the job. Mark the tier that readers use with tone `"strong"`.

## Use for
A storage layout in tiers (bronze, silver, gold or raw, staged, curated), with what each tier holds, who writes it and how data moves up.

## Not for
- Who does what at each stage: DataFlow or ProcessMap.
- The cluster that hosts the storage: HighLevel.
- Shares of a quantity that is split along a path: Sankey.

## Limits
- 3 to 6 tiers. About 4 fit a laptop; more scroll sideways, and phones stack them as bands.
- Up to 3 nodes in a tier. More: group them in the detail line.
- Two detail lines at most for each node.

## Usual errors
- A promotion edge that skips a tier with no reason. Say why in its label.
- Detail text that explains the tier. Name the format and the writer only.
- Marking every tier. One focal tier.
