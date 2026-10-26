import React, { useMemo, useState } from "react";
import { z } from "zod";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { austereComponent } from "../define.js";

const STATUS = {
  A: { key: "added", label: "A", title: "added" },
  C: { key: "added", label: "C", title: "copied" },
  M: { key: "modified", label: "M", title: "modified" },
  D: { key: "deleted", label: "D", title: "deleted" },
  R: { key: "renamed", label: "R", title: "renamed" },
  U: { key: "conflict", label: "U", title: "conflict" },
  "?": { key: "untracked", label: "?", title: "untracked" },
};

/** "M src/a.ts # why" | "R old -> new" | "?? tmp/" | "docs/" → entry. Never throws. */
export function parseEntry(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  let note;
  const hash = s.indexOf(" # ");
  if (hash >= 0) {
    note = s.slice(hash + 3).trim() || undefined;
    s = s.slice(0, hash).trim();
  }
  let status;
  const m = /^(\?\?|[MADRCU]{1,2})\s+(\S.*)$/.exec(s);
  if (m) {
    const code = m[1] === "??" ? "?" : [...m[1]].find((c) => c !== "M") || "M";
    status = STATUS[code];
    s = m[2];
  }
  let from;
  const arrow = s.indexOf(" -> ");
  if (arrow >= 0) {
    from = s.slice(0, arrow).trim();
    s = s.slice(arrow + 4).trim();
  }
  s = s.replace(/\\/g, "/").replace(/^\.\//, "");
  const isDir = s.endsWith("/");
  const path = s.replace(/\/+$/, "");
  if (!path) return null;
  return { path, isDir, status, note, from };
}

/** Build a tree in first-appearance order; folders are inferred from paths. */
export function buildTree(entries) {
  const root = { name: "", path: "", dir: true, children: new Map() };
  for (const e of entries) {
    const parts = e.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const dir = !last || e.isDir;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, dir, children: new Map() };
        node.children.set(part, child);
      } else if (dir) child.dir = true;
      if (last) Object.assign(child, { status: e.status, note: e.note, from: e.from });
      node = child;
    });
  }
  return compress(root);
}

// "src" > "session" > files becomes "src/session" > files, as code hosts show it.
function compress(node) {
  for (const [key, child] of node.children) {
    let c = child;
    while (c.dir && c.children.size === 1 && !c.status && !c.note) {
      const only = c.children.values().next().value;
      if (!only.dir) break;
      c = { ...only, name: `${c.name}/${only.name}` };
    }
    node.children.set(key, compress(c));
  }
  return node;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function countFiles(node) {
  let n = 0;
  for (const c of node.children.values()) n += c.dir ? countFiles(c) : 1;
  return n;
}

function summary(entries) {
  const files = entries.filter((e) => !e.isDir);
  const by = {};
  for (const e of files) if (e.status) by[e.status.key] = (by[e.status.key] || 0) + 1;
  const order = ["added", "modified", "renamed", "deleted", "conflict", "untracked"];
  const parts = order.filter((k) => by[k]).map((k) => ({ key: k, text: `${by[k]} ${k}` }));
  return { files: files.length, parts };
}

function Row({ node, depth, collapsed, toggle }) {
  const isOpen = node.dir && !collapsed.has(node.path);
  const Icon = node.dir ? (isOpen ? FolderOpen : Folder) : FileText;
  const status = node.status;
  const part = node.dir ? `${node.path}/` : node.path;
  return (
    <>
      <div
        className={`austere-filetree-row${node.dir ? " is-dir" : ""}${status ? ` is-${status.key}` : ""}`}
        style={{ "--depth": depth }}
        data-austere-part={part}
      >
        {node.dir ? (
          <button
            type="button"
            className="austere-filetree-toggle"
            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-expanded={isOpen}
            onClick={() => toggle(node.path)}
          >
            {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        ) : (
          <span className="austere-filetree-toggle" aria-hidden="true" />
        )}
        <Icon className="austere-filetree-icon" size={15} aria-hidden="true" />
        <span className="austere-filetree-text">
          <span className="austere-filetree-name">{node.name}</span>
          {node.from ? <span className="austere-filetree-from">from {node.from}</span> : null}
          {!isOpen && node.dir ? <span className="austere-filetree-from">{plural(countFiles(node), "file")}</span> : null}
          {node.note ? <span className="austere-filetree-note">{node.note}</span> : null}
        </span>
        {status ? (
          // Letter drawn by CSS so a clicked row quotes only the name and note.
          <span className={`austere-filetree-status is-${status.key}`} title={status.title} data-s={status.label} />
        ) : null}
      </div>
      {isOpen
        ? Array.from(node.children.values()).map((c) => (
            <Row key={c.path} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} />
          ))
        : null}
    </>
  );
}

function FileTreeView({ props }) {
  const entries = useMemo(
    () => (Array.isArray(props.entries) ? props.entries : []).map(parseEntry).filter(Boolean),
    [props.entries],
  );
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggle = (path) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  if (!entries.length) return null;
  const sum = summary(entries);
  return (
    <div className="austere-filetree">
      {sum.parts.length ? (
        <div className="austere-filetree-summary">
          <span>{plural(sum.files, "file")}</span>
          {sum.parts.map((p) => (
            <span key={p.key} className={`is-${p.key}`}>
              {p.text}
            </span>
          ))}
        </div>
      ) : null}
      <div className="austere-filetree-list">
        {Array.from(tree.children.values()).map((c) => (
          <Row key={c.path} node={c} depth={0} collapsed={collapsed} toggle={toggle} />
        ))}
      </div>
    </div>
  );
}

export default austereComponent({
  name: "FileTree",
  group: "Data",
  props: z.object({
    entries: z.array(z.string()),
  }),
  description:
    'File tree from paths, one per entry, optionally prefixed with a git status --short code (A, M, D, R, ??) and suffixed with " # note". Folders are inferred. Clicked files and folders reach the agent by path.',
  renderer: FileTreeView,
  example: `changedFiles = FileTree(["M src/session/store.ts # read-through to Postgres", "A src/session/pg-store.ts", "A migrations/0042_sessions.sql # table + expiry index", "R src/session/redis.ts -> src/session/redis-cache.ts", "D src/session/legacy.ts", "M src/config.ts # SESSIONS_PG flag"])`,
});
