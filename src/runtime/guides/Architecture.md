## Use for
Components and the connections between them in one snapshot: services, stores, queues, external systems and the trust boundaries around them.

## Not for
- Work that passes between teams in order: Swimlane (Architecture with lanes).
- Messages in time order between a few actors: Sequence.
- A short ordered method with no branches: Steps.

## Limits
- About 8 to 15 nodes. Past that, use lanes, or split it into an overview and a detail diagram.
- Up to 3 flat groups side by side; nest a group inside another only when the nesting is the point (a subnet in a VPC).
- About 4 lanes fit a laptop; more scroll sideways. Phones get the lanes stacked as bands.

## Usual errors
- Passing strings to Edge: write `Edge(api, db)` with the Node statement names, not `Edge("API", "DB")`.
- A Node no Edge reaches. It floats alone; connect it or remove it.
- Coordinates or sizes: there are none. Order the nodes list and the edges; the layout does the rest.
- Every Node in a danger tone. Mark the one risk the reviewer must see.
- An arrow both ways when one direction is plain from context.
