import React from "react";
import { z } from "zod";
import { tagSchemaId } from "@openuidev/react-lang";
import type { RendererArgs } from "../../../types/pack.d.ts";
import { austereComponent } from "../define.ts";
import { FlowView } from "./_flow-view.tsx";
import { FLOW_DIRECTIONS, NODE_TONES } from "./_flow-model.ts";
import type { FlowInput } from "./_flow-model.ts";
import { TREE } from "./_tree-model.ts";
import guide from "./Tree.md";

const nothing = () => null;

// A TreeNode names its parent, which is another TreeNode: the schema has to
// point at itself, so the reference is made by name before the part exists.
const treeNodeRef = z.any();
tagSchemaId(treeNodeRef, "TreeNode");

function TreeView({ props, statementId }: RendererArgs<FlowInput>) {
  return <FlowView props={props} statementId={statementId} kind={TREE} />;
}

export const TreeNode = austereComponent({
  name: "TreeNode",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    parent: treeNodeRef.optional(),
    detail: z.string().optional(),
    tone: z.enum(NODE_TONES).optional(),
  }),
  description:
    "A node in a Tree. parent: the TreeNode above it (pass its name; leave it out for the root). detail is a monospace line under the label. tone tints it (strong = the one node to notice, danger = a risk). Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Tree = austereComponent({
  name: "Tree",
  group: "Diagrams",
  tier: "extended",
  family: "Hierarchy",
  keywords: [
    "tree",
    "hierarchy",
    "taxonomy",
    "breakdown",
    "work breakdown",
    "decomposition",
    "parent child",
    "root",
    "branches",
    "categories",
    "skill tree",
    "dependency tree",
    "outline",
  ],
  guide,
  props: z.object({
    nodes: z.array(TreeNode.definition.ref),
    direction: z.enum(FLOW_DIRECTIONS).optional(),
  }),
  description:
    "A hierarchy laid out automatically: one root, children below (or beside) it. Each TreeNode names its parent; there are no links to write. Each TreeNode is its own click target. direction: auto (default), down or right.",
  renderer: TreeView,
  example: [
    `skillTree = Tree([skRoot, skWeb, skApi, skDb, skCache])
skRoot = TreeNode("Platform skills")
skWeb = TreeNode("Web", skRoot)
skApi = TreeNode("API", skRoot)
skDb = TreeNode("Postgres", skApi)
skCache = TreeNode("Redis", skApi)`,
    `errorTree = Tree([erRoot, erClient, erServer, erBad, erGone, erTimeout, erPool, erDeploy], "down")
erRoot = TreeNode("Failed checkouts, last 24h", null, "412 requests", "strong")
erClient = TreeNode("4xx from the client", erRoot, "31%")
erServer = TreeNode("5xx from our servers", erRoot, "69%")
erBad = TreeNode("400 bad cart", erClient)
erGone = TreeNode("404 stale link", erClient)
erTimeout = TreeNode("504 payment timeout", erServer, "p99 11s", "danger")
erPool = TreeNode("DB pool exhausted", erTimeout)
erDeploy = TreeNode("Slow after deploy 2.14", erTimeout)`,
  ],
  stress: [
    `stressTree = Tree([trRoot, trA, trB, trC, trD, trE, trF, trG, trDeep, trDeeper, trGhostKid, trGhost])
trRoot = TreeNode("ENTERPRISE_ACCOUNT_HIERARCHY_WITH_A_VERY_LONG_UNBROKEN_ROOT_NAME", null, "a-very-long-unbroken-detail-token-that-must-be-cut.example.internal")
trA = TreeNode("Child with a long human readable name that wraps over two lines and then some more", trRoot, "line one\\nline two\\nline three that is cut")
trB = TreeNode("支払いの確認", trRoot, "東京リージョン")
trC = TreeNode("📦 Ship it", trRoot, "", "danger")
trD = TreeNode("d", trRoot, "", "strong")
trE = TreeNode("e", trRoot)
trF = TreeNode("f", trRoot)
trG = TreeNode("g", trA)
trDeep = TreeNode("Deep", trG)
trDeeper = TreeNode("Deeper", trDeep)
trGhostKid = TreeNode("Child of a second root", trGhost)
trGhost = TreeNode("Ghost")`,
    `stressWideTree = Tree([wtRoot, wtOne, wtTwo, wtThree], "right")
wtRoot = TreeNode("Root")
wtOne = TreeNode("One with a name long enough to need two lines in its box", wtRoot, "detail")
wtTwo = TreeNode("Two", wtRoot)
wtThree = TreeNode("Three", wtTwo)`,
  ],
});

export default [Tree, TreeNode];
