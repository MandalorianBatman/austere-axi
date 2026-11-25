## Use for
The static structure of an object model: classes, what they own, what they extend or implement, and what they only use. Operations and the six relationship kinds are the point.

## Not for
- Entities and cardinality, with no operations or inheritance: ERDiagram.
- Messages between objects in time order: Sequence.
- States and events: StateMachine.
- Deployed parts and services: Architecture.

## Limits
- At most 7 classes and 8 links; 4 or 5 classes is usual. `check` warns past that: split by package.
- At most 5 attributes and 5 operations for each class. Past that, `check` warns.
- Members are one line each: `"-id: UUID"`, `"+charge(amount): Receipt"`. Lines with `(` are operations; they draw below a rule.

## Usual errors
- Link direction. `inheritance` and `realization` run from the child to the parent: `ClassLink(circle, shape, "inheritance")`. `composition` and `aggregation` run from the owner to the part.
- Composition and aggregation used as one. Composition: the part dies with the whole. Aggregation: it lives on its own.
- An association with no multiplicity. Add `"1"` and `"0..*"` at the ends.
- Getters and setters as operations. Leave them out.
- A diagram with no inheritance and no operations. That is a data model: use ERDiagram.
- `interface` or `abstract` on every class. Use them only where they apply.
