import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { buildTrace } from "./_matrix-model.ts";
import type { TraceLink } from "./_matrix-model.ts";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Traceability.md";

const nothing = () => null;

export const TraceReq = austereComponent({
  name: "TraceReq",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    id: z.string(),
    text: z.string(),
    source: z.string().optional(),
  }),
  description:
    'One requirement on a Traceability: its stable ID ("REQ-4"), the statement, and source (where it comes from: "policy §3"). Its row shows what satisfies it and what verifies it. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const TraceItem = austereComponent({
  name: "TraceItem",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["design", "test"]),
    covers: z.array(z.string()),
  }),
  description:
    'One design element or test on a Traceability: its stable ID ("D-2", "T-7"), name, kind ("design" satisfies, "test" verifies) and covers, the IDs of the requirements it links to. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

type TraceProps = { requirements?: unknown; items?: unknown };

function Links({ list, gap }: { list: TraceLink[]; gap: { code: string; text: string } }) {
  if (!list.length) {
    return (
      <span className="dg-tr-gap" data-austere-part={`${gap.code}: ${gap.text}`}>
        {gap.text}
      </span>
    );
  }
  return (
    <ul className="dg-tr-links">
      {list.map((link) => (
        <li
          key={link.id}
          data-oui-id={link.named ? link.id : undefined}
          data-oui-c={link.named ? "TraceItem" : undefined}
        >
          <span
            className="dg-tr-code"
            data-austere-part={`${link.code}: ${link.name} (for ${gap.code})`}
          >
            {link.code}
          </span>{" "}
          <span className="dg-tr-name">{link.name}</span>
        </li>
      ))}
    </ul>
  );
}

function TraceView({ props, statementId }: RendererArgs<TraceProps>) {
  const trace = React.useMemo(() => buildTrace(props), [props]);
  useProblems(trace.problems, "traceability", "Traceability", statementId);
  return (
    <DiagramFrame className="dg-mx dg-trace" name="Requirement traceability">
      {() => {
        if (!trace.rows.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Traceability has no requirements.</strong> List the TraceReq statements,
                then the TraceItem statements that cover them.
              </div>
            ),
          };
        }
        const total = trace.rows.length;
        return {
          caption: (
            <p className="dg-mx-legend">
              {total - trace.gaps.noDesign.length} of {total} requirements have a design element;{" "}
              {total - trace.gaps.noTest.length} of {total} have a test.
              {trace.gaps.noDesign.length
                ? ` No design element: ${trace.gaps.noDesign.join(", ")}.`
                : ""}
              {trace.gaps.noTest.length ? ` No test: ${trace.gaps.noTest.join(", ")}.` : ""}
            </p>
          ),
          content: (
            <table
              className="dg-mx-table dg-tr-table"
              style={{ minWidth: trace.sourced ? "640px" : "520px" }}
            >
              <thead>
                <tr>
                  <th scope="col">Requirement</th>
                  {trace.sourced ? (
                    <th scope="col" className="dg-tr-source">
                      Source
                    </th>
                  ) : null}
                  <th scope="col">Satisfied by</th>
                  <th scope="col">Verified by</th>
                </tr>
              </thead>
              <tbody>
                {trace.rows.map((row) => (
                  <tr
                    key={row.id}
                    data-oui-id={row.named ? row.id : undefined}
                    data-oui-c={row.named ? "TraceReq" : undefined}
                  >
                    <th scope="row" className="dg-tr-req">
                      <span className="dg-tr-code" data-austere-part={`${row.code}: ${row.text}`}>
                        {row.code}
                      </span>{" "}
                      <span className="dg-tr-name">{row.text}</span>
                      {row.source ? (
                        <span className="dg-tr-source-inline">{row.source}</span>
                      ) : null}
                    </th>
                    {trace.sourced ? (
                      <td className="dg-tr-source">
                        {row.source ? (
                          <span data-austere-part={`${row.code} source: ${row.source}`}>
                            {row.source}
                          </span>
                        ) : null}
                      </td>
                    ) : null}
                    <td className={row.design.length ? undefined : "is-gap"}>
                      <Links
                        list={row.design}
                        gap={{ code: row.code, text: "No linked element" }}
                      />
                    </td>
                    <td className={row.tests.length ? undefined : "is-gap"}>
                      <Links list={row.tests} gap={{ code: row.code, text: "No verification" }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Traceability = austereComponent({
  name: "Traceability",
  group: "Diagrams",
  tier: "extended",
  family: "Matrices",
  keywords: [
    "traceability",
    "requirement traceability",
    "requirements matrix",
    "rtm",
    "coverage gap",
    "untested requirement",
    "satisfied by",
    "verified by",
    "compliance",
    "audit trail",
    "requirement to test",
    "design to test",
  ],
  guide,
  limits: [
    {
      prop: "requirements",
      max: 6,
      message:
        "Traceability: 6 requirements at most. Split the trace by area, or use a Table for the full list.",
    },
  ],
  props: z.object({
    requirements: z.array(TraceReq.definition.ref),
    items: z.array(TraceItem.definition.ref),
  }),
  description:
    "Requirements traced to what satisfies and verifies them: one TraceReq per row, TraceItem design elements and tests linked by requirement ID. A requirement with no link shows a marked gap. Use real IDs from the sources. Each part is a click target.",
  renderer: TraceView,
  example: [
    `accessTrace = Traceability([trLogin, trLock], [tdAuth, ttLogin])
trLogin = TraceReq("REQ-1", "Users sign in with SSO", "Policy §3.1")
trLock = TraceReq("REQ-2", "Five failed sign-ins lock the account", "Policy §3.4")
tdAuth = TraceItem("D-1", "Keycloak realm", "design", ["REQ-1", "REQ-2"])
ttLogin = TraceItem("T-1", "SSO sign-in test", "test", ["REQ-1"])`,
    `exportTrace = Traceability([teScope, teSize, teAudit, teRetry], [xdJob, xdLog, xtJob, xtSize])
teScope = TraceReq("EXP-1", "Export keeps notes and parts")
teSize = TraceReq("EXP-2", "A page under 5 MB exports in one file")
teAudit = TraceReq("EXP-3", "Every export is logged")
teRetry = TraceReq("EXP-4", "A failed export can be retried")
xdJob = TraceItem("D-10", "Export job", "design", ["EXP-1", "EXP-2", "EXP-4"])
xdLog = TraceItem("D-11", "Audit log writer", "design", ["EXP-3"])
xtJob = TraceItem("T-10", "Round-trip export test", "test", ["EXP-1"])
xtSize = TraceItem("T-11", "Size limit test", "test", ["EXP-2"])`,
  ],
  stress: [
    `stressTrace = Traceability([qA, qB, qC], [qdA, qtA, qdB])
qA = TraceReq("REQ-WITH-A-VERY-LONG-UNBROKEN-IDENTIFIER-THAT-MUST-WRAP-OR-BE-CUT-0000000000", "A_REQUIREMENT_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", "SOURCE_WITH_A_VERY_LONG_UNBROKEN_REFERENCE_THAT_MUST_WRAP_0000000000")
qB = TraceReq("要件-2", "東京リージョンの切り替え")
qC = TraceReq("REQ-3", "No design, no test")
qdA = TraceItem("D-WITH-A-VERY-LONG-UNBROKEN-IDENTIFIER-0000000000000000", "A_DESIGN_NAME_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", "design", ["REQ-WITH-A-VERY-LONG-UNBROKEN-IDENTIFIER-THAT-MUST-WRAP-OR-BE-CUT-0000000000", "要件-2"])
qtA = TraceItem("T-1", "A test", "test", ["要件-2"])
qdB = TraceItem("D-2", "Second design element", "design", ["要件-2"])`,
  ],
});

export default [Traceability, TraceReq, TraceItem];
