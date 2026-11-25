## Use for
A snapshot of work by state: what is queued, what is moving, what is stuck, and where a WIP limit is broken. A sprint board, a release checklist by state, a review queue.

## Not for
- Work that moves between owners, with handoffs and arrows: the Swimlane recipe.
- Ordered steps with arrows: Steps, or Flowchart.
- A story told in order, cut into releases: StoryMap.
- One card for each person: OrgChart.

## Limits
- 5 columns, 12 cards in all. `check` warns above both. More cards: replace a long backlog with one card (`"+14 more"`), or split the board.
- Give each column that work passes through a limit; the first and last columns need none. Pass `limits` in column order, `0` for no limit.
- `column` is the name of a listed column, any case. An unlisted name adds a last column and reports a problem.
- Cards draw top to bottom in list order. Put the oldest first.
- A card has no "blocked by" field: say what blocks it in `detail` (`"waiting on AX-12"`) and give it `state` `"blocked"`. For a chain of blockers, use DependencyGraph.

## Usual errors
- `limits` shorter than `columns`. The missing ones mean no limit.
- A card per column name typed differently ("In Progress" against "Doing"). List the column names once and copy them.
- Arrows between cards. There are none: a board shows state, not flow.
- `state` on every card. One or two `"blocked"` cards stand out; ten do not.
- A card for a person. That is an org chart.
