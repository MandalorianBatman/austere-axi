import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { NET, buildSchedule, layoutSchedule, num } from "./_plan-model.ts";
import type { NetBox } from "./_plan-model.ts";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./ScheduleNetwork.md";

const nothing = () => null;

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and the next one together.
const T = ({
  children,
  ...rest
}: React.SVGProps<SVGTextElement> & { children?: React.ReactNode }) => (
  <text {...rest}>{children} </text>
);

export const ScheduleTask = austereComponent({
  name: "ScheduleTask",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    id: z.string(),
    name: z.string(),
    duration: z.number(),
    after: z.array(z.string()).optional(),
  }),
  description:
    'One task in a ScheduleNetwork. id is a short unique code ("A", "DB1"). duration is a number above 0 in the network\'s unit. after lists the ids of the tasks that must finish first. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** At most two lines of `max` characters, cut at a space where there is one; the full name is in the title. */
function wrap(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const at = text.lastIndexOf(" ", max);
  if (at < 4) return [text.slice(0, max), cut(text.slice(max), max)];
  return [text.slice(0, at), cut(text.slice(at + 1), max)];
}

/** "weeks" → "week" for a duration of 1. */
const singular = (unit: string): string => (/[^s]s$/i.test(unit) ? unit.slice(0, -1) : unit);

function BoxView({ b, unit }: { b: NetBox; unit: string }) {
  const t = b.task;
  const { boxW, boxH } = NET;
  const half = boxW / 2 + 6;
  const row = (dy: number) => b.y + dy;
  return (
    <g
      className={`dg-sn-task${t.critical ? " is-critical" : ""}`}
      data-oui-id={t.named ? t.id : undefined}
      data-oui-c={t.named ? "ScheduleTask" : undefined}
    >
      <title>{`${t.key}: ${t.name}`}</title>
      <g data-austere-part={`${t.key}: ${t.name}`}>
        <rect className="dg-sn-box" x={b.x} y={b.y} width={boxW} height={boxH} rx={5} />
        {wrap(`${t.key}: ${t.name}`, 22).map((line, i) => (
          <T key={i} className="dg-sn-name" x={b.x + 12} y={row(22 + i * 15)}>
            {line}
          </T>
        ))}
        <T className="dg-sn-field" x={b.x + 12} y={row(58)}>
          {`DUR ${num(t.duration)} ${cut(t.duration === 1 ? singular(unit) : unit, 8)}`}
        </T>
        <T className="dg-sn-field" x={b.x + 12} y={row(80)}>{`ES ${num(t.es)}`}</T>
        <T className="dg-sn-field" x={b.x + half} y={row(80)}>{`EF ${num(t.ef)}`}</T>
        <T className="dg-sn-field" x={b.x + 12} y={row(98)}>{`LS ${num(t.ls)}`}</T>
        <T className="dg-sn-field" x={b.x + half} y={row(98)}>{`LF ${num(t.lf)}`}</T>
        <T className="dg-sn-status" x={b.x + 12} y={row(boxH - 8)}>
          {`TF ${num(t.tf)} · ${t.critical ? "CRITICAL" : "FLOAT"}`}
        </T>
      </g>
    </g>
  );
}

type ScheduleProps = { tasks?: unknown; unit?: unknown };

function ScheduleView({ props, statementId }: RendererArgs<ScheduleProps>) {
  const model = React.useMemo(() => buildSchedule(props), [props]);
  const layout = React.useMemo(() => layoutSchedule(model), [model]);
  useProblems(model.problems, "schedule", "ScheduleNetwork", statementId);
  return (
    <DiagramFrame className="dg-schedule" name="Schedule network">
      {() => {
        if (!model.tasks.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>ScheduleNetwork has no tasks.</strong> List the ScheduleTask statements,
                each with an id, a duration and the ids it comes after.
              </div>
            ),
          };
        }
        return {
          width: layout.width,
          caption: (
            <p className="dg-sn-summary">
              <strong>
                Project finish {num(model.finish)} {model.unit}.
              </strong>{" "}
              {model.path.length ? `Critical path: ${model.path.join(" → ")}. ` : ""}
              Box widths and spacing are not time.
            </p>
          ),
          content: (
            <svg
              className="dg-sn-svg"
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={`Schedule network: ${model.tasks.map((t) => t.key).join(", ")}; finish ${num(model.finish)} ${model.unit}`}
            >
              {layout.links.map((l) => (
                <g
                  key={`${l.link.from}-${l.link.to}`}
                  className={`dg-sn-link${l.link.critical ? " is-critical" : ""}`}
                >
                  <path className="dg-sn-line" d={l.d} />
                  <polyline
                    className="dg-sn-head"
                    points={`${l.tip.x - 8},${l.tip.y - 5} ${l.tip.x},${l.tip.y} ${l.tip.x - 8},${l.tip.y + 5}`}
                  />
                </g>
              ))}
              {layout.boxes.map((b) => (
                <BoxView key={b.task.key} b={b} unit={model.unit} />
              ))}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const ScheduleNetwork = austereComponent({
  name: "ScheduleNetwork",
  group: "Diagrams",
  tier: "extended",
  family: "Time and plan",
  keywords: [
    "schedule network",
    "critical path",
    "cpm",
    "float",
    "slack",
    "precedence",
    "dependencies with durations",
    "what decides the finish",
    "earliest start",
    "task network",
    "activity on node",
    "pert",
  ],
  guide,
  limits: [
    {
      prop: "tasks",
      max: 8,
      message: "ScheduleNetwork: 8 tasks at most. Split the plan, or group tasks.",
    },
  ],
  props: z.object({ tasks: z.array(ScheduleTask.definition.ref), unit: z.string().optional() }),
  description:
    'Tasks with durations and "after" links: works out earliest and latest start and finish and float, marks the critical path and the project finish. unit: the time unit (default "days"). Finish-to-start only. Each ScheduleTask is a click target.',
  renderer: ScheduleView,
  example: [
    `launchPlan = ScheduleNetwork([snA, snB, snC, snD])
snA = ScheduleTask("A", "Scope", 2)
snB = ScheduleTask("B", "Build", 5, ["A"])
snC = ScheduleTask("C", "Write docs", 3, ["A"])
snD = ScheduleTask("D", "Ship", 2, ["B", "C"])`,
    `migrationNet = ScheduleNetwork([mnA, mnB, mnC, mnD, mnE, mnF], "weeks")
mnA = ScheduleTask("FRZ", "Schema freeze", 1)
mnB = ScheduleTask("CPY", "Copy tables", 3, ["FRZ"])
mnC = ScheduleTask("APP", "Update the app", 4, ["FRZ"])
mnD = ScheduleTask("TST", "Compare data", 2, ["CPY"])
mnE = ScheduleTask("CUT", "Cut over", 1, ["TST", "APP"])
mnF = ScheduleTask("DRP", "Drop old tables", 1.5, ["CUT"])`,
  ],
  stress: [
    `stressNet = ScheduleNetwork([nsA, nsB, nsC, nsD, nsE, nsF, nsG, nsH], "a_unit_with_no_breaks_at_all")
nsA = ScheduleTask("A", "A_TASK_NAME_THAT_HAS_NO_BREAKS_AT_ALL_AND_MUST_BE_CUT", 1234567.891)
nsB = ScheduleTask("b", "支払いの確認", 2.5, ["A"])
nsC = ScheduleTask("C", "Third", 3, ["A", "B"])
nsD = ScheduleTask("D", "Fourth task with a long human readable name", 1, ["A"])
nsE = ScheduleTask("E", "Skips a rank", 2, ["A", "C"])
nsF = ScheduleTask("F", "Sixth", 0.000001, ["D", "E"])
nsG = ScheduleTask("G", "Seventh", 4, ["F"])
nsH = ScheduleTask("H", "Eighth", 1, ["C", "G"])`,
  ],
});

export default [ScheduleNetwork, ScheduleTask];
