## Use for
How a start total becomes an end total through signed steps: a budget bridge, a headcount change, a P&L walk, a conversion leak. The running total is the story, and the reader traces it from left to right.

## Not for
- Two endpoints where only the gap matters: say it in a sentence, or a Table with two rows.
- Independent categories to compare: BarChart.
- One quantity that splits and merges across stages: Sankey.
- Ordered drop-off through the stages of one funnel: Pyramid (`"funnel"`).

## Limits
- `Waterfall(labels, values, unit?, focus?, subtotal?)`. The first value is the start total, the last is the end total, the ones between are steps with a sign: `+64` rises, `-38` falls. One unit for all.
- 3 to 8 bars. `check` warns above 8. Merge the tail into one named "Other" step and say what it holds.
- The end total must equal start plus every step. When it does not, the bar is drawn where you put it, the carry line shows the gap, and the page reports the difference. Never edit a number to hide it.
- `subtotal` is the label of one middle bar that is a total, not a step. Its value is the running total at that point. One at most; more means two walks.
- `focus` is the label of the one step to stress.
- A step of 0 is not drawn and is reported: say it in the text.
- Bars rise from the baseline at 0. The axis is never cut.
- A click on a bar or its label reaches the agent as `label: value`.

## Usual errors
- A total that does not add up.
- Steps with the wrong sign: the signs are the claim.
- A fall written as a positive number. Write `-38`.
- Two units in one walk (people and dollars).
- A middle total written as a step.
