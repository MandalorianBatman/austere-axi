## Use for
Parent-to-children structure with one root: a taxonomy, a work breakdown, a module tree, a skill tree, a decision broken into parts, the causes under a failure.

## Not for
- People, agents or teams and who owns what: OrgChart.
- A graph where a node has two parents, or that loops: Architecture, or the Dependency graph recipe.
- A list of files with change marks: FileTree.
- Scope by boxes inside boxes: Nested.
- Levels of abstraction stacked top to bottom: LayerStack.

## Limits
- One root. Nodes that name no parent are roots; `check` warns on a second one.
- 4 levels, the root counting as one. Deeper: split at a clear branch into two trees.
- 5 nodes on one level. More: add a node that groups siblings.
- Give `tone: "strong"` to one node, the root or the critical leaf. Not both.

## Usual errors
- A parent as a string. Pass the TreeNode name: `TreeNode("API", skRoot)`, not `TreeNode("API", "Platform")`.
- A node left out of the list. List every TreeNode; the page reports a missing one and draws it anyway.
- Two parents. A node has one `parent`. Shared children need Architecture.
- Order and coordinates: there are none. Siblings draw in list order; the layout does the rest.
