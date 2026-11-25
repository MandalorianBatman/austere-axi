Write it as `Architecture(nodes, edges, lanes, "lanes")`: one Group for each actor or division, one Node for each step. Put the tool in the detail line (`"Excel · CSPro"`), the payload that leaves the step on the edge label, and mark a gate or the step that matters with tone `"strong"`.

## Use for
A step-by-step business process where the reader needs to see who does each step, what data goes in and out, and which tool is used.

## Not for
- Who hands work to whom, with no data or tools: Swimlane.
- A method one person runs: Steps.
- Visible and hidden work for a customer: ServiceBlueprint.
- Data that moves between roles in a pipeline: DataFlow.

## Limits
- Up to 6 lanes and about 12 steps. Past that, split it at a handoff.
- About 4 lanes fit a laptop; more scroll sideways, and phones stack them as bands.
- One payload word on each edge (`"CSV"`, `"report"`).

## Usual errors
- A step in two lanes. Give each Node one owner.
- Detail text of a sentence. Keep it to a tool name, in two lines at most.
- Lanes in random order. List them in the order the work reaches them.
