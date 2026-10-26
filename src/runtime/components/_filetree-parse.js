// FileTree input parsing, kept free of JSX so it can be unit-tested in Node
// (test/filetree.test.js). Lenient by design: agents write paths in many
// near-git shapes, and none of them may throw or become fake folders.

export const STATUS = {
  added: { key: "added", label: "A", title: "added" },
  modified: { key: "modified", label: "M", title: "modified" },
  deleted: { key: "deleted", label: "D", title: "deleted" },
  renamed: { key: "renamed", label: "R", title: "renamed" },
  conflict: { key: "conflict", label: "U", title: "conflict" },
};

// git status --short codes (X or XY, rename/copy scores like R100) and the
// long-form words agents also write.
const SHORT = /^(\?\?|!!|[MADRCUT ]{1,2}|[RC]\d{1,3})\s+(?=\S)/i;
const LONG = /^(new file|modified|deleted|renamed|copied|typechange|both modified|untracked):\s+/i;

function statusFromShort(code) {
  const c = code.toUpperCase();
  if (c === "??") return STATUS.added; // untracked = a new file, which is what a plan means
  if (c === "!!") return undefined;
  if (c.includes("U") || c === "AA" || c === "DD") return STATUS.conflict;
  if (c.startsWith("R")) return STATUS.renamed;
  if (c.startsWith("C") || c.includes("A")) return STATUS.added;
  if (c.includes("D")) return STATUS.deleted;
  return STATUS.modified; // M, T, MM, " M"
}

function statusFromLong(word) {
  const w = word.toLowerCase();
  if (w === "new file" || w === "untracked" || w === "copied") return STATUS.added;
  if (w === "deleted") return STATUS.deleted;
  if (w === "renamed") return STATUS.renamed;
  if (w === "both modified") return STATUS.conflict;
  return STATUS.modified;
}

/**
 * "M src/a.ts # why" | "R100 old -> new" | "?? tmp/" | "- src/a.ts" | "modified: x"
 * → { path, isDir, status?, note?, from? } or null. Never throws.
 */
export function parseEntry(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/[\r\n]+/g, " ").trim();
  if (!s) return null;
  s = s.replace(/^[-*+]\s+/, ""); // markdown bullet

  let note;
  const hash = /\s#(\s|$)/.exec(s);
  if (hash) {
    note = s.slice(hash.index + hash[0].length).trim() || undefined;
    s = s.slice(0, hash.index).trim();
  } else {
    const tight = /\s#(?=\S)/.exec(s); // "a.ts #note"
    if (tight) {
      note = s.slice(tight.index + 2).trim() || undefined;
      s = s.slice(0, tight.index).trim();
    }
  }

  let status;
  const long = LONG.exec(s);
  if (long) {
    status = statusFromLong(long[1]);
    s = s.slice(long[0].length);
  } else {
    const short = SHORT.exec(s);
    // A bare word like "src/a.ts" never matches: codes are 1-2 status letters or a score.
    if (short && short[1].trim()) {
      status = statusFromShort(short[1].trim());
      s = s.slice(short[0].length);
    }
  }

  let from;
  const arrow = s.indexOf(" -> ");
  if (arrow >= 0) {
    from = clean(s.slice(0, arrow));
    s = s.slice(arrow + 4);
    if (!status) status = STATUS.renamed;
  }
  s = clean(s);
  const isDir = s.endsWith("/") && s !== "/";
  const path = s.length > 1 ? s.replace(/\/+$/, "") : s;
  if (!path) return null;
  return { path, isDir, status, note, from: from || undefined };
}

function clean(p) {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

/** Last entry wins for a repeated path, in first-appearance order. */
export function parseEntries(list) {
  const byPath = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const e = parseEntry(raw);
    if (!e) continue;
    byPath.delete(e.path);
    byPath.set(e.path, e);
  }
  return Array.from(byPath.values());
}

/** What a rename shows: the old name alone when only the name changed. */
export function fromLabel(entry) {
  if (!entry.from) return undefined;
  const dir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  return dir(entry.from) === dir(entry.path) ? entry.from.slice(entry.from.lastIndexOf("/") + 1) : entry.from;
}

/**
 * Tree in first-appearance order; folders are inferred. Each node:
 * { name, path, part, dir, status?, note?, from?, children: Map }.
 * `part` is what a click reaches the agent as: the path as written (leading
 * "/" kept), with a trailing "/" for folders.
 */
export function buildTree(entries) {
  const root = { name: "", path: "", dir: true, children: new Map() };
  for (const e of entries) {
    const absolute = e.path.startsWith("/");
    const segs = e.path.split("/").filter(Boolean);
    if (!segs.length) continue;
    let node = root;
    segs.forEach((seg, i) => {
      const last = i === segs.length - 1;
      const dir = !last || e.isDir;
      const path = (absolute ? "/" : "") + segs.slice(0, i + 1).join("/");
      const name = i === 0 && absolute ? `/${seg}` : seg;
      let child = node.children.get(name);
      if (!child) {
        child = { name, path, dir, children: new Map() };
        node.children.set(name, child);
      } else if (dir) child.dir = true;
      if (last) Object.assign(child, { status: e.status, note: e.note, from: fromLabel(e) });
      node = child;
    });
  }
  return finish(compress(root));
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

function finish(node) {
  for (const c of node.children.values()) {
    c.part = c.dir ? `${c.path}/` : c.path;
    finish(c);
  }
  return node;
}

export function countFiles(node) {
  let n = 0;
  for (const c of node.children.values()) n += c.dir ? countFiles(c) : 1;
  return n;
}

/** "N files · 2 added · 1 modified" counts, over unique file rows. */
export function summarize(tree) {
  const by = {};
  let files = 0;
  const walk = (node) => {
    for (const c of node.children.values()) {
      if (c.dir) walk(c);
      else {
        files++;
        if (c.status) by[c.status.key] = (by[c.status.key] || 0) + 1;
      }
    }
  };
  walk(tree);
  const order = ["added", "modified", "renamed", "deleted", "conflict"];
  return { files, parts: order.filter((k) => by[k]).map((k) => ({ key: k, count: by[k] })) };
}
