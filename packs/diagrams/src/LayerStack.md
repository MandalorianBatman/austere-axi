## Use for
Levels of abstraction stacked top to bottom: the OSI model, a tech stack, how config or context overrides cascade, a memory hierarchy, a platform and what is built on it.

## Not for
- Boxes inside boxes: Nested.
- Layers that are not really above one another (parts and links): Architecture.
- Owners or phases of a process: Swimlane.
- Parent and children with branches: Tree.

## Limits
- 4 to 6 layers. `check` warns above 6.
- Top first. The first Layer draws at the top; say which way is "more" with `top` and `bottom`.
- `items` are short words (a protocol, a tool), not sentences.
- `tag` is an index (`"L4"`). Number them without gaps: a skipped number reads as a missing layer.
- Give `tone: "strong"` to one layer: the bottleneck, or the one under discussion.

## Usual errors
- Layers as strings. Pass Layer names.
- Bottom layer first. Reverse the list, or the stack reads upside down.
- Every layer tinted. One `"strong"` layer stands out; ten do not.
- Items that are really layers. If an item has its own parts, make it a Layer.
- Sizes and widths: there are none.
