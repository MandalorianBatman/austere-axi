# Diagrams

austere-axi draws the diagram types of [`cathrynlavery/diagram-design`](https://github.com/cathrynlavery/diagram-design) at commit [`58b7dcf`](https://github.com/cathrynlavery/diagram-design/blob/58b7dcf/skills/diagram-design/SKILL.md) ("Visual-type guide (52)") as native components: typed statements, automatic layout, and each part a click target. All of them ship with austere-axi; a page needs no install and no tag.

An agent finds them in this order:

| Step | Command | What it reads |
|---|---|---|
| Each session | `austere-axi spec` | The `Diagrams` group: `Architecture` with its parts, and one line that names the other diagram types |
| The page needs a diagram | `austere-axi components list Diagrams` | The chooser: each type with what it is for, by family |
| A type is chosen | `austere-axi components show <Name>` | Signature, the signatures of its parts, where it may sit, the usage guide, two examples |
| Free text | `austere-axi components search <words> --group Diagrams` | One short line for each match |

A **recipe** is a type an existing component draws well, so it has no component of its own: `show` prints its guide and two examples, which write the components it names. A page that calls a recipe by name fails `check` with the components to write.

## Coverage

Status: **built** (in this version), **planned** (scheduled, not released yet), **not planned**. To compare with upstream, read its "Visual-type guide" table at a newer commit and look for rows missing here.

| Upstream type | austere-axi | Kind | Status |
|---|---|---|---|
| Architecture | `Architecture` (`Node`, `Edge`, `Group`) | component | built |
| Architecture delta | `Architecture`, before and after | recipe | planned |
| IT current-state | `Architecture` with lanes | recipe | planned |
| Flowchart | `Flowchart` | component | planned |
| Sequence | `Sequence` | component | planned |
| State machine | `StateMachine` | component | planned |
| ER / data model | `ERDiagram` | component | planned |
| Steps | `Steps` | component | built |
| Timeline | `Timeline` | component | built |
| Git graph | `GitGraph` | component | planned |
| Swimlane | `Swimlane`: `Architecture` with lanes | recipe | built |
| Quadrant | `Quadrant` | component | planned |
| Radar / Spider | `RadarChart`, or a pack component | component | planned |
| Polar chart | `RadialChart`, or a pack component | component | planned |
| Loop | `Loop` | component | planned |
| Nested | `Nested` | component | planned |
| Tree | `Tree` | component | planned |
| Org chart | `OrgChart` | component | planned |
| Layer stack | `LayerStack` | component | planned |
| Exploded axonometric | none: an illustration with no data model | — | not planned |
| Axonometric plan | none: an illustration with no data model | — | not planned |
| Venn | `Venn` | component | planned |
| Pyramid / funnel | `Pyramid` | component | planned |
| Bar chart | `BarComparison`: `BarChart` | recipe | built |
| Waterfall | `Waterfall` | component | planned |
| Treemap | `Treemap` | component | planned |
| Heatmap | `Heatmap` | component | planned |
| Line chart | `LineTrend`: `LineChart` | recipe | built |
| Gantt | `Gantt`, `GanttTask` | component | planned |
| Scatter plot | `ScatterPlot`: `ScatterChart` | recipe | built |
| High-Level | `Architecture` with groups | recipe | planned |
| Process | `Architecture` with lanes | recipe | planned |
| Medallion | `Architecture` with lanes | recipe | planned |
| Data flow | `Architecture` with lanes | recipe | planned |
| DP integration | `Architecture` with lanes | recipe | planned |
| DP security matrix | `PermissionMatrix` | component | planned |
| Sankey | `Sankey` | component | planned |
| Fishbone | `Fishbone` | component | planned |
| Wardley map | `WardleyMap` | component | planned |
| Kanban | `Kanban` | component | planned |
| User journey | `UserJourney` | component | planned |
| Service blueprint | `ServiceBlueprint` | component | planned |
| Deployment | `Architecture` with nested groups | recipe | planned |
| Dependency graph | `Architecture` | recipe | planned |
| UML class | `ClassDiagram` | component | planned |
| Story map | `StoryMap` | component | planned |
| Database schema | a data-model component, with `ERDiagram` | component | planned |
| SBGN | `Architecture` | recipe | planned |
| Requirement traceability | `Traceability` | component | planned |
| Event modeling | `EventModel` | component | planned |
| Unit Grid | `UnitGrid` | component | planned |
| Schedule network | `ScheduleNetwork` | component | planned |

Named variants of a type (slopegraph, ridgeline, streamgraph, bump, bubble, beeswarm, box plot, marimekko, dumbbell) are not built. Animation, brand skins, and import from Mermaid, draw.io, Excalidraw or PlantUML are not planned.

## Adding a type

Follow `.agents/skills/add-component/SKILL.md`. A diagram type sets `group: "Diagrams"` and a `family`, ships a usage guide in an adjacent `.md` file (`## Use for`, `## Not for`, `## Limits`, `## Usual errors`), two examples, `keywords` and, where upstream gives a number, `limits`. Change its row above to **built** and add a line to `CHANGELOG.md`. The read-path fields are in [Writing a pack](writing-a-pack.md#read-path-fields).
