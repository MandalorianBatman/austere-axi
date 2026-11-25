Write it as `Architecture(nodes, edges, lanes, "lanes")`: one Group for each actor, one Node for each step. Leave each Node's kind out: the kinds (frontend, database, …) name system tiers, and mixing them adds a legend of those words. Mark the step that matters with a tone instead (`"strong"`, or `"danger"` for a risk).

## Use for
A process that crosses teams, with the handoffs between them: a release train, a vendor onboarding, an on-call escalation.

## Not for
- One system's parts and their links, with no owners: Architecture.
- An ordered method one actor runs: Steps.

## Limits
- About 4 lanes fit a laptop; more scroll sideways, and phones stack them as bands.
- Edge labels of one or two words. Long labels widen every lane, and `check` warns when the lanes no longer fit.
- About 12 steps. More: split it into two diagrams at a handoff.

## Usual errors
- A step in two lanes. Give each Node one owner.
- A Node in no lane. Put every Node in exactly one lane Group.
- Lanes in random order. List them in the order the work reaches them, so most arrows run left to right.
- Pinning `row` on every Node. Pin a row only to line two steps up.
