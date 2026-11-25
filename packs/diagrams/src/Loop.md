## Use for
A reinforcing cycle: the last step feeds the first, and each pass writes to one shared centre. Flywheels, feedback loops, operating loops.

## Not for
- A process that ends or branches: Flowchart.
- A cycle with no shared state in the middle: Steps, or a Loop without a hub.
- States with events between them: StateMachine.

## Limits
- 2 to 8 steps. `check` warns above 8: split into an overview and detail loops. 5 to 8 reads best.
- `LoopStep(name, detail?, writes?, focus?)`, in clockwise order from the top. The last step always leads back to the first.
- `hub` is one `LoopHub(name, detail?)`: the shared state the loop writes to, such as a record or a playbook. With a hub, every step draws a dashed arrow to it; `writes` labels that arrow (one or two words).
- One step may have `focus`: the gate a person decides at.
- Without a hub, it is a plain cycle. Say so by leaving the hub out.

## Usual errors
- A loop that never returns to its first step. That is a Flowchart.
- Two hubs. Draw two loops.
- Long `writes` labels. They are cut; put the detail in the step.
- Using `focus` on more than one step.
