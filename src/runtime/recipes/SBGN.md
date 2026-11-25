Write it as `Architecture(nodes, edges, groups)`. A Node with tag `"species"` for each molecule, and a Node with tag `"process"` and tone `"strong"` for each reaction. Join them as species, process, species: never two species or two processes. An Edge with no style is consumption or production. Write modulation as `Edge(enzyme, process, "catalysis", "dashed")`. Put the compartment in a `"region"` Group.

## Use for
A biological process as species and reactions: what a reaction consumes, what it produces, and in which compartment.

## Not for
- Systems of services: Architecture.
- Decision logic: Flowchart.
- Containment with no reaction: Nested.
- A quantity that splits along a path: Sankey.

## Limits
- This is not SBGN notation. A Node cannot draw the square process glyph, the empty-set source and sink, or the circle head of a modulation arc. A tag, a tone and an edge label say it in words.
- A reversible reaction is two edges.
- About 6 species and 3 reactions.

## Usual errors
- An edge between two species. Add the process Node.
- A modulation edge with no label. The label says whether it activates or inhibits.
- Several compartments. Draw one Group.
