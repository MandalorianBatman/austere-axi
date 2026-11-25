import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { ACCESS_LABELS, buildPermissions } from "./_matrix-model.ts";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./PermissionMatrix.md";

const nothing = () => null;

export const AccessRow = austereComponent({
  name: "AccessRow",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    resource: z.string(),
    grants: z.array(z.string()),
    hint: z.string().optional(),
    focus: z.string().optional(),
  }),
  description:
    'One resource on a PermissionMatrix: its name and one access level for each role, in role order ("none", "read", "write", "admin"; "R/W", "SELECT" and "full" are read as the nearest). hint is a short aside ("S3 API"). focus is the role whose cell is the key rule. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

type PermissionProps = { roles?: unknown; rows?: unknown };

function PermissionView({ props, statementId }: RendererArgs<PermissionProps>) {
  const matrix = React.useMemo(() => buildPermissions(props), [props]);
  useProblems(matrix.problems, "permissionmatrix", "PermissionMatrix", statementId);
  return (
    <DiagramFrame className="dg-mx dg-perm" name="Permission matrix">
      {() => {
        if (!matrix.roles.length || !matrix.rows.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>PermissionMatrix has no {matrix.roles.length ? "rows" : "roles"}.</strong>{" "}
                Pass the role names, then the AccessRow statements.
              </div>
            ),
          };
        }
        return {
          caption: (
            <p className="dg-mx-legend">
              {matrix.used.map((level) => (
                <span className="dg-perm-key" key={level}>
                  <i className={`dg-perm-swatch l-${level}`} aria-hidden="true" />
                  {ACCESS_LABELS[level]}
                </span>
              ))}
              {matrix.hasFocal ? (
                <span className="dg-perm-key">
                  <i className="dg-perm-swatch is-focal" aria-hidden="true" />
                  Key rule
                </span>
              ) : null}
            </p>
          ),
          content: (
            <table
              className="dg-mx-table"
              style={{ minWidth: `${160 + matrix.roles.length * 84}px` }}
            >
              <thead>
                <tr>
                  <th scope="col" className="dg-mx-corner">
                    Resource
                  </th>
                  {matrix.roles.map((role, c) => (
                    <th scope="col" key={c} data-austere-part={`${role} role`}>
                      {role}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr
                    key={row.id}
                    data-oui-id={row.named ? row.id : undefined}
                    data-oui-c={row.named ? "AccessRow" : undefined}
                  >
                    <th scope="row" data-austere-part={row.resource}>
                      {row.resource}
                      {row.hint ? <span className="dg-mx-hint">{row.hint}</span> : null}
                    </th>
                    {row.cells.map((cell, c) => (
                      <td
                        key={c}
                        className={`dg-perm-cell l-${cell.level ?? "other"}${cell.focal ? " is-focal" : ""}`}
                        data-sr={cell.focal ? " (key rule)" : undefined}
                      >
                        {cell.text}
                      </td>
                    ))}
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

export const PermissionMatrix = austereComponent({
  name: "PermissionMatrix",
  group: "Diagrams",
  tier: "extended",
  family: "Matrices",
  keywords: [
    "permission matrix",
    "access matrix",
    "security matrix",
    "rbac",
    "roles",
    "who can",
    "who can do what",
    "access control",
    "read write admin",
    "least privilege",
    "audit access",
    "iam",
  ],
  guide,
  limits: [
    {
      prop: "roles",
      max: 6,
      message: "PermissionMatrix: 6 roles at most. Split human roles from service accounts.",
    },
    {
      prop: "rows",
      max: 14,
      message: "PermissionMatrix: 14 resources at most. Split by area (storage, compute, access).",
    },
  ],
  props: z.object({
    roles: z.array(z.string()),
    rows: z.array(AccessRow.definition.ref),
  }),
  description:
    "Who can do what: roles (names, across) against resources, one AccessRow each with an access level for every role (none, read, write, admin). The level is printed in every cell. Not how access is granted. Each row is a click target.",
  renderer: PermissionView,
  example: [
    `platformAccess = PermissionMatrix(["Admins", "Engineers", "Analysts"], [pmAuth, pmRaw, pmAgg])
pmAuth = AccessRow("Keycloak", ["admin", "read", "read"], "SSO")
pmRaw = AccessRow("Raw bucket", ["admin", "write", "none"], "S3 API")
pmAgg = AccessRow("Aggregated catalog", ["admin", "write", "read"], "", "Analysts")`,
    `cloudAccess = PermissionMatrix(["Owner", "Developer", "Support", "Billing", "Auditor"], [caProd, caStage, caLogs, caBill, caKeys])
caProd = AccessRow("Production cluster", ["admin", "read", "read", "none", "read"])
caStage = AccessRow("Staging cluster", ["admin", "write", "read", "none", "read"])
caLogs = AccessRow("Log archive", ["admin", "read", "read", "none", "admin"], "7 years")
caBill = AccessRow("Billing console", ["admin", "none", "none", "write", "read"])
caKeys = AccessRow("Signing keys", ["admin", "none", "none", "none", "none"], "", "Owner")`,
  ],
  stress: [
    `stressAccess = PermissionMatrix(["ROLE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "支払い", "C", "D", "E", "F"], [psA, psB, psC])
psA = AccessRow("RESOURCE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", ["admin", "write", "read", "none", "R/W", "SELECT"], "HINT_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP", "支払い")
psB = AccessRow("東京リージョン", ["full", "rw", "login", "", "-", "owner"])
psC = AccessRow("Odd words", ["break-glass", "admin", "none", "read", "write", "admin"])`,
  ],
});

export default [PermissionMatrix, AccessRow];
