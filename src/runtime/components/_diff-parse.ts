// Unified-diff parsing for Diff, free of JSX so it can be unit-tested in Node.

export interface DiffHunkRow {
  kind: "hunk";
  text: string;
  oldStart?: number;
  newStart?: number;
  tail?: string;
  oldCount?: number;
  newCount?: number;
}
export interface DiffMetaRow {
  kind: "meta";
  text: string;
}
export interface DiffLineRow {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}
export type DiffRow = DiffHunkRow | DiffMetaRow | DiffLineRow;
export interface DiffFile {
  name: string;
  rows: DiffRow[];
}
interface CountedHunk extends DiffHunkRow {
  oldStart: number;
  newStart: number;
  tail: string;
  oldCount: number;
  newCount: number;
}

/** Parse a unified diff (git or plain) into files -> rows. Tolerant of partial input. */
export function parseUnifiedDiff(patch: unknown): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let hunk: DiffHunkRow | null = null;
  const ensureFile = (name: string): DiffFile => {
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
      hunk = null;
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
      const target = ensureFile(name);
      if (name !== "/dev/null") target.name = name;
      continue;
    }
    const f = ensureFile("");
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        const counted: CountedHunk = { kind: "hunk", text: raw, oldStart: oldNo, newStart: newNo, tail: m[3], oldCount: 0, newCount: 0 };
        hunk = counted;
      } else {
        hunk = { kind: "hunk", text: raw };
      }
      f.rows.push(hunk);
      continue;
    }
    if (raw.startsWith("\\")) {
      f.rows.push({ kind: "meta", text: raw });
      continue;
    }
    const sign = raw[0];
    const text = raw.slice(1);
    const counted = hunk && isCounted(hunk) ? hunk : null;
    if (sign === "+") {
      f.rows.push({ kind: "add", text, newNo: newNo++ });
      if (counted) counted.newCount++;
    } else if (sign === "-") {
      f.rows.push({ kind: "del", text, oldNo: oldNo++ });
      if (counted) counted.oldCount++;
    } else {
      f.rows.push({ kind: "ctx", text: sign === " " ? text : raw, oldNo: oldNo++, newNo: newNo++ });
      if (counted) {
        counted.oldCount++;
        counted.newCount++;
      }
    }
  }
  // Agents miscount hunk sizes; show counts that match the lines actually given.
  for (const f of files) {
    for (const r of f.rows) {
      if (r.kind === "hunk" && r.oldStart !== undefined) {
        r.text = `@@ -${r.oldStart},${r.oldCount} +${r.newStart},${r.newCount} @@${r.tail}`;
      }
    }
  }
  return files;
}

function isCounted(h: DiffHunkRow): h is CountedHunk {
  return h.oldStart !== undefined;
}
