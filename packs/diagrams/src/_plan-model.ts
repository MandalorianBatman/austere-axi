// Gantt, GitGraph and ScheduleNetwork: parsed props → bars, lanes and a computed schedule.
// Pure TypeScript (no JSX), so Node tests can import it. Never throws: a shape that is
// wrong still draws what it can, and says what it dropped in `problems`.
import { clean, partsOf, str } from "./_matrix-model.ts";

// ── Gantt ──
// Dates are "YYYY-MM-DD" and are handled as UTC day numbers, so a time zone or a DST
// change never shifts a bar. Same rules as the austere-pack-gantt pack, so a page
// written for that pack draws the same.

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-09" → UTC day number, or null when it is not a real calendar date. */
export function parseDay(text: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(text).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    return null;
  return ms / DAY;
}

/** "Nov 9", or "Nov" when `monthOnly`. */
export function labelDay(day: number, monthOnly = false): string {
  const d = new Date(day * DAY);
  return monthOnly ? MONTHS[d.getUTCMonth()] : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const isMonday = (day: number): boolean => new Date(day * DAY).getUTCDay() === 1;
const MAX_TICKS = 8;

export interface Tick {
  day: number;
  label: string;
}

/** Axis ticks between first and last (inclusive): the finest unit that fits MAX_TICKS labels. */
export function axisTicks(first: number, last: number): Tick[] {
  // Only a short range can use days or weeks: eight labels fit no more than 15 days, 8 weeks or 16.
  if (last - first < 120) {
    const days: number[] = [];
    for (let d = first; d <= last; d++) days.push(d);
    const units = [
      { keep: () => true },
      { keep: (d: number) => (d - first) % 2 === 0 },
      { keep: isMonday },
      { keep: (d: number) => isMonday(d) && Math.round(d / 7) % 2 === 0 },
    ];
    for (const keep of units.map((u) => u.keep)) {
      const picked = days.filter(keep);
      if (picked.length && picked.length <= MAX_TICKS)
        return picked.map((day) => ({ day, label: labelDay(day) }));
    }
  }
  // Month starts, thinned evenly. Built from the calendar, not day by day: a typo year stays cheap.
  const from = new Date(first * DAY);
  const months: number[] = [];
  for (
    let m =
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + (from.getUTCDate() > 1 ? 1 : 0), 1) /
      DAY;
    m <= last;
  ) {
    months.push(m);
    const d = new Date(m * DAY);
    m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY;
  }
  const step = Math.ceil(months.length / MAX_TICKS) || 1;
  return months
    .filter((_, i) => i % step === 0)
    .map((day) => ({ day, label: labelDay(day, true) }));
}

const clampPct = (n: unknown): number => Math.min(100, Math.max(0, Number(n) || 0));

export interface GanttRow {
  id: string;
  named: boolean;
  name: string;
  owner: string;
  progress: number;
  milestone: boolean;
  /** Why the row has no bar. */
  error?: string;
  /** Percent of the track. */
  left: number;
  width: number;
  startLabel: string;
  endLabel: string;
}

export interface GanttModel {
  rows: GanttRow[];
  /** null when no row has valid dates. */
  axis: { first: number; span: number; ticks: Tick[] } | null;
  problems: string[];
}

/**
 * Gantt(tasks, title?): a task with no `end` is a milestone (one day, a diamond). A row whose
 * dates do not parse, or whose end is before its start, keeps its place with an `error` and no
 * bar, so one typo never hides the chart.
 */
export function buildGantt(props: Record<string, unknown> | undefined): GanttModel {
  const problems: string[] = [];
  const parts = partsOf(props?.tasks, "task", "GanttTask", "Gantt", problems);
  const raw = parts.map((part) => {
    const t = part.props;
    const startText = str(t.start).trim();
    const endText = str(t.end).trim();
    const start = parseDay(startText);
    const end = endText ? parseDay(endText) : start;
    const name = str(t.name);
    let error: string | undefined;
    if (start === null) error = `start "${startText}" is not YYYY-MM-DD`;
    else if (end === null) error = `end "${endText}" is not YYYY-MM-DD`;
    else if (end < start) error = "ends before it starts";
    return { part, name, start, end, milestone: !endText, error };
  });
  const valid = raw.filter((r) => !r.error);
  if (!valid.length) {
    return {
      axis: null,
      problems,
      rows: raw.map((r) => ({
        id: r.part.id,
        named: r.part.named,
        name: r.name,
        owner: str(r.part.props.owner),
        progress: 0,
        milestone: false,
        error: r.error ?? "no task has valid dates",
        left: 0,
        width: 0,
        startLabel: "",
        endLabel: "",
      })),
    };
  }
  const first = Math.min(...valid.map((r) => r.start as number));
  const last = Math.max(...valid.map((r) => r.end as number));
  const span = last - first + 1;
  return {
    axis: { first, span, ticks: axisTicks(first, last) },
    problems,
    rows: raw.map((r) => {
      const base = {
        id: r.part.id,
        named: r.part.named,
        name: r.name,
        owner: str(r.part.props.owner),
        progress: clampPct(r.part.props.progress),
        milestone: r.milestone,
      };
      if (r.error || r.start === null || r.end === null)
        return { ...base, error: r.error, left: 0, width: 0, startLabel: "", endLabel: "" };
      return {
        ...base,
        left: ((r.start - first) / span) * 100,
        width: ((r.end - r.start + 1) / span) * 100,
        startLabel: labelDay(r.start),
        endLabel: labelDay(r.end),
      };
    }),
  };
}

// ── GitGraph ──

export const GIT_MAX_LANES = 5;

export interface GitCommitModel {
  id: string;
  named: boolean;
  message: string;
  lane: number;
  column: number;
  /** Lane of the first parent (the commit before it on its lane, or the lane it was cut from), or -1. */
  parent: { column: number; lane: number } | null;
  /** The second parent of a merge. */
  merged: { column: number; lane: number } | null;
  tag: string;
  focal: boolean;
}

export interface GitGraphModel {
  lanes: string[];
  commits: GitCommitModel[];
  problems: string[];
}

const laneKey = (v: unknown): string => clean(v).toLowerCase();

/**
 * GitGraph(lanes, commits): lanes top to bottom; commits in time order, one column each.
 * A commit's first parent is the previous commit on its lane. The first commit on a lane is
 * cut from the lane named in `branchFrom`; a commit with `mergeFrom` merges the latest commit
 * of that lane into its own. A lane a commit names that is not listed is added.
 */
export function buildGitGraph(props: Record<string, unknown> | undefined): GitGraphModel {
  const problems: string[] = [];
  const lanes: string[] = [];
  for (const item of Array.isArray(props?.lanes) ? props.lanes : []) {
    const name = clean(item);
    if (!name) continue;
    if (lanes.some((l) => laneKey(l) === laneKey(name))) {
      problems.push(`GitGraph lane "${name}" is listed twice. It is drawn once.`);
      continue;
    }
    lanes.push(name);
  }
  const laneAt = (name: unknown): number =>
    laneKey(name) ? lanes.findIndex((l) => laneKey(l) === laneKey(name)) : -1;
  const parts = partsOf(props?.commits, "commit", "GitCommit", "GitGraph", problems);
  const last = new Map<number, number>(); // lane → column of its latest commit so far
  const commits: GitCommitModel[] = [];
  for (const part of parts) {
    const p = part.props;
    const message = clean(p.message) || part.id;
    let lane = laneAt(p.lane);
    if (lane < 0) {
      const name = clean(p.lane);
      if (name) {
        lanes.push(name);
        lane = lanes.length - 1;
        problems.push(
          `GitCommit "${message}" is on lane "${name}", which GitGraph does not list. The lane is added.`,
        );
      } else {
        lane = 0;
        problems.push(
          `GitCommit "${message}" names no lane. It is drawn on "${lanes[0] ?? "main"}".`,
        );
        if (!lanes.length) lanes.push("main");
      }
    }
    const column = commits.length;
    const tail = (name: unknown, what: string): { column: number; lane: number } | null => {
      const from = laneAt(name);
      const at = from < 0 ? undefined : last.get(from);
      if (at === undefined) {
        problems.push(
          `GitCommit "${message}" ${what} "${clean(name)}", which has no commit yet. The link is dropped.`,
        );
        return null;
      }
      return { column: at, lane: from };
    };
    let parent: GitCommitModel["parent"] = null;
    const previous = last.get(lane);
    if (previous !== undefined) {
      parent = { column: previous, lane };
    } else if (clean(p.branchFrom)) {
      parent = tail(p.branchFrom, "branches from");
    }
    let merged: GitCommitModel["merged"] = null;
    if (clean(p.mergeFrom)) {
      merged = tail(p.mergeFrom, "merges");
      if (merged && merged.lane === lane) {
        problems.push(`GitCommit "${message}" merges its own lane. The merge is dropped.`);
        merged = null;
      }
    }
    commits.push({
      id: part.id,
      named: part.named,
      message,
      lane,
      column,
      parent,
      merged,
      tag: clean(p.tag),
      focal: p.focus === true,
    });
    last.set(lane, column);
  }
  const focal = commits.filter((c) => c.focal);
  if (focal.length > 2) {
    problems.push("GitGraph has more than 2 focus commits. Only the first 2 are ringed.");
    for (const c of focal.slice(2)) c.focal = false;
  }
  return { lanes, commits, problems };
}

// ── ScheduleNetwork ──

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A duration given as a number or a numeric string: positive and finite, else null. */
export function parseDuration(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(str(v).trim().replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? round6(n) : null;
}

export interface ScheduleTaskModel {
  /** The id the author gave (uppercase). */
  key: string;
  /** The statement name, or "#task0". */
  id: string;
  named: boolean;
  name: string;
  duration: number;
  after: string[];
  rank: number;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  /** Total float: how long it may slip without moving the finish. */
  tf: number;
  critical: boolean;
}

export interface ScheduleLinkModel {
  from: string;
  to: string;
  critical: boolean;
}

export interface ScheduleModel {
  tasks: ScheduleTaskModel[];
  links: ScheduleLinkModel[];
  unit: string;
  finish: number;
  /** The critical tasks in order of start, as ids. */
  path: string[];
  problems: string[];
}

/** Numbers as printed: no trailing zeros, no float noise. */
export const num = (n: number): string => String(round6(n));

/**
 * ScheduleNetwork(tasks, unit?): finish-to-start, no lag. ES = the latest predecessor EF (0 at a
 * start), EF = ES + duration; LF = the earliest successor LS (the finish at an end), LS = LF − duration;
 * float = LS − ES. A task is critical when its float is 0; a link is critical when both ends are and
 * EF(source) = ES(target). A bad task or link is dropped and reported; a cycle drops the links that
 * close it.
 */
export function buildSchedule(props: Record<string, unknown> | undefined): ScheduleModel {
  const problems: string[] = [];
  const unit = clean(props?.unit).toLowerCase() || "days";
  const parts = partsOf(props?.tasks, "task", "ScheduleTask", "ScheduleNetwork", problems);
  const byKey = new Map<string, ScheduleTaskModel>();
  const order: ScheduleTaskModel[] = [];
  for (const part of parts) {
    const p = part.props;
    const key = clean(p.id).toUpperCase();
    const name = clean(p.name) || key || part.id;
    const duration = parseDuration(p.duration);
    if (!key) {
      problems.push(`ScheduleTask "${name}" has no id. It is dropped.`);
      continue;
    }
    if (byKey.has(key)) {
      problems.push(`ScheduleTask id "${key}" is used twice. The second is dropped.`);
      continue;
    }
    if (duration === null) {
      problems.push(
        `ScheduleTask ${key} "${name}": duration must be a number above 0 (no milestones). It is dropped.`,
      );
      continue;
    }
    const after = (Array.isArray(p.after) ? p.after : [])
      .map((a) => clean(a).toUpperCase())
      .filter((a, i, all) => a && all.indexOf(a) === i);
    const task: ScheduleTaskModel = {
      key,
      id: part.id,
      named: part.named,
      name,
      duration,
      after,
      rank: 0,
      es: 0,
      ef: 0,
      ls: 0,
      lf: 0,
      tf: 0,
      critical: false,
    };
    byKey.set(key, task);
    order.push(task);
  }
  // Keep links to tasks that exist; then drop what closes a cycle (depth-first, in list order).
  const links: [string, string][] = [];
  for (const t of order) {
    for (const a of t.after) {
      if (a === t.key)
        problems.push(`ScheduleTask ${t.key} comes after itself. The link is dropped.`);
      else if (!byKey.has(a))
        problems.push(
          `ScheduleTask ${t.key} comes after ${a}, which is not a task id. The link is dropped.`,
        );
      else links.push([a, t.key]);
    }
  }
  const kept: [string, string][] = [];
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const k = stack.pop() as string;
      if (k === to) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const [a, b] of kept) if (a === k) stack.push(b);
    }
    return false;
  };
  for (const [a, b] of links) {
    if (reaches(b, a))
      problems.push(
        `ScheduleTask ${b} comes after ${a}, which closes a cycle. The link is dropped.`,
      );
    else kept.push([a, b]);
  }
  const preds = (k: string): string[] => kept.filter(([, b]) => b === k).map(([a]) => a);
  const succs = (k: string): string[] => kept.filter(([a]) => a === k).map(([, b]) => b);
  // Forward pass in dependency order (the graph is acyclic here).
  const done = new Set<string>();
  const visit = (t: ScheduleTaskModel) => {
    if (done.has(t.key)) return;
    done.add(t.key);
    let es = 0;
    let rank = 0;
    for (const a of preds(t.key)) {
      const p = byKey.get(a) as ScheduleTaskModel;
      visit(p);
      es = Math.max(es, p.ef);
      rank = Math.max(rank, p.rank + 1);
    }
    t.es = round6(es);
    t.ef = round6(es + t.duration);
    t.rank = rank;
  };
  for (const t of order) visit(t);
  const finish = order.length ? Math.max(...order.map((t) => t.ef)) : 0;
  const back = new Set<string>();
  const visitBack = (t: ScheduleTaskModel) => {
    if (back.has(t.key)) return;
    back.add(t.key);
    let lf = finish;
    for (const s of succs(t.key)) {
      const next = byKey.get(s) as ScheduleTaskModel;
      visitBack(next);
      lf = Math.min(lf, next.ls);
    }
    t.lf = round6(lf);
    t.ls = round6(lf - t.duration);
    t.tf = round6(t.ls - t.es);
    t.critical = t.tf === 0;
  };
  for (const t of order) visitBack(t);
  const critical = (k: string): boolean => (byKey.get(k) as ScheduleTaskModel).critical;
  const model: ScheduleLinkModel[] = kept.map(([a, b]) => ({
    from: a,
    to: b,
    critical:
      critical(a) &&
      critical(b) &&
      (byKey.get(a) as ScheduleTaskModel).ef === (byKey.get(b) as ScheduleTaskModel).es,
  }));
  const disconnected =
    order.length > 1 && order.some((t) => !preds(t.key).length && !succs(t.key).length);
  if (disconnected)
    problems.push("ScheduleNetwork has a task with no links. Link it, or draw it elsewhere.");
  return {
    tasks: order,
    links: model,
    unit,
    finish: round6(finish),
    path: order
      .filter((t) => t.critical)
      .sort((a, b) => a.es - b.es)
      .map((t) => t.key),
    problems,
  };
}

// ── ScheduleNetwork layout ──

export const NET = { boxW: 168, boxH: 124, gapX: 48, gapY: 28, pad: 12, port: 14 } as const;

export interface NetBox {
  task: ScheduleTaskModel;
  x: number;
  y: number;
}

export interface NetLink {
  link: ScheduleLinkModel;
  /** Absolute orthogonal route, as an SVG path. */
  d: string;
  /** The arrow tip. */
  tip: { x: number; y: number };
}

export interface NetLayout {
  boxes: NetBox[];
  links: NetLink[];
  width: number;
  height: number;
}

const f1 = (n: number): number => Math.round(n * 10) / 10;

/** Ranks left to right, tasks of a rank stacked in list order; links leave a box's right edge and enter the next's left. */
export function layoutSchedule(model: ScheduleModel): NetLayout {
  const { boxW, boxH, gapX, gapY, pad, port } = NET;
  const perRank = new Map<number, number>();
  const boxes: NetBox[] = model.tasks.map((task) => {
    const row = perRank.get(task.rank) ?? 0;
    perRank.set(task.rank, row + 1);
    return { task, x: pad + task.rank * (boxW + gapX), y: pad + row * (boxH + gapY) };
  });
  const byKey = new Map(boxes.map((b) => [b.task.key, b]));
  const ranks = boxes.length ? Math.max(...boxes.map((b) => b.task.rank)) + 1 : 0;
  const rows = Math.max(0, ...perRank.values());
  const bottom = pad + rows * boxH + Math.max(0, rows - 1) * gapY;
  // Fan the ports along the box edge, ordered by where the other end is.
  const portY = (b: NetBox, index: number, count: number): number =>
    count === 1 ? b.y + boxH / 2 : b.y + port + ((boxH - 2 * port) * index) / (count - 1);
  const outs = new Map<string, ScheduleLinkModel[]>();
  const ins = new Map<string, ScheduleLinkModel[]>();
  for (const l of model.links) {
    outs.set(l.from, [...(outs.get(l.from) ?? []), l]);
    ins.set(l.to, [...(ins.get(l.to) ?? []), l]);
  }
  const yOf = (k: string): number => (byKey.get(k) as NetBox).y;
  for (const list of outs.values()) list.sort((a, b) => yOf(a.to) - yOf(b.to));
  for (const list of ins.values()) list.sort((a, b) => yOf(a.from) - yOf(b.from));
  let channels = 0;
  const links: NetLink[] = model.links.map((l, i) => {
    const s = byKey.get(l.from) as NetBox;
    const t = byKey.get(l.to) as NetBox;
    const out = outs.get(l.from) as ScheduleLinkModel[];
    const inn = ins.get(l.to) as ScheduleLinkModel[];
    const sx = s.x + boxW;
    const sy = portY(s, out.indexOf(l), out.length);
    const tx = t.x;
    const ty = portY(t, inn.indexOf(l), inn.length);
    const lead = 10 + (i % 4) * 8;
    let d: string;
    if (t.task.rank - s.task.rank > 1) {
      // Skips a rank: run under every box, so no route crosses one.
      const yc = bottom + 14 + channels++ * 8;
      d = `M${f1(sx)},${f1(sy)}H${f1(sx + lead)}V${f1(yc)}H${f1(tx - lead)}V${f1(ty)}H${f1(tx - 8)}`;
    } else {
      const bx = tx - gapX + 14 + (i % 4) * 8;
      d =
        sy === ty
          ? `M${f1(sx)},${f1(sy)}H${f1(tx - 8)}`
          : `M${f1(sx)},${f1(sy)}H${f1(bx)}V${f1(ty)}H${f1(tx - 8)}`;
    }
    return { link: l, d, tip: { x: tx, y: ty } };
  });
  return {
    boxes,
    links,
    width: pad * 2 + ranks * boxW + Math.max(0, ranks - 1) * gapX,
    height: bottom + pad + (channels ? 14 + channels * 8 : 0),
  };
}
