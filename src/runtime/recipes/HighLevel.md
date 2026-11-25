Write it as `Architecture(nodes, edges, groups)`: one Node for each component in the stack, edges for the flow from source to dashboard, a `"region"` Group for the platform or cluster, and nodes outside it for the sources and the viewers. Put the phase (Ingest, Store, Query) in each node's tag. Cross-cutting parts (orchestration, security, monitoring) are one Node each, joined with dashed edges.

## Use for
An end-to-end overview of a data stack or platform: sources, ingestion, storage, query and analytics, and the cluster that runs them.

## Not for
- One service and its direct links: Architecture.
- Which sources and consumers plug into a platform, by protocol: DPIntegration.
- Who does what at each stage: DataFlow.
- Hosts, replicas and zones: Deployment.

## Limits
- About 8 to 15 nodes. Past that, split it into an overview and one diagram for each area.
- 1 region Group, and 1 or 2 plain or security Groups inside it.
- No phase banner. A tag on each node carries the phase.

## Usual errors
- Listing every product. Show the role each one fills and name the tool in the detail line.
- A Node no Edge reaches. Connect it or remove it.
- Drawing cross-cutting parts with an edge to every node. One dashed edge to the platform is enough.
