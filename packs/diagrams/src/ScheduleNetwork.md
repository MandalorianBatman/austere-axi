## Use for
Which chain of tasks decides the finish, and where the slack is. Tasks have durations and finish-to-start dependencies; the component works out the times and marks the critical path.

## Not for
- Dates and calendar overlap: Gantt.
- Dependencies with no durations, or with cycles: Architecture.
- Events or milestones with no duration: Timeline.

## Limits
- 2 to 8 tasks. `check` warns above 8: split the plan. Keep 5 ranks and 12 links at most.
- `ScheduleTask(id, name, duration, after?)`. `id` is a short unique code (`"A"`, `"DB1"`), `after` lists the ids that must finish first.
- `duration` is a number above 0, in the unit of the network (`unit`, default `"days"`). No zero-length milestones.
- No calendars, lag, deadlines or three-point estimates. Finish-to-start only.
- Each box shows ES, EF, LS, LF (earliest and latest start and finish), total float and CRITICAL or FLOAT. Total float is how long the task may slip without moving the finish.
- Boxes are not drawn to scale: the width of a box is not time.

## Usual errors
- An `after` id that is not a task. The link is dropped and the page reports it.
- A cycle (A after B, B after A). The link that closes it is dropped.
- A task with no links. Link it, or leave it off.
- Reading a long box as a long task. Read the DUR line.
- Treating every link between critical tasks as critical. Only a link that keeps no slack is drawn heavy.
