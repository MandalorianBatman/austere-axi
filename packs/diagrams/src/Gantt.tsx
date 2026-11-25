import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { buildGantt } from "./_plan-model.ts";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Gantt.md";

const nothing = () => null;

// Names and positions match the austere-pack-gantt pack, so a page written for it draws the same.
export const GanttTask = austereComponent({
  name: "GanttTask",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    start: z.string(),
    end: z.string().optional(),
    progress: z.number().optional(),
    owner: z.string().optional(),
  }),
  description:
    'One bar in a Gantt. start and end are "YYYY-MM-DD" (end inclusive; omit or "" for a one-day milestone). progress is 0-100; owner is a short label. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

type GanttProps = { tasks?: unknown; title?: unknown };

function GanttView({ props, statementId }: RendererArgs<GanttProps>) {
  const plan = React.useMemo(() => buildGantt(props), [props]);
  useProblems(plan.problems, "gantt", "Gantt", statementId);
  const title = typeof props?.title === "string" ? props.title.trim() : "";
  return (
    <DiagramFrame className="dg-gantt" name={title || "Gantt chart"}>
      {() => {
        if (!plan.rows.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Gantt has no tasks.</strong> List the GanttTask statements, in the order
                they are drawn.
              </div>
            ),
          };
        }
        const axis = plan.axis;
        return {
          content: (
            <div className="dg-gt">
              {title ? <div className="dg-gt-title">{title}</div> : null}
              {axis ? (
                <div className="dg-gt-row dg-gt-axis" aria-hidden="true">
                  <span />
                  <div className="dg-gt-track">
                    {axis.ticks.map((t) => (
                      <span
                        key={t.day}
                        className={
                          (t.day - axis.first + 0.5) / axis.span > 0.92 ? "is-end" : undefined
                        }
                        style={{ left: `${((t.day - axis.first + 0.5) / axis.span) * 100}%` }}
                      >
                        {t.label}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {plan.rows.map((r) => (
                <div
                  key={r.id}
                  data-oui-id={r.named ? r.id : undefined}
                  data-oui-c={r.named ? "GanttTask" : undefined}
                >
                  <div className="dg-gt-row" data-austere-part={r.name}>
                    <div className="dg-gt-label">
                      <span className="dg-gt-name">{r.name}</span>
                      {r.owner ? <span className="dg-gt-owner">{r.owner}</span> : null}
                    </div>
                    <div className="dg-gt-track">
                      {r.error ? (
                        <span className="dg-gt-error">{r.error}</span>
                      ) : (
                        <div
                          className={`dg-gt-bar${r.milestone ? " is-milestone" : ""}${r.progress >= 100 ? " is-done" : ""}`}
                          style={
                            r.milestone
                              ? { left: `${r.left + r.width / 2}%` }
                              : { left: `${r.left}%`, width: `${r.width}%` }
                          }
                          title={`${r.name}: ${r.milestone ? r.startLabel : `${r.startLabel} to ${r.endLabel}`}${r.progress ? `, ${Math.round(r.progress)}%` : ""}`}
                        >
                          {r.milestone ? null : (
                            <span className="dg-gt-fill" style={{ width: `${r.progress}%` }} />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Gantt = austereComponent({
  name: "Gantt",
  group: "Diagrams",
  tier: "extended",
  family: "Time and plan",
  keywords: [
    "gantt",
    "schedule",
    "roadmap",
    "project plan",
    "timeline of tasks",
    "milestones",
    "rollout plan",
    "who does what when",
    "sprint plan",
    "dates",
    "overlap",
    "phases",
  ],
  guide,
  limits: [
    {
      prop: "tasks",
      max: 12,
      message: "Gantt: 12 tasks at most. Split the plan by phase, or show phases as tasks.",
    },
  ],
  props: z.object({ tasks: z.array(GanttTask.definition.ref), title: z.string().optional() }),
  description:
    "Gantt chart: GanttTasks as bars on a shared date axis, in the order given; a task with no end is a milestone, progress fills the bar. Same names as the austere-pack-gantt pack. Each bar is a click target.",
  renderer: GanttView,
  example: [
    `plan = Gantt([design, build, review, launch], "Q4 rollout")
design = GanttTask("Design", "2026-11-02", "2026-11-13", 100, "Ada")
build = GanttTask("Build", "2026-11-09", "2026-12-04", 45, "Grace")
review = GanttTask("Security review", "2026-12-01", "2026-12-11", 0, "Linus")
launch = GanttTask("Launch", "2026-12-14")`,
    `dbPlan = Gantt([mgFreeze, mgCopy, mgVerify, mgCutover, mgDone], "Database migration")
mgFreeze = GanttTask("Schema freeze", "2026-03-02", "2026-03-04", 100, "DBA")
mgCopy = GanttTask("Backfill the new tables", "2026-03-04", "2026-03-20", 60, "Platform")
mgVerify = GanttTask("Compare old and new", "2026-03-16", "2026-03-27", 10, "QA")
mgCutover = GanttTask("Cut over reads", "2026-03-30", "2026-03-31", 0, "Platform")
mgDone = GanttTask("Old tables dropped", "2026-04-10")`,
  ],
  stress: [
    `stressPlan = Gantt([gsTypo, gsBack, gsOk, gsLong, gsEnd, gsAdd], "<img src=x onerror=alert(1)>")
gsTypo = GanttTask("Typo", "next tuesday")
gsBack = GanttTask("Time travel", "2026-12-04", "2026-11-01")
gsOk = GanttTask("One day", "2026-11-03", "2026-11-03", 250)
gsLong = GanttTask("A_TASK_NAME_THAT_KEEPS_GOING_AND_HAS_NO_BREAKS_SO_IT_MUST_WRAP_IN_THE_LABEL_COLUMN_ON_A_PHONE", "2026-11-05", "2026-11-20", 10, "someone-with-a-long-handle-that-must-wrap")
gsEnd = GanttTask("支払いの確認", "2026-11-18", "2027-03-01", 50, "東京")
gsAdd = GanttTask("Milestone", "2026-11-18")`,
  ],
});

export default [Gantt, GanttTask];
