## Use for
Where each part of a value chain sits on its way from new to commodity, to decide what to build, buy or watch. It says nothing about runtime connections.

## Not for
- How requests flow between services: Architecture.
- A plan in time: Gantt or Timeline.
- A scored comparison: Quadrant.

## Limits
- 9 parts at most. `check` warns above that.
- Advice, not checked: 12 dependency links or fewer, and 2 movement arrows. The page reports more; a third arrow is not drawn.
- `WardleyPart(name, stage, visibility, needs?, evolving?)`. `stage` is one of `genesis`, `custom`, `product`, `commodity`: a band, not a score. Parts in a band are spread by the layout.
- `visibility` runs from 0 (invisible to the user) to 100 (visible). It has no tick marks: it is order, not a quantity.
- `needs` lists the exact names of the parts this one depends on. The line has no arrowhead.
- `evolving` draws a dashed arrow to the right: the part is moving towards commodity. Not for a commodity.

## Usual errors
- Placing a part "between" bands. Pick the band it is in now.
- A part with no link in or out. Link it or leave it off.
- A `needs` name that differs from the part's name. The link is dropped and the page says so.
- Using the map for architecture.
