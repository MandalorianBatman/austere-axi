// Recipes: diagram types an existing component draws well, so they get no
// component of their own. Each is a catalog entry (`components list|show|search`
// find it) with a guide in the adjacent .md file and two examples that write
// the components in `uses`. A recipe name is never a component name; `check`
// answers a page that calls one with the components to write. Never in `spec`.
import type { Recipe } from "../../../types/catalog.d.ts";
import swimlane from "./Swimlane.md";
import barComparison from "./BarComparison.md";
import lineTrend from "./LineTrend.md";
import scatterPlot from "./ScatterPlot.md";

export const RECIPES: Recipe[] = [
  {
    name: "Swimlane",
    group: "Diagrams",
    family: "Flow",
    description:
      "Cross-team process with handoffs: Architecture with lanes, one Group for each actor and one Node for each step.",
    uses: ["Architecture", "Node", "Edge", "Group"],
    keywords: ["swim lane", "lanes", "handoff", "cross-functional", "raci", "who does what"],
    guide: swimlane,
    examples: [
      `release = Architecture([write, review, merge], [toReview, toMerge], [devLane, reviewLane], "lanes")
write = Node("Write the change")
review = Node("Review")
merge = Node("Merge and deploy", null, null, null, "strong")
toReview = Edge(write, review, "pull request")
toMerge = Edge(review, merge, "approved")
devLane = Group("Author", [write], "plain")
reviewLane = Group("Reviewers", [review, merge], "plain")`,
      `vendorOnboarding = Architecture([request, securityReview, legalReview, contract, provision, firstInvoice], [toSecurity, toLegal, toContract, toProvision, toInvoice, sendBack], [requesterLane, securityLane, legalLane, financeLane], "lanes")
request = Node("Request vendor", null, "form in the portal")
securityReview = Node("Security review", null, "questionnaire + SOC 2")
legalReview = Node("Legal review", null, "DPA, terms")
contract = Node("Sign contract", null, null, null, "strong")
provision = Node("Provision access", null, "SSO group")
firstInvoice = Node("First invoice", null, "net 30")
toSecurity = Edge(request, securityReview, "ticket")
toLegal = Edge(securityReview, legalReview, "approved", "emphasis")
toContract = Edge(legalReview, contract)
toProvision = Edge(contract, provision, "signed")
toInvoice = Edge(contract, firstInvoice, "PO number", "dashed")
sendBack = Edge(securityReview, request, "missing answers", "dashed", "danger")
requesterLane = Group("REQUESTER", [request], "plain")
securityLane = Group("Security", [securityReview, provision])
legalLane = Group("Legal", [legalReview, contract])
financeLane = Group("Finance", [firstInvoice])`,
    ],
  },
  {
    name: "BarComparison",
    group: "Diagrams",
    family: "Quantity",
    description: "One value compared across up to 8 categories or periods, drawn with BarChart.",
    uses: ["BarChart", "Series"],
    keywords: ["bar chart", "bar", "column chart", "histogram", "compare", "ranking"],
    guide: barComparison,
    examples: [
      `costByService = BarChart(["API", "Workers", "Search"], [Series("USD / month", [1200, 860, 430])])`,
      `velocity = BarChart(["S41", "S42", "S43", "S44", "S45", "S46"], [Series("Planned", [34, 30, 36, 32, 38, 35]), Series("Done", [29, 31, 27, 33, 36, 34])], "grouped", "Sprint", "Points")`,
    ],
  },
  {
    name: "LineTrend",
    group: "Diagrams",
    family: "Quantity",
    description: "A value over time or releases, one line for each series, drawn with LineChart.",
    uses: ["LineChart", "Series"],
    keywords: ["line chart", "line", "trend", "over time", "time series", "growth"],
    guide: lineTrend,
    examples: [
      `signups = LineChart(["W1", "W2", "W3", "W4"], [Series("Sign-ups", [120, 180, 175, 240])])`,
      `latencyByRelease = LineChart(["1.8", "1.9", "1.10", "1.11", "1.12", "1.13", "1.14", "1.15"], [Series("p50", [82, 80, 85, 79, 77, 76, 74, 73]), Series("p99", [410, 395, 520, 480, 330, 310, 300, 290])], "linear", "Release", "ms")`,
    ],
  },
  {
    name: "ScatterPlot",
    group: "Diagrams",
    family: "Quantity",
    description:
      "Two quantities against each other across many items, for clusters and outliers, drawn with ScatterChart.",
    uses: ["ScatterChart", "ScatterSeries", "Point"],
    keywords: ["scatter", "correlation", "distribution", "outlier", "x y plot", "bubble"],
    guide: scatterPlot,
    examples: [
      `effortImpact = ScatterChart([ScatterSeries("Ideas", [Point(2, 8), Point(5, 6), Point(8, 3), Point(3, 3)])], "Effort (days)", "Impact (1-10)")`,
      `payloadLatency = ScatterChart([ScatterSeries("eu-west", [Point(12, 80), Point(40, 95), Point(85, 140), Point(120, 160), Point(200, 230), Point(260, 250)]), ScatterSeries("us-east", [Point(15, 60), Point(50, 72), Point(90, 110), Point(150, 150), Point(210, 390)])], "Payload (KB)", "Latency (ms)")`,
    ],
  },
];
