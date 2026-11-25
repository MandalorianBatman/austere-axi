Write it as `Architecture(nodes, edges, lanes, "lanes")` with three lanes in this order: sources, the platform, consumers. One Node for each system. The edge label names the protocol (`"JDBC"`, `"SFTP"`, `"REST"`). Mark the core component with tone `"strong"` and a federated or on-demand link with `"dashed"`.

## Use for
The integration points of a data platform: which source systems plug in, which consumers plug out, and which protocol each uses.

## Not for
- Phases or time, from ingest to dashboard: HighLevel.
- Who does each stage: DataFlow.
- The state before the platform: ITCurrentState.
- One system's internals: Architecture.

## Limits
- Up to 6 sources and 6 consumers. About 4 lanes fit a laptop; phones stack them as bands.
- The platform lane holds the components that the integrations touch, not all of them.
- One protocol on each edge.

## Usual errors
- A source that connects to no platform node. Connect it, or leave it out.
- Protocol missing from the edge label. It is the point of this type.
- A consumer in the source lane. Edges run left to right.
