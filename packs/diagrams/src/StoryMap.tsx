import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { buildStoryMap } from "./_board-model.ts";
import { BoardView } from "./_board-view.tsx";
import guide from "./StoryMap.md";

const nothing = () => null;

export const Story = austereComponent({
  name: "Story",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    title: z.string(),
    activity: z.string(),
    slice: z.string().optional(),
    detail: z.string().optional(),
    risk: z.boolean().optional(),
  }),
  description:
    'One story on a StoryMap, under its activity. slice is the release it belongs to (the first when left out). detail is an estimate or ticket ("RPT-114 · 3pt"). risk: true marks the one riskiest story. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

type StoryMapProps = {
  activities?: unknown;
  stories?: unknown;
  slices?: unknown;
  cut?: unknown;
};

function StoryMapView({ props, statementId }: RendererArgs<StoryMapProps>) {
  const board = React.useMemo(() => buildStoryMap(props), [props]);
  return (
    <BoardView
      board={board}
      component="StoryMap"
      cardComponent="Story"
      name="Story map"
      statementId={statementId}
    />
  );
}

export const StoryMap = austereComponent({
  name: "StoryMap",
  group: "Diagrams",
  tier: "extended",
  family: "Boards",
  keywords: [
    "story map",
    "user story map",
    "backbone",
    "release",
    "release cut",
    "mvp",
    "slice",
    "walking skeleton",
    "roadmap",
    "scope",
    "what ships first",
  ],
  guide,
  limits: [
    {
      prop: "activities",
      max: 5,
      message: "StoryMap: 5 activities at most. Make one map for each group of activities.",
    },
    {
      prop: "stories",
      max: 12,
      message:
        "StoryMap: 12 stories at most. Collapse a slice into one count story, or map one activity at a time.",
    },
    {
      prop: "slices",
      max: 3,
      message: "StoryMap: 3 release slices at most (MVP, next, later).",
    },
  ],
  props: z.object({
    activities: z.array(z.string()),
    stories: z.array(Story.definition.ref),
    slices: z.array(z.string()).optional(),
    cut: z.number().optional(),
  }),
  description:
    "A story map: activities across in story order, release slices down (first release first), and one Story for each card. The release cut runs under the first slice; cut sets how many slices sit above it. Each Story is a click target.",
  renderer: StoryMapView,
  example: [
    `shipMap = StoryMap(["Find", "Buy", "Receive"], [smSearch, smPay, smTrack], ["MVP", "Later"])
smSearch = Story("Search by name", "Find")
smPay = Story("Pay by card", "Buy")
smTrack = Story("Track the parcel", "Receive", "", "", true)`,
    `shopMap = StoryMap(["Browse", "Choose", "Pay", "Receive"], [msA, msB, msC, msD, msE, msF, msG], ["MVP", "Release 2", "Later"])
msA = Story("Category list", "Browse", "MVP", "SHP-101 · 2pt")
msB = Story("Search with filters", "Browse", "Release 2", "SHP-118 · 5pt")
msC = Story("Product page", "Choose", "MVP", "SHP-104 · 3pt")
msD = Story("Compare two items", "Choose", "Later", "SHP-131 · 8pt")
msE = Story("Pay by card", "Pay", "MVP", "SHP-109 · 5pt", true)
msF = Story("Saved cards", "Pay", "Release 2", "SHP-122 · 3pt")
msG = Story("Order status email", "Receive", "MVP", "SHP-112 · 2pt")`,
  ],
  stress: [
    `stressMap = StoryMap(["ACTIVITY_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "支払い", "Third"], [mxA, mxB, mxC], ["MVP_SLICE_WITH_A_VERY_LONG_UNBROKEN_LABEL", "Later"], 1)
mxA = Story("A_STORY_TITLE_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", "ACTIVITY_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "MVP_SLICE_WITH_A_VERY_LONG_UNBROKEN_LABEL", "TICKET-00000000000000000000000000 · 13pt", true)
mxB = Story("東京リージョンの切り替え", "支払い", "Later")
mxC = Story("One more", "Third")`,
  ],
});

export default [StoryMap, Story];
