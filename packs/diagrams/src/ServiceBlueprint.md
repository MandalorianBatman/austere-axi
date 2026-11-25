## Use for
How a service really runs across a few stages: what the customer does, what they can see, and what stays hidden behind the line of visibility. A failed payment that is really a billing job.

## Not for
- Feelings across stages, no backstage: UserJourney.
- A flow with handoffs and arrows: the Swimlane recipe.
- Calls between systems in time order: Sequence.
- State by column: Kanban.

## Limits
- 4 to 6 stages; `check` warns above 6. One action for each stage and layer, 24 steps at most.
- Layers, top to bottom: `evidence` (optional), `customer`, `frontstage`, `backstage`, `support` (optional). The line of visibility sits between frontstage and backstage. `support` is what the backstage depends on: shared systems, vendors, other teams.
- A layer a stage does not use stays empty. An empty cell is fine; say "not applicable" in the step if it matters.
- Mark one step `focus: true`: the failure or wait the diagram is about, usually on or under the line.
- `detail` is a system or a wait, one short line.

## Usual errors
- A layer name that is not one of the five. The step draws in the first row and the page reports it.
- Backstage work shown as frontstage. If the customer cannot see it, it goes under the line.
- Arrows between steps. There are none: stages give the order.
- Several actions in one cell. Split the stage.
- No `focus`. The reader then has no place to look first.
