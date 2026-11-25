## Use for
A quantity that splits and merges across stages, where band width is the amount: a compute budget through test stages to outcomes, a spend allocation, volume through a pipeline. The reader compares magnitudes.

## Not for
- One quantity that only narrows, with no splits or merges: Pyramid (`"funnel"`).
- A plain sequence of steps: Steps or Flowchart.
- Signed steps from a start total to an end total: Waterfall.
- Stages without amounts: Flowchart.

## Limits
- `Sankey(sources, targets, values, unit?, focus?)`. Three lists of the same length: flow `i` goes from `sources[i]` to `targets[i]` with amount `values[i]`. A node is a name; the same name in two flows is one node (case does not matter).
- Stages follow the flows: a node sits one stage right of its furthest source. 3 stages read best; the page reports more than 4. Split into two linked Sankeys.
- 12 flows, about 8 nodes. `check` warns above 12 flows. Merge the small flows into one "Other".
- One scale for every band and bar. A node is as tall as the larger of what flows in and what flows out; a middle node that does not balance is reported.
- A value of 0, negative or missing is not drawn and is reported. A flow back to an earlier node (a loop) is dropped and reported. Two flows between the same nodes are added.
- `focus` is a node name: that node and every band that touches it are stressed. One only.
- A click on a band reaches the agent as `A → B: amount`; a click on a node as `name: amount`.

## Usual errors
- Lists of different length. The extra are dropped.
- A middle node whose in and out differ without a reason: say where the rest goes, as its own flow.
- A node spelled two ways (`Pass`, `Passed`): it becomes two nodes.
- A loop, such as a retry: draw the retries as their own node.
- Many thin bands: they cannot be read. Merge them.
