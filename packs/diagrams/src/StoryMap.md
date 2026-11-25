## Use for
The whole story of a product in order, and where the first release is cut: activities across, stories under each, release slices down. Scoping an MVP, planning what ships first.

## Not for
- Work by state (todo, doing, done): Kanban.
- One person's feelings across stages: UserJourney.
- A plan on a date axis: Timeline, or Gantt.
- A ranked list with no story order: a Table.

## Limits
- 5 activities, 12 stories, 3 slices. `check` warns above each. More: one map for each activity.
- Activities run in the order a person meets them, left to right. Priority runs top to bottom: the first slice is the first release.
- `cut` is the number of slices above the cut line; the default is 1. Always pass `slices`: a map with no cut is a backlog in a grid.
- Mark one Story `risk: true`: the one most likely to move the date.
- `detail` is a ticket or an estimate, one short line.

## Usual errors
- No `slices`. The map then has no release cut, and the page reports it.
- Activities sorted by priority. Sort them by the order of the story; priority is the row.
- A Story with an unlisted activity or slice. It adds a last column or row; fix the name.
- Every story marked `risk`. One is a finding; five is noise.
- Task-sized stories. A story is something a person can do and see.
