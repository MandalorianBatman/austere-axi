import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { GIT_MAX_LANES, buildGitGraph } from "./_plan-model.ts";
import type { GitCommitModel } from "./_plan-model.ts";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./GitGraph.md";

const nothing = () => null;

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and the next one together.
const T = ({
  children,
  ...rest
}: React.SVGProps<SVGTextElement> & { children?: React.ReactNode }) => (
  <text {...rest}>{children} </text>
);

export const GitCommit = austereComponent({
  name: "GitCommit",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    message: z.string(),
    lane: z.string(),
    branchFrom: z.string().optional(),
    mergeFrom: z.string().optional(),
    tag: z.string().optional(),
    focus: z.boolean().optional(),
  }),
  description:
    "One commit in a GitGraph, in time order. lane is one of its lanes. branchFrom (on the first commit of a lane): the lane it is cut from. mergeFrom: the lane whose latest commit it merges (a merge commit). tag labels it (v1.2.0). focus marks the hotfix or release. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

const G = { labelW: 112, pitch: 76, lanePitch: 60, top: 68, bottom: 52, dot: 8, ring: 12 } as const;

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** At most two lines of `max` characters, cut at spaces where there is one. */
function wrap(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const at = text.lastIndexOf(" ", max);
  if (at < 3) return [cut(text, max)];
  return [text.slice(0, at), cut(text.slice(at + 1), max)];
}

const px = (column: number): number => G.labelW + G.pitch / 2 + column * G.pitch;
const py = (lane: number): number => G.top + lane * G.lanePitch;

function CommitView({ c, down, up }: { c: GitCommitModel; down: boolean; up: boolean }) {
  const x = px(c.column);
  const y = py(c.lane);
  const merge = c.merged !== null;
  // Name the merge, the focal commits and the tagged ones; the rest are on click.
  const lines = merge || c.focal || c.tag ? wrap(c.message, 12) : [];
  // A connector runs down or up from this dot: the label goes on the free side.
  const above = down && !up && lines.length > 0;
  const lift = above ? lines.length * 13 : 0;
  const tagW = c.tag ? Math.min(G.pitch - 8, c.tag.length * 7 + 14) : 0;
  return (
    <g
      className={`dg-gg-commit${merge ? " is-merge" : ""}${c.focal ? " is-focal" : ""}`}
      data-oui-id={c.named ? c.id : undefined}
      data-oui-c={c.named ? "GitCommit" : undefined}
    >
      <title>{[c.message, c.tag && `tag ${c.tag}`].filter(Boolean).join(" · ")}</title>
      <g data-austere-part={c.message}>
        <circle className="dg-gg-hit" cx={x} cy={y} r={G.ring + 6} />
        {merge ? <circle className="dg-gg-ring" cx={x} cy={y} r={G.ring} /> : null}
        {c.focal && !merge ? (
          <circle className="dg-gg-ring is-focal" cx={x} cy={y} r={G.ring} />
        ) : null}
        <circle className="dg-gg-dot" cx={x} cy={y} r={G.dot} />
        {c.tag ? (
          <>
            <rect
              className="dg-gg-tag"
              x={x - tagW / 2}
              y={y - 42 - lift}
              width={tagW}
              height={20}
              rx={4}
            />
            <T className="dg-gg-tag-text" x={x} y={y - 28 - lift} textAnchor="middle">
              {cut(c.tag, Math.floor((tagW - 14) / 7))}
            </T>
          </>
        ) : null}
        {lines.map((line, i) => (
          <T
            key={i}
            className="dg-gg-label"
            x={x}
            y={above ? y - 20 - (lines.length - 1 - i) * 13 : y + 26 + i * 13}
            textAnchor="middle"
          >
            {line}
          </T>
        ))}
      </g>
    </g>
  );
}

type GitGraphProps = { lanes?: unknown; commits?: unknown };

function GitGraphView({ props, statementId }: RendererArgs<GitGraphProps>) {
  const graph = React.useMemo(() => buildGitGraph(props), [props]);
  useProblems(graph.problems, "gitgraph", "GitGraph", statementId);
  return (
    <DiagramFrame className="dg-gitgraph" name="Git graph">
      {() => {
        if (!graph.commits.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>GitGraph has no commits.</strong> Pass the lane names, then the GitCommit
                statements in time order.
              </div>
            ),
          };
        }
        const width = G.labelW + graph.commits.length * G.pitch + 16;
        const height = G.top + (graph.lanes.length - 1) * G.lanePitch + G.bottom;
        // Which dots have a connector leaving them downward or upward.
        const runs = graph.commits.map(() => ({ up: false, down: false }));
        for (const c of graph.commits) {
          if (c.parent && c.parent.lane !== c.lane)
            runs[c.parent.column][c.lane > c.parent.lane ? "down" : "up"] = true;
          if (c.merged) runs[c.column][c.merged.lane > c.lane ? "down" : "up"] = true;
        }
        const reach = graph.lanes.map((_, lane) => {
          const cols = graph.commits.filter((c) => c.lane === lane).map((c) => c.column);
          return cols.length ? [Math.min(...cols), Math.max(...cols)] : null;
        });
        return {
          width,
          content: (
            <svg
              className="dg-gg-svg"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`Git graph: ${graph.lanes.join(", ")}; ${graph.commits.length} commits, left to right in time order`}
            >
              {graph.lanes.map((name, lane) => (
                <g key={lane} className="dg-gg-lane">
                  <title>{name}</title>
                  <T className="dg-gg-lane-name" x={8} y={py(lane) + 4}>
                    {cut(name, 14)}
                  </T>
                  {reach[lane] ? (
                    <line
                      className="dg-gg-rail"
                      x1={px(reach[lane][0])}
                      x2={px(reach[lane][1])}
                      y1={py(lane)}
                      y2={py(lane)}
                    />
                  ) : null}
                </g>
              ))}
              {graph.commits.map((c) => {
                const x = px(c.column);
                const y = py(c.lane);
                return (
                  <g key={`p${c.column}`} className="dg-gg-links">
                    {c.parent && c.parent.lane !== c.lane ? (
                      // Branch-off: down (or up) at the parent's column, then along the new lane.
                      <path
                        className="dg-gg-link"
                        d={`M${px(c.parent.column)},${py(c.parent.lane)}V${y}H${x}`}
                      />
                    ) : null}
                    {c.merged ? (
                      // Merge: along the source lane, then at the merge column to the commit.
                      <path
                        className="dg-gg-link"
                        d={`M${px(c.merged.column)},${py(c.merged.lane)}H${x}V${y}`}
                      />
                    ) : null}
                  </g>
                );
              })}
              {graph.commits.map((c) => (
                <CommitView
                  key={c.column}
                  c={c}
                  down={runs[c.column].down}
                  up={runs[c.column].up}
                />
              ))}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const GitGraph = austereComponent({
  name: "GitGraph",
  group: "Diagrams",
  tier: "extended",
  family: "Time and plan",
  keywords: [
    "git graph",
    "git history",
    "branching model",
    "branches",
    "merge",
    "release branch",
    "hotfix",
    "backport",
    "rebase",
    "gitflow",
    "trunk based",
    "commit history",
    "tag",
  ],
  guide,
  limits: [
    {
      prop: "lanes",
      max: GIT_MAX_LANES,
      message: "GitGraph: 5 lanes at most. More is two diagrams.",
    },
    {
      prop: "commits",
      max: 16,
      message: "GitGraph: 16 commits at most. Draw an overview, then a zoom.",
    },
  ],
  props: z.object({
    lanes: z.array(z.string()),
    commits: z.array(GitCommit.definition.ref),
  }),
  description:
    "Branches as lanes (names, main first) and GitCommits in time order, one column each: branch-offs, merges with two parents, tags. Write no coordinates. Each commit is a click target.",
  renderer: GitGraphView,
  example: [
    `release = GitGraph(["main", "feat/billing", "release/1.2"], [gc0, gc1, gc2, gcMerge, gc3, gcCut, gcFix, gcShip])
gc0 = GitCommit("Initial import", "main")
gc1 = GitCommit("Add invoice model", "feat/billing", "main")
gc2 = GitCommit("Invoice PDF", "feat/billing")
gcMerge = GitCommit("Merge billing", "main", null, "feat/billing")
gc3 = GitCommit("Bump deps", "main")
gcCut = GitCommit("Cut release", "release/1.2", "main")
gcFix = GitCommit("Hotfix rounding", "release/1.2", null, null, null, true)
gcShip = GitCommit("Release 1.2.0", "release/1.2", null, null, "v1.2.0", true)`,
    `trunk = GitGraph(["main", "fix/login"], [tkA, tkB, tkFix, tkMerge])
tkA = GitCommit("Ship search", "main")
tkB = GitCommit("Start login fix", "fix/login", "main")
tkFix = GitCommit("Fix redirect loop", "fix/login")
tkMerge = GitCommit("Merge login fix", "main", null, "fix/login", "v2.4.1", true)`,
  ],
  stress: [
    `stressGit = GitGraph(["main", "A_LANE_NAME_THAT_HAS_NO_BREAKS_AND_RUNS_ON", "支払い/東京", "d", "e"], [gxA, gxB, gxC, gxD, gxE, gxF, gxG, gxH, gxI, gxJ, gxK, gxL, gxM, gxN, gxO, gxP])
gxA = GitCommit("A_COMMIT_MESSAGE_WITH_NO_BREAKS_AT_ALL_THAT_MUST_BE_CUT", "main", null, null, "A_TAG_WITH_NO_BREAKS_AT_ALL", true)
gxB = GitCommit("Branch off", "A_LANE_NAME_THAT_HAS_NO_BREAKS_AND_RUNS_ON", "main")
gxC = GitCommit("東京リージョンの切り替え", "支払い/東京", "main")
gxD = GitCommit("Third lane", "d", "支払い/東京")
gxE = GitCommit("Fourth lane", "e", "main")
gxF = GitCommit("Back on main", "main", null, "e")
gxG = GitCommit("Merge the third lane in", "main", null, "d", "v1")
gxH = GitCommit("Long lane again", "A_LANE_NAME_THAT_HAS_NO_BREAKS_AND_RUNS_ON")
gxI = GitCommit("Merge the long lane", "main", null, "A_LANE_NAME_THAT_HAS_NO_BREAKS_AND_RUNS_ON", "v2", true)
gxJ = GitCommit("Two", "d")
gxK = GitCommit("Three", "e")
gxL = GitCommit("Four", "d")
gxM = GitCommit("Five", "e")
gxN = GitCommit("Six", "main")
gxO = GitCommit("Seven", "main")
gxP = GitCommit("Eight", "main")`,
  ],
});

export default [GitGraph, GitCommit];
