## Use for
Messages between actors in time order: a login request across browser, API and database, an OAuth refresh, a webhook retry, an incident reconstructed call by call.

## Not for
- Parts and their links with no order: Architecture.
- Decision logic with many branches: Flowchart, when it ships; until then, Steps.
- Two actors and one line each way: a Table or a short list.

## Limits
- 5 actors. More: split into an overview and a detail diagram. Columns keep a legible width and the diagram scrolls sideways on a phone.
- 12 messages in all, those inside a Branch too. More: split at the failure or refresh path.
- One Branch is usual. A Branch holds Messages only: no Branch in a Branch. `alt` takes a second region (an else guard and its messages); `opt` and `loop` take one.
- One main result: give `"emphasis"` to a single Message.

## Usual errors
- A Message from an Actor that is not in the actors list. It is added as the last column and the page reports the problem. List every Actor.
- Messages in the wrong order. They draw top to bottom in list order; a reply goes after its call.
- Messages as strings. Pass Message statement names, and Actor names inside Message.
- A return drawn as a call. Use `"return"` for replies, `"async"` for one-way events and beacons.
- Free-floating "if" arrows. Put the branch in a `Branch("alt", "guard", [...])`.
