Write it as `Architecture(nodes, edges, lanes, "lanes")`: one Group for each role (Engineers, Scientists, Consumers), one Node for each stage of the pipeline, in order. Put the tool in the detail line and the payload on the edge label (`"raw files"`, `"table"`, `"report"`). Mark a governance step with tone `"danger"` or `"warning"` and the stage readers care about with `"strong"`. `"dashed"` is for an async or on-demand hand-off.

## Use for
How data moves through a pipeline across roles: who ingests it, who changes it, who publishes it, who reads it, and lineage from source to report.

## Not for
- A business process with no data types: Swimlane or ProcessMap.
- Tiers of storage: Medallion.
- Systems and the protocols that join them: DPIntegration.
- Amounts that split along the path: Sankey.

## Limits
- Up to 4 lanes and 6 stages. About 4 lanes fit a laptop; phones stack them as bands.
- One payload word on each edge.

## Usual errors
- A stage with no payload on its out-edge. Name what leaves it.
- Roles that share a tool in one Node. Draw one Node for each role that acts.
- Lanes in an order that makes most arrows run backward.
