Write it as `ERDiagram(entities, relations)`: one Entity for each table, one Relation for each foreign key. Write each column as `"name type marks"`: `"id uuid pk"`, `"user_id uuid fk users.id"`, `"email text unique"`, `"sku text index"`. Marks: `pk`, `fk` (with its target), `unique`, `index`, `nn`. Write each Relation from the referenced table to the one holding the key (`Relation(users, posts, "1:N", ...)`): the referenced table is drawn above. Say the column pair and the `ON DELETE` rule in its label: `"posts.author_id → users.id, on delete cascade"`. Tone `"danger"` on each table the cascade deletes rows from.

## Use for
The physical schema of a subsystem: real tables, SQL types, constraints, and what a delete does to the rows around it.

## Not for
- Conceptual entities, where the types are not the point: ERDiagram.
- An object model with operations: ClassDiagram.

## Limits
- At most 5 tables, 8 columns for each table and 6 foreign keys. More: show one subsystem and say so.
- The line joins the two tables, not the two columns. Name both columns in the label.
- List only the indexes that matter, as columns with `index`.

## Usual errors
- A column with no type. The type is half the content.
- A foreign key line with no label. The `ON DELETE` rule is what a reviewer looks for.
- Every column of every table. This is not a `\d+` dump.
- Chips on every row. Mark the key columns and the ones the argument needs.
- Entity names mixed with table names. Use one or the other.
