import React, { useMemo } from "react";
import { z } from "zod";
import { austereComponent } from "../define.js";

/** Parse a unified diff (git or plain) into files -> rows. Tolerant of partial input. */
export function parseUnifiedDiff(patch) {
  const files = [];
  let file = null;
  let oldNo = 0;
  let newNo = 0;
  const ensureFile = (name) => {
    if (!file) {
      file = { name: name || "", rows: [] };
      files.push(file);
    }
    return file;
  };
  const lines = String(patch ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(raw);
      file = { name: m ? m[1] : raw.slice(11), rows: [] };
      files.push(file);
      continue;
    }
    if (/^(index |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(raw)) {
      continue;
    }
    if (raw.startsWith("--- ")) {
      const name = raw.slice(4).replace(/^a\//, "").replace(/\t.*$/, "");
      if (!file || file.rows.length) {
        file = { name: name === "/dev/null" ? "" : name, rows: [] };
        files.push(file);
      }
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const name = raw.slice(4).replace(/^b\//, "").replace(/\t.*$/, "");
      ensureFile(name);
      if (name !== "/dev/null") file.name = name;
      continue;
    }
    const f = ensureFile("");
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      f.rows.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("\\")) {
      f.rows.push({ kind: "meta", text: raw });
      continue;
    }
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === "+") f.rows.push({ kind: "add", text, newNo: newNo++ });
    else if (sign === "-") f.rows.push({ kind: "del", text, oldNo: oldNo++ });
    else f.rows.push({ kind: "ctx", text: sign === " " ? text : raw, oldNo: oldNo++, newNo: newNo++ });
  }
  return files;
}

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
      {props.title ? <div className="austere-diff-title">{props.title}</div> : null}
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
  notes: ["- Diff for code changes; prefer it over two CodeBlocks."],
  renderer: DiffView,
  example: `retryPatch = Diff("diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -10,2 +10,3 @@
-  for (let i = 0; i < 3; i++) {
+  for (let i = 0; i < MAX_ATTEMPTS; i++) {
+    if (i > 0) await sleep(backoff(i));")`,
});
