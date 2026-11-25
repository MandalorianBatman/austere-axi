Write it as `Architecture(nodes, edges)`: one Node for each package, module or service, and `Edge(a, b)` for "a depends on b". Put the fan-in in the tag (`"4 in"`) on the shared nodes. Mark the one cycle with tone `"danger"` on its edges and `"dashed"` on the edge that closes it. Use kind `"external"` for a third-party dependency.

## Use for
What depends on what, where a node has more than one parent (a shared dependency) or where a cycle exists.

## Not for
- Every node has one parent and there is no cycle: Tree.
- Task durations and the critical path: ScheduleNetwork.
- Requests in time order: Sequence.
- Boxes of a runtime system: Architecture.

## Limits
- About 8 to 15 nodes. Past that, show one subsystem, with its dependencies collapsed to one external node.
- One cycle shown. Name the others in text.
- The layout decides the rank; you do not set it.

## Usual errors
- Edges drawn from dependency to dependent. Point each edge from the one that needs to the one it needs.
- Every edge in danger tone. Only the cycle.
- Transitive edges drawn in full. Keep direct dependencies only.
