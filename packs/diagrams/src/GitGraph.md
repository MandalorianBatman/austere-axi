## Use for
What happened on which branch: a branching model, a release and hotfix flow, a backport, rebase against merge. Time reads left to right, one lane for each branch.

## Not for
- Events on a calendar with no branches: Timeline.
- Ownership and handoffs: the Swimlane recipe.
- Duration and overlap: Gantt.
- Package or service dependencies: Architecture.

## Limits
- 2 to 5 lanes, main first (it draws on top). `check` warns above 5.
- 4 to 16 commits, listed in time order. Each takes one column.
- `GitCommit(message, lane, branchFrom?, mergeFrom?, tag?, focus?)`. `lane` is a name from the lanes list.
- A commit follows the previous commit on its lane. The first commit on a lane names the lane it is cut from in `branchFrom`.
- `mergeFrom` names a lane: the commit merges that lane's latest commit into its own, and is drawn with a ring. A merge has two parents, on different lanes.
- `tag` (`"v1.2.0"`) puts a label above the commit. `focus: true` marks the hotfix or the release; two at most.
- Only a merge, a `focus` commit and a tagged commit show their message on the graph, cut at about 24 characters; every commit's full message shows on click. Name those, and keep the messages short.
- The graph is wider than a phone: it scrolls sideways there, lane names stay on the left.

## Usual errors
- Cutting a branch from the merge commit itself. The cut and the merge then share one vertical line. Add a commit on the source lane after the merge, then cut from that.
- A `branchFrom` or `mergeFrom` that names a lane with no commit yet. The link is dropped and the page reports it.
- A lane name that is not in the list. The lane is added at the bottom.
- Commits out of time order. The columns follow the list.
- A merge written as a plain commit. Use `mergeFrom`, or the two parents are not drawn.
- `focus` on many commits. Two are ringed; the rest are dropped.
