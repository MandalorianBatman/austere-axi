import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { buildKanban } from "./_board-model.ts";
import { BoardView } from "./_board-view.tsx";
import guide from "./Kanban.md";

const nothing = () => null;

export const KanbanCard = austereComponent({
  name: "KanbanCard",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    title: z.string(),
    column: z.string(),
    detail: z.string().optional(),
    state: z.enum(["blocked", "waiting", "done"]).optional(),
  }),
  description:
    'One card on a Kanban. column is the name of one of its columns. detail is the line under the title ("AX-214 · nadia"). state marks it "blocked", "waiting" (on someone else) or "done". Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

type KanbanProps = {
  columns?: unknown;
  cards?: unknown;
  limits?: unknown;
};

function KanbanView({ props, statementId }: RendererArgs<KanbanProps>) {
  const board = React.useMemo(() => buildKanban(props), [props]);
  return (
    <BoardView
      board={board}
      component="Kanban"
      cardComponent="KanbanCard"
      name="Kanban board"
      statementId={statementId}
    />
  );
}

export const Kanban = austereComponent({
  name: "Kanban",
  group: "Diagrams",
  tier: "extended",
  family: "Boards",
  keywords: [
    "kanban",
    "board",
    "wip",
    "work in progress",
    "backlog",
    "in progress",
    "blocked",
    "sprint",
    "task board",
    "state census",
    "what is stuck",
    "what blocks",
  ],
  guide,
  limits: [
    {
      prop: "columns",
      max: 5,
      message: "Kanban: 5 columns at most. Merge states that no one acts on separately.",
    },
    {
      prop: "cards",
      max: 12,
      message:
        'Kanban: 12 cards at most. Replace a long backlog with one card ("+14 more") or split the board.',
    },
  ],
  props: z.object({
    columns: z.array(z.string()),
    cards: z.array(KanbanCard.definition.ref),
    limits: z.array(z.number()).optional(),
  }),
  description:
    "Work by state: columns (names, left to right) and one KanbanCard for each card. limits sets a WIP limit for each column in order (0 = none); a column over its limit is marked. No arrows: use Swimlane for handoffs. Each card is a click target.",
  renderer: KanbanView,
  example: [
    `workBoard = Kanban(["Todo", "Doing", "Done"], [kbWrite, kbDraw, kbNames])
kbWrite = KanbanCard("Write the guide", "Todo")
kbDraw = KanbanCard("Draw the board", "Doing", "AX-12 · sid")
kbNames = KanbanCard("Pick the names", "Done", "AX-9 · sid", "done")`,
    `releaseBoard = Kanban(["Backlog", "Doing", "Review", "Done"], [krA, krB, krC, krD, krE, krF], [0, 2, 1, 0])
krA = KanbanCard("Dark theme contrast pass", "Backlog", "AX-231")
krB = KanbanCard("Export keeps notes", "Doing", "AX-214 · nadia")
krC = KanbanCard("Hub search by project", "Doing", "AX-219 · ravi", "blocked")
krD = KanbanCard("Share link expiry", "Doing", "AX-222 · ines")
krE = KanbanCard("Poll cursor", "Review", "AX-208 · sid", "waiting")
krF = KanbanCard("Chrome Send queue", "Done", "AX-203 · sid", "done")`,
  ],
  stress: [
    `stressKanban = Kanban(["BACKLOG_COLUMN_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP", "In progress", "支払い"], [ksA, ksB, ksC, ksD], [0, 1])
ksA = KanbanCard("A_CARD_TITLE_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", "BACKLOG_COLUMN_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP", "TICKET-0000000000000000000000000000000000 · owner-with-a-very-long-name")
ksB = KanbanCard("📦 Ship it", "In progress", "", "blocked")
ksC = KanbanCard("Two", "In progress", "AX-2", "waiting")
ksD = KanbanCard("東京リージョンの切り替え", "支払い", "", "done")`,
  ],
});

export default [Kanban, KanbanCard];
