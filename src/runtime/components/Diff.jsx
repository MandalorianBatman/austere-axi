import React, { useMemo } from "react";
import { z } from "zod";
import { austereComponent } from "../define.js";
import { parseUnifiedDiff } from "./_diff-parse.js";

function DiffView({ props }) {
  const files = useMemo(() => parseUnifiedDiff(props.patch), [props.patch]);
  const stats = (rows) => {
    let a = 0;
    let d = 0;
    for (const r of rows) {
      if (r.kind === "add") a++;
      else if (r.kind === "del") d++;
    }
    return { a, d };
  };
  return (
    <div className="austere-diff">
      {/* A title that just repeats the file path would show it twice. */}
      {props.title && !files.some((f) => f.name && f.name === String(props.title).trim().replace(/^[ab]\//, "")) ? (
        <div className="austere-diff-title">{props.title}</div>
      ) : null}
      {files.map((file, fi) => {
        const { a, d } = stats(file.rows);
        return (
          <div className="austere-diff-file" key={fi}>
            {file.name ? (
              <div className="austere-diff-file-head">
                <span className="austere-diff-path">{file.name}</span>
                <span className="austere-diff-stat">
                  <span className="austere-diff-a">+{a}</span> <span className="austere-diff-d">-{d}</span>
                </span>
              </div>
            ) : null}
            <div className="austere-diff-body">
              <table>
                <tbody>
                  {file.rows.map((r, ri) => {
                    if (r.kind === "hunk" || r.kind === "meta") {
                      return (
                        <tr className={`austere-diff-${r.kind}`} key={ri}>
                          <td className="austere-diff-no" />
                          <td className="austere-diff-no" />
                          <td className="austere-diff-code">{r.text}</td>
                        </tr>
                      );
                    }
                    const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
                    const lineRef =
                      r.kind === "add"
                        ? `${file.name ? file.name + ":" : ""}+${r.newNo}`
                        : r.kind === "del"
                          ? `${file.name ? file.name + ":" : ""}-${r.oldNo}`
                          : `${file.name ? file.name + ":" : ""}${r.newNo}`;
                    return (
                      <tr className={`austere-diff-${r.kind}`} key={ri} data-austere-part={lineRef}>
                        {/* Numbers come from CSS so a clicked line quotes only its code. */}
                        <td className="austere-diff-no" data-n={r.oldNo ?? ""} />
                        <td className="austere-diff-no" data-n={r.newNo ?? ""} />
                        <td className="austere-diff-code">
                          <span className="austere-diff-sign">{sign}</span>
                          {r.text || " "}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default austereComponent({
  name: "Diff",
  group: "Content",
  props: z.object({
    patch: z.string(),
    title: z.string().optional(),
  }),
  description:
    "Unified diff (git diff output, one or more files) with line numbers. patch is a raw multi-line string. Clicked lines reach the agent as file:+line.",
  notes: ["- Diff for code changes: show the hunks that matter, not whole files. Hunk counts are recomputed, so only start lines matter."],
  renderer: DiffView,
  example: `retryPatch = Diff("diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -10,2 +10,3 @@
-  for (let i = 0; i < 3; i++) {
+  for (let i = 0; i < MAX_ATTEMPTS; i++) {
+    if (i > 0) await sleep(backoff(i));")`,
});
