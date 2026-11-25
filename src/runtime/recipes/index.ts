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
import databaseSchema from "./DatabaseSchema.md";
import { ARCHITECTURE_RECIPES } from "./architecture.ts";

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
  {
    name: "DatabaseSchema",
    group: "Diagrams",
    family: "Data model",
    description:
      "Physical tables with SQL types, key marks and foreign keys with their delete rules, drawn with ERDiagram: one Entity for each table.",
    uses: ["ERDiagram", "Entity", "Relation"],
    keywords: [
      "database schema",
      "db schema",
      "tables",
      "columns",
      "sql",
      "foreign key",
      "primary key",
      "migration",
      "ddl",
      "postgres",
      "on delete cascade",
    ],
    guide: databaseSchema,
    examples: [
      `blog = ERDiagram([dbUsers, dbPosts], [dbAuthor])
dbUsers = Entity("users", ["id uuid pk", "email text unique nn"])
dbPosts = Entity("posts", ["id uuid pk", "author_id uuid fk users.id", "title text nn"])
dbAuthor = Relation(dbUsers, dbPosts, "1:N", "posts.author_id → users.id, on delete cascade")`,
      `orders = ERDiagram([dbCustomers, dbOrders, dbItems, dbProducts], [dbPlaced, dbHolds, dbOfProduct])
dbCustomers = Entity("public.customers", ["id uuid pk", "email text unique nn", "created_at timestamptz nn"])
dbOrders = Entity("public.orders", ["id uuid pk", "customer_id uuid fk customers.id index", "status text nn", "total numeric(12,2) nn", "placed_at timestamptz index"])
dbItems = Entity("public.order_items", ["order_id uuid pk fk orders.id", "line int pk", "product_id uuid fk products.id", "quantity int nn"], "danger")
dbProducts = Entity("public.products", ["id uuid pk", "sku text unique nn", "price_cents int nn"])
dbPlaced = Relation(dbCustomers, dbOrders, "1:N", "orders.customer_id → customers.id, on delete restrict")
dbHolds = Relation(dbOrders, dbItems, "1:N", "order_items.order_id → orders.id, on delete cascade")
dbOfProduct = Relation(dbProducts, dbItems, "1:N", "order_items.product_id → products.id, on delete restrict")`,
    ],
  },
  ...ARCHITECTURE_RECIPES,
];
