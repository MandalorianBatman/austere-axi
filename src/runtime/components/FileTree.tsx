import React, { useMemo, useState } from "react";
import { z } from "zod";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { austereComponent } from "../define.js";
import { buildTree, countFiles, parseEntries, summarize } from "./_filetree-parse.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Row({ node, depth, collapsed, toggle }) {
  const isOpen = node.dir && !collapsed.has(node.path);
  const Icon = node.dir ? (isOpen ? FolderOpen : Folder) : FileText;
  const status = node.status;
  return (
    <>
      <div
        className={`austere-filetree-row${node.dir ? " is-dir" : ""}${status ? ` is-${status.key}` : ""}`}
        style={{ "--depth": depth }}
        data-austere-part={node.part}
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
          {/* Counts and status letters are drawn by CSS so a clicked row quotes only its name and note. */}
          {!isOpen && node.dir ? (
            <span className="austere-filetree-count" data-n={plural(countFiles(node), "file")} />
          ) : null}
          {node.note ? <span className="austere-filetree-note">{node.note}</span> : null}
        </span>
        {status ? (
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
  const tree = useMemo(() => buildTree(parseEntries(props.entries)), [props.entries]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggle = (path) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  if (!tree.children.size) return null;
  const sum = summarize(tree);
  return (
    <div className="austere-filetree">
      {sum.parts.length ? (
        <div className="austere-filetree-summary">
          <span>{plural(sum.files, "file")}</span>
          {sum.parts.map((p) => (
            <span key={p.key} className={`is-${p.key}`}>
              {p.count} {p.key}
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
    'File tree, one path per entry, optionally prefixed with a git status code (A new, M modified, D deleted, R old -> new) and suffixed with " # note". Folders are inferred. Clicked files and folders reach the agent by path.',
  renderer: FileTreeView,
  example: `changedFiles = FileTree(["M src/session/store.ts # read-through to Postgres", "A src/session/pg-store.ts", "A migrations/0042_sessions.sql # table + expiry index", "R src/session/redis.ts -> src/session/redis-cache.ts", "D src/session/legacy.ts", "M src/config.ts # SESSIONS_PG flag"])`,
  stress: `stressFiles = FileTree(["M src/a/b/c/d/e/0043_session_expiry_and_cleanup_job.sql # SESSIONS_PG_READ_THROUGH_CACHE_TTL_SECONDS_OVERRIDE_FOR_STAGING_ENVIRONMENT_ONLY", "- src/bullet.ts", "R100 src/hooks/useSession.ts -> src/hooks/useSessionStore.ts # long prose note that keeps going so it has to wrap under the name on a phone", "m src/lower.ts", "modified:   src/long-form.ts", "T scripts/deploy.sh", "M /etc/nginx/sites-available/app.conf #tight", "?? docs/", "", "src/x.ts", "src/x.ts # duplicate wins"])`,
});
