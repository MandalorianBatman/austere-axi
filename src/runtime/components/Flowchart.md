## Use for
Decision logic with branches: "should I...?" routing, a support triage, an algorithm, an onboarding path that splits on answers, a retry rule.

## Not for
- Messages between actors in time order: Sequence.
- System parts and their links, with no order of steps: Architecture.
- One path with no branches: Steps.
- A thing that changes status over its life: StateMachine.

## Limits
- At most 3 exits from a decision. A fourth means nested decisions; `check` warns.
- About 8 to 15 shapes. More: split it at a clear handoff into two charts.
- One happy path: give `"emphasis"` to one link or one chain of links, not to every branch.
- Shape carries the type: oval for `start` and `end`, rectangle for a step, diamond for a decision. Use `tone` only for what the reader must notice (a risk, the outcome).

## Usual errors
- A link out of a decision with no label. Write the answer on every exit: `FlowLink(ok, done, "yes")`.
- A decision that is a statement. Write a question: "Status 2xx?", not "Check status".
- Strings in a link. Pass FlowStep names: `FlowLink(a, b)`, not `FlowLink("A", "B")`.
- A step the links never reach, or one left out of the steps list. List every step; the page reports a missing one.
- A diamond for a plain step. Use the default rectangle; keep diamonds for real branches.
- Coordinates or sizes: there are none. Order the lists; the layout does the rest.
