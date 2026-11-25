## Use for
Tasks as bars on a date axis: a project plan, a rollout, a roadmap. The reader sees what overlaps, what runs in parallel and where the milestones fall.

## Not for
- Durations, dependencies, the critical path and float: ScheduleNetwork.
- Events on a calendar with no duration: Timeline.
- Who does what and the handoffs: the Swimlane recipe.
- A branching history: GitGraph.

## Limits
- 12 tasks. `check` warns above that: split the plan by phase.
- `GanttTask(name, start, end?, progress?, owner?)`. Dates are `"YYYY-MM-DD"`, and `end` is inclusive.
- No `end` (or `""`) draws a milestone: one day, a diamond.
- `progress` is 0 to 100. A task at 100 is drawn as done.
- Tasks draw in the order given, so list them by start date. `owner` is a short label under the name.
- Same names and positions as the `austere-pack-gantt` pack: a page written for that pack draws the same.

## Usual errors
- A date like `"Nov 9"` or `"2026-11-31"`. The row stays, with its error in place of a bar, and the page reports it.
- `end` before `start`. Same.
- Start and end dates in the task name. The axis shows them.
- Dependency arrows. There are none: use ScheduleNetwork when the order of tasks is the point.
- Progress as 0 to 1 (`0.45`). It is read as 0.45 percent.
