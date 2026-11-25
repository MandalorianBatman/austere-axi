## Use for
A whole that splits into parts when the relative sizes are the story: disk or bundle usage, spend by line, market share, time by activity. The reader asks what dominates, and by how much.

## Not for
- A ranked list where exact values matter more than proportion: BarChart.
- Containment or scope with no quantity: Nested.
- A hierarchy to trace from parent to child: Tree.
- Parts of 100 in whole numbers: UnitGrid.

## Limits
- `Treemap(labels, values, unit?, focus?, groups?)`. One number above 0 for each label. Area is the only encoding.
- 4 to 8 cells. `check` warns above 8. Merge the tail into one named "Other" cell and say what it holds. Never drop a small part: the whole must stay whole.
- `groups` is one parent name for each label, same order: it adds a second level, each group a box with its name. No third level. A label with an empty group goes in "Other".
- A value of 0, negative or missing is not drawn and is reported.
- Large cells show name, value and share; medium ones name and value; small ones the name. A cell too small for text is listed under the figure.
- `focus` is the label of the one cell to outline. It need not be the largest.
- A click on a cell reaches the agent as `label: value (share)`; a click on a group box as the group's total.

## Usual errors
- More than 8 cells. The tail becomes slivers no one can read.
- Percentages as values that do not add to 100 when the whole is 100: the share is computed from the values.
- Using colour as a second value. Fill follows rank only.
- Two levels written as one list: use `groups`.
