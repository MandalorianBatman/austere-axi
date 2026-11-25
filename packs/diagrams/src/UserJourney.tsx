import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { buildJourney } from "./_board-model.ts";
import { BoardView } from "./_board-view.tsx";
import guide from "./UserJourney.md";

const nothing = () => null;

export const JourneyStep = austereComponent({
  name: "JourneyStep",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    action: z.string(),
    stage: z.string(),
    score: z.number().optional(),
    touchpoint: z.string().optional(),
    pain: z.string().optional(),
  }),
  description:
    "One stage of a UserJourney: what the person does there. stage is the name of one of its stages. score is how it feels, 1 (frustrated) to 5 (delighted). touchpoint is where it happens (email, app). pain names the friction, on the lowest stage. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type JourneyProps = {
  stages?: unknown;
  steps?: unknown;
  persona?: unknown;
};

function JourneyView({ props, statementId }: RendererArgs<JourneyProps>) {
  const board = React.useMemo(() => buildJourney(props), [props]);
  const persona = typeof props?.persona === "string" ? props.persona.trim() : "";
  return (
    <BoardView
      board={board}
      component="UserJourney"
      cardComponent="JourneyStep"
      name={persona ? `User journey: ${persona}` : "User journey"}
      statementId={statementId}
      legend={
        <p className="dg-b-legend">
          {persona ? <strong>{persona}. </strong> : null}
          Feeling: 5 delighted, 1 frustrated. The lowest stage is marked.
        </p>
      }
    />
  );
}

export const UserJourney = austereComponent({
  name: "UserJourney",
  group: "Diagrams",
  tier: "extended",
  family: "Boards",
  keywords: [
    "user journey",
    "customer journey",
    "journey map",
    "persona",
    "sentiment",
    "feeling",
    "mood",
    "pain point",
    "friction",
    "drop off",
    "onboarding experience",
    "touchpoint",
  ],
  guide,
  limits: [
    {
      prop: "stages",
      max: 6,
      message:
        "UserJourney: 6 stages at most. Merge stages, or map one persona and phase at a time.",
    },
    {
      prop: "steps",
      max: 6,
      message: "UserJourney: one step for each stage, 6 at most.",
    },
  ],
  props: z.object({
    stages: z.array(z.string()),
    steps: z.array(JourneyStep.definition.ref),
    persona: z.string().optional(),
  }),
  description:
    "One person's path in stages (names, in order): a JourneyStep for each stage with what they do, a score 1 to 5 for how it feels, a touchpoint and, on the lowest stage, the pain. Draws the feeling curve. persona names who. Each step is a click target.",
  renderer: JourneyView,
  example: [
    `signupJourney = UserJourney(["Discover", "Sign up", "First use"], [ujFind, ujJoin, ujUse])
ujFind = JourneyStep("Reads the landing page", "Discover", 4, "Website")
ujJoin = JourneyStep("Fills the form", "Sign up", 2, "Web form", "Asks for a card")
ujUse = JourneyStep("Opens the first page", "First use", 5, "App")`,
    `onboardJourney = UserJourney(["Hear about it", "Try it", "Set up", "Share a page", "Come back"], [ojA, ojB, ojC, ojD, ojE], "A new team lead")
ojA = JourneyStep("Sees a demo in a thread", "Hear about it", 4, "Chat")
ojB = JourneyStep("Runs the install command", "Try it", 3, "Terminal")
ojC = JourneyStep("Connects an agent", "Set up", 1, "Docs", "Three config files, no check")
ojD = JourneyStep("Sends the first review link", "Share a page", 4, "Link")
ojE = JourneyStep("Reads the next reply", "Come back", 5, "Inbox")`,
  ],
  stress: [
    `stressJourney = UserJourney(["STAGE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "支払い", "Third", "Fourth", "Fifth", "Sixth"], [uxA, uxB, uxC, uxD, uxE, uxF], "A_PERSONA_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE")
uxA = JourneyStep("AN_ACTION_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", "STAGE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", 5, "TOUCHPOINT_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP", "")
uxB = JourneyStep("東京リージョンの切り替え", "支払い", 1, "アプリ", "PAIN_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE")
uxC = JourneyStep("Third step", "Third", 9)
uxD = JourneyStep("Fourth step", "Fourth", 3, "Web")
uxE = JourneyStep("Fifth step", "Fifth", 3.5)
uxF = JourneyStep("Sixth step", "Sixth", 4)`,
  ],
});

export default [UserJourney, JourneyStep];
