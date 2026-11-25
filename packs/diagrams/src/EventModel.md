## Use for
Commands, the events they cause and the read models built from them, across ordered stages of a business scenario: placing an order, refunding a payment.

## Not for
- Calls and replies between actors in time order: Sequence.
- Data moving between systems: Architecture.
- Dated occurrences with no commands or views: Timeline.
- A branch or a decision: Flowchart.

## Limits
- 6 stages, 18 items. `check` warns above both. Richer scenarios: one overview and one detail.
- Three rows: `command` (a request, imperative: "Place order"), `event` (a fact, past tense: "Order placed"), `read-model` (a view: "Open orders").
- In a stage the command sits above its event and the read model below. One of each per stage is usual.
- Stage order is scenario order. It does not show elapsed time.
- `detail` is a line of field names.

## Usual errors
- An event named as an instruction ("Pay order" in the event row). Past tense for events.
- A read model drawn as another event. It is a view, not a fact.
- A `kind` of "read model" or "readmodel". Write `"read-model"`.
- No arrows: claims about links are stage and row, nothing more. Do not infer a store or a broker.
- A producer, a broker and a consumer renamed as a model. That is an Architecture.
