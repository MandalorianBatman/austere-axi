## Use for
Entities and how they relate: a domain model, the resources of an API, a data model before any tables exist. The story is what things are and how many of each connect (1:1, 1:N, N:M).

## Not for
- Tables with SQL types, constraints and `ON DELETE` rules: DatabaseSchema (it writes the same component).
- The classes of an object model, with operations and inheritance: ClassDiagram.
- System parts and the links between them: Architecture.

## Limits
- About 5 to 8 entities. More: draw one diagram for each cluster.
- Fields are the ones the model is about, up to about 12 for each entity. `check` warns past that.
- One line for each relation. Do not draw an arrow for every foreign key of a large model.

## Usual errors
- A relation with no cardinality. Say `"1:N"`, `"N:M"` and so on; `check` warns.
- A cardinality in the wrong direction. It reads from the first entity to the second: `Relation(customer, order, "1:N")` is one customer, many orders.
- Strings in a relation. Pass Entity names: `Relation(a, b, "1:N")`, not `Relation("A", "B", "1:N")`.
- Fields as nested objects. A field is one line: `"id uuid pk"`, `"email text unique"`, `"user_id uuid fk users.id"`.
- Padding every entity with every column. Show the story, not the dump.
- Tone on many entities. Mark the central one `"strong"`, once.
