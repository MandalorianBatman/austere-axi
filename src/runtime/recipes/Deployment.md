Write it as `Architecture(nodes, edges, groups)`, direction `"auto"`. A `"region"` Group for each zone or environment, a plain Group nested in it for a cluster or a host (give the smaller Group a subset of the members). One Node for each host, pod or managed service. Put what runs there in the detail (`"api:2.4.1 x3"`) and the kind of host in the tag (`"POD"`, `"VM"`, `"MANAGED"`).

## Use for
Where software runs: which hosts or pods sit in which zone, behind which boundary, at how many replicas and which versions.

## Not for
- What talks to what, with no placement: Architecture.
- Before and after a move: ArchitectureDelta.
- The order of a rollout: Timeline.

## Limits
- 2 or 3 zones, 2 nesting levels, about 12 nodes.
- A replica count is text in the detail line; there is no badge.
- Two detail lines at most.

## Usual errors
- Logical services with a hostname added. Show a placement choice: a zone, a replica count or a version that matters.
- Groups that overlap with no nesting. Nest one in the other, or remove the shared node from one.
- A zone with one node and no boundary meaning. Drop the zone.
