// The one grid every board type draws with: column heads across, an optional label column,
// cards in the cells, rules (release cut, line of visibility) between rows.
import React, { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { DiagramFrame, reportRuntimeError } from "austere-axi/pack";
import type { Board, BoardCard, BoardKind } from "./_board-model.ts";

/** What a column and a row are called on each board: names the part a reviewer points at. */
const WORDS: Record<BoardKind, { column: string; row: string }> = {
  kanban: { column: "column", row: "row" },
  storymap: { column: "activity", row: "slice" },
  journey: { column: "stage", row: "row" },
  blueprint: { column: "stage", row: "layer" },
  event: { column: "stage", row: "row" },
};

const FLAGS: Record<string, string> = {
  blocked: "Blocked",
  waiting: "Waiting",
  done: "Done",
  risk: "Risk",
  focus: "Focus",
};

/** Keep the curve and the dot off the top and bottom edge of the cell. */
const plot = (y: number) => 12 + 76 * y;

function Sentiment({ card }: { card: BoardCard }) {
  const curve = card.curve;
  return (
    <div className="dg-b-sent" aria-hidden={curve ? undefined : "true"}>
      {curve ? (
        <>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {curve.left !== null ? (
              <line
                x1="0"
                y1={plot(curve.left)}
                x2="50"
                y2={plot(curve.y)}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {curve.right !== null ? (
              <line
                x1="50"
                y1={plot(curve.y)}
                x2="100"
                y2={plot(curve.right)}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          <span
            className="dg-b-dot"
            style={{ top: `${plot(curve.y)}%` }}
            role="img"
            aria-label={`score ${curve.score} of 5`}
          >
            <span className="dg-b-score">{curve.score}</span>
          </span>
        </>
      ) : null}
    </div>
  );
}

function Card({
  card,
  component,
  sentiment,
}: {
  card: BoardCard;
  component: string;
  sentiment: boolean;
}) {
  const flag = card.trough ? "Lowest" : FLAGS[card.state];
  return (
    <li
      className={`dg-b-card${card.state ? ` s-${card.state}` : ""}${card.kind ? ` k-${card.kind}` : ""}${card.trough ? " is-trough" : ""}`}
      data-flag={flag || undefined}
      data-oui-id={card.named ? card.id : undefined}
      data-oui-c={card.named ? component : undefined}
    >
      {sentiment ? <Sentiment card={card} /> : null}
      <span className="dg-b-title" data-austere-part={card.title}>
        {card.title}
      </span>
      {card.detail ? (
        <span className="dg-b-detail" data-austere-part={`${card.title}: ${card.detail}`}>
          {card.detail}
        </span>
      ) : null}
      {card.pain ? (
        <span className="dg-b-pain" data-austere-part={`${card.title}: ${card.pain}`}>
          {card.pain}
        </span>
      ) : null}
    </li>
  );
}

interface BoardViewProps {
  board: Board;
  /** The component of the cards, for data-oui-c. */
  cardComponent: string;
  /** The container, for messages and the source of the error reports. */
  component: string;
  /** Name of the scroll region when the board is not in a titled Card. */
  name: string;
  statementId: string | undefined;
  /** Shown under the board, not scrolled. */
  legend?: ReactNode;
}

export function BoardView({
  board,
  cardComponent,
  component,
  name,
  statementId,
  legend,
}: BoardViewProps) {
  const problemKey = board.problems.join("\n");
  useEffect(() => {
    for (const message of board.problems)
      reportRuntimeError({ source: board.kind, statementId, component, message });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);

  const words = WORDS[board.kind];
  return (
    <DiagramFrame className={`dg-board dg-board-${board.kind}`} name={name}>
      {() => {
        if (!board.columns.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>
                  {component} has no {words.column}s.
                </strong>{" "}
                Pass their names as the first argument, in order.
              </div>
            ),
          };
        }
        const template = `${board.labelled ? "var(--dg-label) " : ""}repeat(${board.columns.length}, minmax(0, 1fr))`;
        const style: CSSProperties = { gridTemplateColumns: template, gap: `${board.gap}px` };
        return {
          width: board.width,
          caption: legend,
          content: (
            <div className="dg-b-grid" style={style}>
              {board.labelled ? <div className="dg-b-corner" aria-hidden="true" /> : null}
              {board.columns.map((column, c) => (
                <div className={`dg-b-head${column.over ? " is-over" : ""}`} key={`h${c}`}>
                  <span
                    className="dg-b-head-name"
                    data-austere-part={`${column.label} ${words.column}`}
                  >
                    {column.label}
                  </span>
                  {column.chip ? (
                    <span
                      className="dg-b-chip"
                      data-over={column.over ? "over limit" : undefined}
                      data-austere-part={`${column.label} work in progress: ${column.chip}`}
                    >
                      {column.chip}
                    </span>
                  ) : null}
                </div>
              ))}
              {board.rows.map((row, r) => (
                <React.Fragment key={`r${r}`}>
                  {board.labelled ? (
                    <div className={`dg-b-rowlabel${row.key ? ` k-${row.key}` : ""}`}>
                      <span data-austere-part={`${row.label} ${words.row}`}>{row.label}</span>
                    </div>
                  ) : null}
                  {board.columns.map((column, c) => {
                    const cards = board.cards.filter((k) => k.row === r && k.col === c);
                    return cards.length ? (
                      <ul
                        className={`dg-b-cell${row.key ? ` k-${row.key}` : ""}`}
                        key={`c${r}-${c}`}
                        aria-label={`${column.label}${row.label ? `, ${row.label}` : ""}`}
                      >
                        {cards.map((card) => (
                          <Card
                            key={card.id}
                            card={card}
                            component={cardComponent}
                            sentiment={board.kind === "journey"}
                          />
                        ))}
                      </ul>
                    ) : (
                      <div
                        className={`dg-b-cell is-empty${row.key ? ` k-${row.key}` : ""}`}
                        key={`c${r}-${c}`}
                        aria-hidden="true"
                      />
                    );
                  })}
                  {board.lines
                    .filter((line) => line.after === r)
                    .map((line) => (
                      <div className={`dg-b-line is-${line.kind}`} key={`l${r}-${line.kind}`}>
                        <span data-austere-part={line.label}>{line.label}</span>
                      </div>
                    ))}
                </React.Fragment>
              ))}
            </div>
          ),
        };
      }}
    </DiagramFrame>
  );
}
