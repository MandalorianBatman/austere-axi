## Use for
Who owns what: a team, an agent crew, a support escalation map, a routing map for incoming work, role ownership, a launch roster.

## Not for
- Generic parent and child (a taxonomy, a module tree): Tree.
- A process with steps and handoffs in time: Swimlane or Flowchart.
- Parts of a system and their links: Architecture.
- Who may do what to which resource: a Table of roles and access levels (no matrix type yet).

## Limits
- 12 nodes. More: an overview chart and one chart for each team.
- 4 levels. 5 direct reports under one parent; more means a team node between them.
- One front door. Give `tone: "strong"` to the one Person who receives unclear work.
- A node says what it owns in 2 to 4 words in `role`, or how to reach it (`@billing-bot`, a queue). Put long job text in a card below.

## Usual errors
- A manager as a string. Pass the Person name: `Person("Sam", "Backend", lead)`.
- A missing node drawn as a normal one. Use `"gap"` (dashed) for an owner not set up yet, so the hole shows.
- Every box the same. Use `"team"` for a group, `"agent"` for software, `"person"` for one human.
- An approval gate drawn as a manager. Dotted lines are for a second boss; write approval rules in a note.
- Two people with no `reportsTo`: two roots. `check` warns. Give one a manager, or draw two charts.
- A person left out of the list: the page reports it and draws it anyway.
