Write it as `Architecture(...)` with the change on each part: tone `"success"` and tag `"added"`, tone `"warning"` and tag `"changed"`, tone `"danger"` and tag `"removed"`. Draw a removed link as `Edge(a, b, label, "dashed", "danger")` and a new one with tone `"success"`. A part that did not change gets no tone. For two full snapshots, put two `Architecture` statements in `Tabs` (Before, After) with the same node order, and add a `Table` that lists each change.

## Use for
A migration, service extraction or redesign that shows what appears, disappears or changes between two states of one system.

## Not for
- One snapshot of a system: Architecture.
- A change in settings with no change in links: a Table of old and new values.
- The order, downtime or cause of the migration: Timeline.
- Where software runs, by host and zone: Deployment.

## Limits
- About 8 parts and 10 links across both states. Split a bigger migration into named subsystems.
- A moved part has no position change: say it in a tag (`"moved"`) and in the table.
- Tags and tones are the only marks: no strike-through.

## Usual errors
- One tone for every part. Leave unchanged parts plain, so the changes stand out.
- Tone without a tag. Colour alone is lost in print; add the word.
- Different node order in the two tabs. The map shifts and the reader loses it.
- Showing the steps of the migration. That is a Timeline.
