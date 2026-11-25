# Diagrams

austere-axi draws the diagram types of [`cathrynlavery/diagram-design`](https://github.com/cathrynlavery/diagram-design) at commit [`58b7dcf`](https://github.com/cathrynlavery/diagram-design/blob/58b7dcf/skills/diagram-design/SKILL.md) ("Visual-type guide (52)") as native components: typed statements, automatic layout, and each part a click target. The types marked **built** in the table below ship with austere-axi: a page needs no install and no tag. The others are not available yet.

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
| Architecture delta | `ArchitectureDelta`: `Architecture` with added, changed and removed tags and tones; before and after in `Tabs` | recipe | built |
| IT current-state | `ITCurrentState`: `Architecture` with lanes | recipe | built |
| Flowchart | `Flowchart` (`FlowStep`, `FlowLink`) | component | built |
| Sequence | `Sequence` (`Actor`, `Message`, `Branch`) | component | built |
| State machine | `StateMachine` (`State`, `Transition`) | component | built |
| ER / data model | `ERDiagram` (`Entity`, `Relation`) | component | built |
| Steps | `Steps` | component | built |
| Timeline | `Timeline` | component | built |
| Git graph | `GitGraph` (`GitCommit`) | component | built |
| Swimlane | `Swimlane`: `Architecture` with lanes | recipe | built |
| Quadrant | `Quadrant` (`QuadrantItem`) | component | built |
| Radar / Spider | `Radar` (`RadarSeries`) | component | built |
| Polar chart | `PolarChart` | component | built |
| Loop | `Loop` (`LoopStep`, `LoopHub`) | component | built |
| Nested | `Nested` (`NestedLevel`) | component | built |
| Tree | `Tree` (`TreeNode`) | component | built |
| Org chart | `OrgChart` (`Person`) | component | built |
| Layer stack | `LayerStack` (`Layer`) | component | built |
| Exploded axonometric | none: an illustration with no data model | — | not planned |
| Axonometric plan | none: an illustration with no data model | — | not planned |
| Venn | `Venn` (`VennSet`, `VennOverlap`) | component | built |
| Pyramid / funnel | `Pyramid` (`PyramidLayer`) | component | built |
| Bar chart | `BarComparison`: `BarChart` | recipe | built |
| Waterfall | `Waterfall` | component | built |
| Treemap | `Treemap` | component | built |
| Heatmap | `Heatmap` (`HeatRow`) | component | built |
| Line chart | `LineTrend`: `LineChart` | recipe | built |
| Gantt | `Gantt` (`GanttTask`) | component | built |
| Scatter plot | `ScatterPlot`: `ScatterChart` | recipe | built |
| High-Level | `HighLevel`: `Architecture` with groups | recipe | built |
| Process | `ProcessMap`: `Architecture` with lanes by actor | recipe | built |
| Medallion | `Medallion`: `Architecture` with a lane for each tier | recipe | built |
| Data flow | `DataFlow`: `Architecture` with lanes by role | recipe | built |
| DP integration | `DPIntegration`: `Architecture` with source, platform and consumer lanes | recipe | built |
| DP security matrix | `PermissionMatrix` (`AccessRow`) | component | built |
| Sankey | `Sankey` | component | built |
| Fishbone | `Fishbone` (`FishCause`) | component | built |
| Wardley map | `WardleyMap` (`WardleyPart`) | component | built |
| Kanban | `Kanban` (`KanbanCard`) | component | built |
| User journey | `UserJourney` (`JourneyStep`) | component | built |
| Service blueprint | `ServiceBlueprint` (`BlueprintStep`) | component | built |
| Deployment | `Deployment`: `Architecture` with nested groups. Limit: a replica count is text in the detail line, with no badge | recipe | built |
| Dependency graph | `DependencyGraph`: `Architecture`, a fan-in tag and a danger cycle. Limit: the layout picks the ranks; one cycle is marked | recipe | built |
| UML class | `ClassDiagram` (`ClassBox`, `ClassLink`) | component | built |
| Story map | `StoryMap` (`Story`) | component | built |
| Database schema | `DatabaseSchema`: `ERDiagram` with typed field lines | recipe | built |
| SBGN | `SBGN`: `Architecture` with species and process nodes. Limit: not SBGN notation, as `Node` has no process square, empty-set or modulation glyph; tags, tones and edge labels say it in words | recipe | built |
| Requirement traceability | `Traceability` (`TraceReq`, `TraceItem`) | component | built |
| Event modeling | `EventModel` (`EventItem`) | component | built |
| Unit Grid | `UnitGrid` (`UnitShare`) | component | built |
| Schedule network | `ScheduleNetwork` (`ScheduleTask`) | component | built |

The stock `RadarChart` and `RadialChart` stay off. `RadarChart` draws every series in nearly the same blue and has no part a reviewer can click, so it cannot compare several entities. `RadialChart` draws concentric arcs, so the ray length that a polar chart needs is not there. `Radar` and `PolarChart` replace them.

Named variants of a type (slopegraph, ridgeline, streamgraph, bump, bubble, beeswarm, box plot, marimekko, dumbbell) are not built. Animation, brand skins, and import from Mermaid, draw.io, Excalidraw or PlantUML are not planned.

## Adding a type

Follow `.agents/skills/add-component/SKILL.md`. A diagram type sets `group: "Diagrams"` and a `family`, ships a usage guide in an adjacent `.md` file (`## Use for`, `## Not for`, `## Limits`, `## Usual errors`), two examples, `keywords` and, where upstream gives a number, `limits`. Change its row above to **built** and add a line to `CHANGELOG.md`. The read-path fields are in [Writing a pack](writing-a-pack.md#read-path-fields).
