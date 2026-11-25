## Use for
Hierarchy through containment, outer is broader and inner is more specific: scope boundaries, trust zones, blast radius, an account inside an organization, folders in folders.

## Not for
- Parts that sit side by side inside a boundary, or links between them: Architecture with groups.
- Parent and children with several branches: Tree.
- Stacked levels that are not inside each other: LayerStack.
- Anything inside a ring that is not part of the chain. Draw it in a second diagram.

## Limits
- 2 to 4 levels is usual. `check` warns above 6: detail disappears inward.
- One chain: each level holds exactly the next one. Siblings are not possible.
- Give `tone: "strong"` to one level, usually the innermost. With several, none stands out.
- `note` is one short phrase. Long text goes in a card below.

## Usual errors
- Inner level first. List the outermost level first.
- A level as a string. Pass the NestedLevel name.
- Two scopes side by side in one ring. Use Architecture with groups, or two diagrams.
- Sizes and padding: there are none. The nesting draws itself.
