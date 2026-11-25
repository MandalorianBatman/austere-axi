## Use for
Finite states and what moves between them: an order status, an auth session, a connection lifecycle, a job queue, a form wizard. Events, guards and legal transitions are the point.

## Not for
- Messages between actors in time order: Sequence.
- System parts with no order or events: Architecture.
- One path with no events or branches: Steps.
- Decision logic that ends in an action: Flowchart.

## Limits
- About 5 to 12 states. More: split the machine at a clear boundary.
- At most twice as many transitions as states. More is likely two machines; `check` warns.
- One `initial` state. Add a `final` state for each real ending, or none.
- Tone only for what the reader must notice: `danger` on the error state, `success` on the happy end.

## Usual errors
- A transition with no event. Say what triggers it; only the arrow out of an initial state or into a final state may be bare. `check` warns.
- Guard and action in the event text. Use the three arguments: `Transition(a, b, "pay", "stock > 0", "reserve")` draws `pay [stock > 0] / reserve`.
- "From any state" arrows from every state. Draw one transition from the state that matters, or say it in a Callout.
- Strings in a transition. Pass State names: `Transition(a, b, "go")`, not `Transition("A", "B")`.
- A state that is missing from the states list. List every state; the page reports a missing one.
- A pair of transitions that undo each other with the same event. Give each its own event.
