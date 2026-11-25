// The diagrams pack, bundled with austere-axi: the diagram types that need no
// graph layout. One file for each type (Name.tsx, Name.md beside it, a pure
// _name-model.ts for the parsing and layout), one CSS file for the pack.
// To add a type: copy Sequence.*, import its components here, append them below.
import { Sequence, Actor, Message, Branch } from "./Sequence.tsx";
import { Nested, NestedLevel } from "./Nested.tsx";
import { LayerStack, Layer } from "./LayerStack.tsx";
import { Kanban, KanbanCard } from "./Kanban.tsx";
import { StoryMap, Story } from "./StoryMap.tsx";
import { UserJourney, JourneyStep } from "./UserJourney.tsx";
import { ServiceBlueprint, BlueprintStep } from "./ServiceBlueprint.tsx";
import { EventModel, EventItem } from "./EventModel.tsx";
import { Heatmap, HeatRow } from "./Heatmap.tsx";
import { PermissionMatrix, AccessRow } from "./PermissionMatrix.tsx";
import { UnitGrid, UnitShare } from "./UnitGrid.tsx";
import { Traceability, TraceReq, TraceItem } from "./Traceability.tsx";
import { Gantt, GanttTask } from "./Gantt.tsx";
import { GitGraph, GitCommit } from "./GitGraph.tsx";
import { ScheduleNetwork, ScheduleTask } from "./ScheduleNetwork.tsx";
import { Quadrant, QuadrantItem } from "./Quadrant.tsx";
import { Venn, VennSet, VennOverlap } from "./Venn.tsx";
import { Pyramid, PyramidLayer } from "./Pyramid.tsx";
import { Loop, LoopStep, LoopHub } from "./Loop.tsx";
import { Fishbone, FishCause } from "./Fishbone.tsx";
import { WardleyMap, WardleyPart } from "./WardleyMap.tsx";
import { Radar, RadarSeries } from "./Radar.tsx";
import PolarChart from "./PolarChart.tsx";
import Waterfall from "./Waterfall.tsx";
import Treemap from "./Treemap.tsx";
import Sankey from "./Sankey.tsx";
import css from "./diagrams.css";
import type { PackModule } from "austere-axi/pack";

export default {
  components: [
    Sequence,
    Actor,
    Message,
    Branch,
    Nested,
    NestedLevel,
    LayerStack,
    Layer,
    Kanban,
    KanbanCard,
    StoryMap,
    Story,
    UserJourney,
    JourneyStep,
    ServiceBlueprint,
    BlueprintStep,
    EventModel,
    EventItem,
    Heatmap,
    HeatRow,
    PermissionMatrix,
    AccessRow,
    UnitGrid,
    UnitShare,
    Traceability,
    TraceReq,
    TraceItem,
    Gantt,
    GanttTask,
    GitGraph,
    GitCommit,
    ScheduleNetwork,
    ScheduleTask,
    Quadrant,
    QuadrantItem,
    Venn,
    VennSet,
    VennOverlap,
    Pyramid,
    PyramidLayer,
    Loop,
    LoopStep,
    LoopHub,
    Fishbone,
    FishCause,
    WardleyMap,
    WardleyPart,
    Radar,
    RadarSeries,
    PolarChart,
    Waterfall,
    Treemap,
    Sankey,
  ],
  css,
} satisfies PackModule;
