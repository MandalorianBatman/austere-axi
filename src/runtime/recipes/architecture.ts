// Recipes drawn with Architecture (stage 11): each is a lane, group or tone
// convention on Node, Edge and Group, not a component. Guides sit in the
// adjacent .md files. Added to RECIPES in index.ts.
import type { Recipe } from "../../../types/catalog.d.ts";
import architectureDelta from "./ArchitectureDelta.md";
import itCurrentState from "./ITCurrentState.md";
import highLevel from "./HighLevel.md";
import processMap from "./ProcessMap.md";
import medallion from "./Medallion.md";
import dataFlow from "./DataFlow.md";
import dpIntegration from "./DPIntegration.md";
import deployment from "./Deployment.md";
import dependencyGraph from "./DependencyGraph.md";
import sbgn from "./SBGN.md";

const USES = ["Architecture", "Node", "Edge", "Group"];

export const ARCHITECTURE_RECIPES: Recipe[] = [
  {
    name: "ArchitectureDelta",
    group: "Diagrams",
    family: "Architecture",
    description:
      "What changes between two states of a system: Architecture with a tone and a tag for added, changed and removed.",
    uses: USES,
    keywords: [
      "architecture delta",
      "before and after",
      "migration",
      "redesign",
      "service extraction",
      "diff",
      "what changed",
      "as-is to-be",
    ],
    guide: architectureDelta,
    examples: [
      `dbSwap = Architecture([dsApp, dsOld, dsNew], [dsReadOld, dsReadNew])
dsApp = Node("App", "backend", null, "changed", "warning")
dsOld = Node("MySQL 5.7", "database", null, "removed", "danger")
dsNew = Node("Postgres 16", "database", null, "added", "success")
dsReadOld = Edge(dsApp, dsOld, "SQL", "dashed", "danger")
dsReadNew = Edge(dsApp, dsNew, "SQL", null, "success")`,
      `extraction = Architecture([exWeb, exApi, exBilling, exQueue, exLedger, exOldTable], [exToApi, exToBilling, exOld, exPublish, exWrite, exOldRead], [exBoundary])
exWeb = Node("Web app", "frontend")
exApi = Node("Orders API", "backend", "Node :8080", "changed", "warning")
exBilling = Node("Billing service", "backend", "Go :9090", "added", "success")
exQueue = Node("order.placed", "messagebus", "SQS", "added", "success")
exLedger = Node("Ledger", "database", "Postgres", "added", "success")
exOldTable = Node("billing tables", "database", "in the orders DB", "removed", "danger")
exToApi = Edge(exWeb, exApi, "POST /orders")
exToBilling = Edge(exQueue, exBilling, "consume", null, "success")
exPublish = Edge(exApi, exQueue, "publish", null, "success")
exWrite = Edge(exBilling, exLedger, "append", null, "success")
exOld = Edge(exApi, exOldTable, "insert", "dashed", "danger")
exOldRead = Edge(exOldTable, exBilling, "backfill once", "dashed", "info")
exBoundary = Group("billing-service repo", [exBilling, exLedger])`,
    ],
  },
  {
    name: "ITCurrentState",
    group: "Diagrams",
    family: "Architecture",
    description:
      "The legacy IT landscape by phase or department, with manual hand-offs and pain points flagged: Architecture with lanes.",
    uses: USES,
    keywords: [
      "current state",
      "as-is",
      "legacy",
      "pain points",
      "silos",
      "manual hand-off",
      "modernization",
      "it landscape",
    ],
    guide: itCurrentState,
    examples: [
      `landscape = Architecture([csForm, csDrive, csReport], [csExport, csPaste], [csCollect, csProcess, csPublish], "lanes")
csForm = Node("Field form", "frontend")
csDrive = Node("Shared drive", "database", "no version control", "manual", "danger")
csReport = Node("Monthly report", "external", "Word + Excel")
csExport = Edge(csForm, csDrive, "CSV")
csPaste = Edge(csDrive, csReport, "copy", "dashed")
csCollect = Group("COLLECTION", [csForm], "plain")
csProcess = Group("PROCESSING", [csDrive], "plain")
csPublish = Group("DISSEMINATION", [csReport], "plain")`,
      `statsOffice = Architecture([itSurvey, itRegistry, itScripts, itDrive, itExcel, itAnalyst, itPortal, itPdf], [itToDrive, itFromRegistry, itRun, itOut, itPivot, itPost, itMail], [itCollection, itProcessing, itDissemination], "lanes")
itSurvey = Node("Survey Solutions", "frontend", "CAPI · PostgreSQL")
itRegistry = Node("Civil registry", "external", "extract on request")
itScripts = Node("R scripts", "backend", "on one laptop", "no backup", "danger")
itDrive = Node("Shared drive", "database", "Windows file share", "manual", "warning")
itExcel = Node("Excel workbooks", "backend", "macros, 40 tabs", "manual", "warning")
itAnalyst = Node("Analyst desk", "frontend", "SPSS · Excel")
itPortal = Node("Web portal", "cloud", "static pages")
itPdf = Node("PDF bulletin", "external", "email list")
itToDrive = Edge(itSurvey, itDrive, "CSV")
itFromRegistry = Edge(itRegistry, itDrive, "email", "dashed")
itRun = Edge(itDrive, itScripts, "copy")
itOut = Edge(itScripts, itExcel, "Excel", null, "danger")
itPivot = Edge(itExcel, itAnalyst, "Excel")
itPost = Edge(itAnalyst, itPortal, "upload")
itMail = Edge(itAnalyst, itPdf, "email", "dashed")
itCollection = Group("COLLECTION", [itSurvey, itRegistry], "plain")
itProcessing = Group("PROCESSING", [itDrive, itScripts, itExcel], "plain")
itDissemination = Group("DISSEMINATION", [itAnalyst, itPortal, itPdf], "plain")`,
    ],
  },
  {
    name: "HighLevel",
    group: "Diagrams",
    family: "Architecture",
    description:
      "End-to-end overview of a data stack on a cluster, from sources to dashboards: Architecture with a boundary Group and a phase tag on each node.",
    uses: USES,
    keywords: [
      "high level",
      "overview",
      "data stack",
      "data platform",
      "kubernetes",
      "ingestion",
      "analytics",
      "big picture",
    ],
    guide: highLevel,
    examples: [
      `stack = Architecture([hlSource, hlIngest, hlStore, hlDash], [hlPull, hlLoad, hlServe], [hlCluster])
hlSource = Node("Postgres", "database", null, "source", null)
hlIngest = Node("Ingest job", "backend", "Airbyte", "ingest")
hlStore = Node("Warehouse", "database", "ClickHouse", "store", "strong")
hlDash = Node("Dashboards", "frontend", "Grafana", "visualize")
hlPull = Edge(hlSource, hlIngest, "JDBC")
hlLoad = Edge(hlIngest, hlStore, "batch")
hlServe = Edge(hlStore, hlDash, "SQL")
hlCluster = Group("Kubernetes cluster", [hlIngest, hlStore, hlDash], "region")`,
      `analyticsStack = Architecture([hsDb, hsNifi, hsMinio, hsTrino, hsDbt, hsBi, hsNotebook, hsAirflow, hsAuth], [hsDbIn, hsRaw, hsQuery, hsModel, hsDashboards, hsNotebooks, hsSchedule, hsLogin], [hsCluster, hsSecurity])
hsDb = Node("Operational DBs", "database", "MariaDB · Postgres", "source", "info")
hsNifi = Node("NiFi", "backend", "flow-based ETL", "ingest")
hsMinio = Node("MinIO", "database", "S3 · Iceberg", "store", "strong")
hsTrino = Node("Trino", "backend", "federated SQL", "query")
hsDbt = Node("dbt", "backend", "models + tests", "transform")
hsBi = Node("Superset", "frontend", "dashboards", "visualize")
hsNotebook = Node("JupyterHub", "frontend", "Python · R", "analyze")
hsAirflow = Node("Airflow", "backend", "DAG scheduler", "orchestrate")
hsAuth = Node("Keycloak", "security", "SSO · RBAC", "identity")
hsDbIn = Edge(hsDb, hsNifi, "JDBC")
hsRaw = Edge(hsNifi, hsMinio, "raw write")
hsQuery = Edge(hsTrino, hsMinio, "read")
hsModel = Edge(hsDbt, hsTrino, "SQL")
hsDashboards = Edge(hsBi, hsTrino, "SQL")
hsNotebooks = Edge(hsNotebook, hsTrino, "SQL")
hsSchedule = Edge(hsAirflow, hsDbt, "triggers", "dashed")
hsLogin = Edge(hsAuth, hsBi, "OIDC", "security")
hsCluster = Group("Kubernetes cluster", [hsNifi, hsMinio, hsTrino, hsDbt, hsBi, hsNotebook, hsAirflow, hsAuth], "region")
hsSecurity = Group("Identity", [hsAuth], "security")`,
    ],
  },
  {
    name: "ProcessMap",
    group: "Diagrams",
    family: "Flow",
    description:
      "A cross-division process with the tool at each step and the data that passes between them: Architecture with lanes by actor.",
    uses: USES,
    keywords: [
      "process",
      "business process",
      "workflow",
      "who does what",
      "responsibility",
      "handoff map",
      "data quality gate",
      "inputs and outputs",
    ],
    guide: processMap,
    examples: [
      `intake = Architecture([pmFill, pmCheck, pmApprove], [pmSend, pmPass], [pmRequester, pmOps], "lanes")
pmFill = Node("Fill form", null, "web portal")
pmCheck = Node("Check data", null, "SQL rules")
pmApprove = Node("Approve", null, null, null, "strong")
pmSend = Edge(pmFill, pmCheck, "form")
pmPass = Edge(pmCheck, pmApprove, "clean rows")
pmRequester = Group("Requester", [pmFill], "plain")
pmOps = Group("Operations", [pmCheck, pmApprove], "plain")`,
      `surveyRun = Architecture([prDesign, prBuild, prTest, prCollect, prClean, prPublish], [prSpec, prApp, prTestOk, prFix, prRaw, prTables], [prResearch, prIt, prField, prSurvey], "lanes")
prDesign = Node("Design survey", null, "Excel · CSPro")
prBuild = Node("Build app", null, "CSPro · scripts")
prTest = Node("Test pilot", null, "tablets", null, "warning")
prCollect = Node("Collect", null, "CAPI on tablets")
prClean = Node("Clean data", null, "R · SQL checks", null, "strong")
prPublish = Node("Publish tables", null, "portal")
prSpec = Edge(prDesign, prBuild, "questionnaire")
prApp = Edge(prBuild, prTest, "app build")
prTestOk = Edge(prTest, prCollect, "approved")
prFix = Edge(prTest, prBuild, "defects", "dashed", "danger")
prRaw = Edge(prCollect, prClean, "CSV")
prTables = Edge(prClean, prPublish, "tables")
prResearch = Group("RD&E", [prDesign], "plain")
prIt = Group("IT", [prBuild, prTest], "plain")
prField = Group("Field services", [prCollect], "plain")
prSurvey = Group("Survey services", [prClean, prPublish], "plain")`,
    ],
  },
  {
    name: "Medallion",
    group: "Diagrams",
    family: "Architecture",
    description:
      "Storage in tiers (raw, cleaned, curated, archive) with format and writer for each, and how data is promoted: Architecture with a lane for each tier.",
    uses: USES,
    keywords: [
      "medallion",
      "bronze silver gold",
      "data lake",
      "lakehouse",
      "tiers",
      "raw staging curated",
      "buckets",
      "promotion",
    ],
    guide: medallion,
    examples: [
      `lake = Architecture([mdRaw, mdClean, mdGold], [mdPromote, mdAggregate], [mdRawTier, mdCleanTier, mdGoldTier], "lanes")
mdRaw = Node("raw-bucket", "database", "CSV · JSON")
mdClean = Node("clean-bucket", "database", "Iceberg")
mdGold = Node("gold-bucket", "database", "Iceberg", null, "strong")
mdPromote = Edge(mdRaw, mdClean, "dedupe")
mdAggregate = Edge(mdClean, mdGold, "aggregate")
mdRawTier = Group("Raw", [mdRaw], "plain")
mdCleanTier = Group("Cleaned", [mdClean], "plain")
mdGoldTier = Group("Curated", [mdGold], "plain")`,
      `surveyLake = Architecture([mlRaw, mlClean, mlAgg, mlIndicators, mlArchive], [mlHash, mlRoll, mlPublish, mlCold], [mlRawTier, mlCleanTier, mlAggTier, mlArchiveTier], "lanes")
mlRaw = Node("raw-bucket", "database", "CSV · JSON\nData engineer", "PII", "danger")
mlClean = Node("clean-bucket", "database", "Iceberg · cleaned\nTrino INSERT", null, "warning")
mlAgg = Node("aggregated-bucket", "database", "Iceberg\nTrino INSERT", null, "strong")
mlIndicators = Node("indicators", "cloud", "SAS JDBC · BI")
mlArchive = Node("archive-bucket", "database", "Parquet\nlifecycle rule", "cold")
mlHash = Edge(mlRaw, mlClean, "drop names")
mlRoll = Edge(mlClean, mlAgg, "aggregate")
mlPublish = Edge(mlAgg, mlIndicators, "read")
mlCold = Edge(mlRaw, mlArchive, "after 90 days", "dashed")
mlRawTier = Group("Raw", [mlRaw], "plain")
mlCleanTier = Group("Cleaned", [mlClean], "plain")
mlAggTier = Group("Aggregated", [mlAgg, mlIndicators], "plain")
mlArchiveTier = Group("Archive", [mlArchive], "plain")`,
    ],
  },
  {
    name: "DataFlow",
    group: "Diagrams",
    family: "Flow",
    description:
      "How data moves through a pipeline across roles, with the tool at each stage and the payload on each hand-off: Architecture with lanes by role.",
    uses: USES,
    keywords: [
      "data flow",
      "dataflow",
      "lineage",
      "data lineage",
      "pipeline",
      "etl",
      "provenance",
      "who processes the data",
    ],
    guide: dataFlow,
    examples: [
      `pipeline = Architecture([dfIngest, dfModel, dfReport], [dfRaw, dfTables], [dfEngineers, dfAnalysts], "lanes")
dfIngest = Node("Ingest", null, "NiFi")
dfModel = Node("Model", null, "dbt")
dfReport = Node("Report", null, "Superset", null, "strong")
dfRaw = Edge(dfIngest, dfModel, "raw files")
dfTables = Edge(dfModel, dfReport, "tables")
dfEngineers = Group("Engineers", [dfIngest], "plain")
dfAnalysts = Group("Analysts", [dfModel, dfReport], "plain")`,
      `platformFlow = Architecture([flSetup, flAccess, flIngest, flStore, flTransform, flAnalyze, flPublish, flRead], [flGrant, flPolicy, flLand, flRaw, flTables, flReport, flOpen, flIssue], [flAdmins, flEngineers, flScientists, flConsumers], "lanes")
flSetup = Node("Project setup", null, "console")
flAccess = Node("Access control", null, "LDAP · bucket policies", null, "warning")
flIngest = Node("Source ingest", null, "NiFi · API · SFTP")
flStore = Node("Raw store", null, "MinIO")
flTransform = Node("Transform", null, "Trino · dbt")
flAnalyze = Node("Analyze", null, "JupyterLab", null, "strong")
flPublish = Node("Publish", null, "Superset")
flRead = Node("Read reports", null, "browser")
flGrant = Edge(flSetup, flAccess, "roles")
flPolicy = Edge(flAccess, flStore, "policies", "dashed", "warning")
flLand = Edge(flIngest, flStore, "web, DB, files")
flRaw = Edge(flStore, flTransform, "raw files")
flTables = Edge(flTransform, flAnalyze, "tables")
flReport = Edge(flAnalyze, flPublish, "models")
flOpen = Edge(flPublish, flRead, "dashboards")
flIssue = Edge(flSetup, flIngest, "credentials", "dashed")
flAdmins = Group("Admins", [flSetup, flAccess], "plain")
flEngineers = Group("Engineers", [flIngest, flStore, flTransform], "plain")
flScientists = Group("Scientists", [flAnalyze, flPublish], "plain")
flConsumers = Group("Consumers", [flRead], "plain")`,
    ],
  },
  {
    name: "DPIntegration",
    group: "Diagrams",
    family: "Architecture",
    description:
      "The integration points of a data platform: the sources that plug in, the consumers that plug out, and the protocol of each: Architecture with three lanes.",
    uses: USES,
    keywords: [
      "dp integration",
      "data platform",
      "integration",
      "connectors",
      "protocols",
      "sources and consumers",
      "hub and spoke",
      "interfaces",
    ],
    guide: dpIntegration,
    examples: [
      `integrations = Architecture([dpDb, dpNifi, dpBi], [dpIn, dpOut], [dpSources, dpPlatform, dpConsumers], "lanes")
dpDb = Node("Databases", "database", "SQL")
dpNifi = Node("NiFi", "backend", null, null, "strong")
dpBi = Node("BI tools", "frontend")
dpIn = Edge(dpDb, dpNifi, "JDBC")
dpOut = Edge(dpNifi, dpBi, "ODBC")
dpSources = Group("SOURCES", [dpDb], "plain")
dpPlatform = Group("DATA PLATFORM", [dpNifi])
dpConsumers = Group("CONSUMERS", [dpBi], "plain")`,
      `platformEdges = Architecture([ipDb, ipSftp, ipMail, ipTrino, ipNifi, ipMinio, ipAirflow, ipDesktop, ipNotebook, ipApi], [ipJdbc, ipSftpIn, ipImap, ipFederate, ipStore, ipSchedule, ipOdbc, ipJupyter, ipRest], [ipSources, ipPlatform, ipConsumers], "lanes")
ipDb = Node("Databases", "database", "MariaDB · SQL")
ipSftp = Node("SFTP drops", "external", "scheduled pulls")
ipMail = Node("Email", "external", "IMAP attachments")
ipTrino = Node("Trino", "backend", "federated query", null, "strong", 1)
ipNifi = Node("Apache NiFi", "backend", "flow-based ETL", null, null, 2)
ipMinio = Node("MinIO", "database", "S3 · medallion", null, null, 3)
ipAirflow = Node("Airflow", "backend", "DAG triggers", null, null, 4)
ipDesktop = Node("Desktop apps", "frontend", "SPSS · SAS")
ipNotebook = Node("Notebooks", "frontend", "Python · R")
ipApi = Node("Partner apps", "cloud", "REST clients")
ipJdbc = Edge(ipDb, ipNifi, "JDBC")
ipSftpIn = Edge(ipSftp, ipNifi, "SFTP")
ipImap = Edge(ipMail, ipNifi, "IMAP")
ipFederate = Edge(ipDb, ipTrino, "federate", "dashed")
ipStore = Edge(ipNifi, ipMinio, "S3")
ipSchedule = Edge(ipAirflow, ipNifi, "trigger", "dashed")
ipOdbc = Edge(ipTrino, ipDesktop, "ODBC")
ipJupyter = Edge(ipTrino, ipNotebook, "Python client")
ipRest = Edge(ipTrino, ipApi, "REST")
ipSources = Group("SOURCES", [ipDb, ipSftp, ipMail], "plain")
ipPlatform = Group("DATA PLATFORM", [ipTrino, ipNifi, ipMinio, ipAirflow])
ipConsumers = Group("CONSUMERS", [ipDesktop, ipNotebook, ipApi], "plain")`,
    ],
  },
  {
    name: "Deployment",
    group: "Diagrams",
    family: "Architecture",
    description:
      "Where software runs: hosts, pods and managed services in zones, with replicas and versions: Architecture with nested Groups.",
    uses: USES,
    keywords: [
      "deployment",
      "infrastructure",
      "hosts",
      "pods",
      "replicas",
      "environments",
      "zones",
      "where it runs",
      "kubernetes",
      "network boundary",
    ],
    guide: deployment,
    examples: [
      `shipping = Architecture([dpCdn, dpApi, dpDb], [dpEdge, dpSql], [dpProd, dpCluster])
dpCdn = Node("CDN", "cloud", "static assets", "MANAGED")
dpApi = Node("api", "backend", "api:2.4.1 x3", "POD")
dpDb = Node("Postgres", "database", "16 · primary + replica", "MANAGED")
dpEdge = Edge(dpCdn, dpApi, "HTTPS")
dpSql = Edge(dpApi, dpDb, "SQL")
dpProd = Group("prod / eu-west-1", [dpApi, dpDb], "region")
dpCluster = Group("k8s cluster", [dpApi])`,
      `release = Architecture([dyUsers, dyCdn, dyGateway, dyWeb, dyApi, dyWorker, dyDb, dyQueue, dyObs], [dyHttps, dyAssets, dyRoute, dyCall, dyJobs, dyRead, dyConsume, dyMetrics], [dyEdge, dyProd, dyCluster, dyData])
dyUsers = Node("Users", "external")
dyCdn = Node("CDN", "cloud", "static assets", "MANAGED")
dyGateway = Node("Gateway", "security", "envoy:1.30 x2\nTLS :443", "VM", "info")
dyWeb = Node("web", "frontend", "web:5.1.0 x4\n:3000", "POD")
dyApi = Node("api", "backend", "api:2.4.1 x3\n:8080", "POD", "strong")
dyWorker = Node("worker", "backend", "worker:2.4.1 x2", "POD", "warning")
dyDb = Node("Postgres", "database", "16 · primary +\n1 replica", "MANAGED")
dyQueue = Node("SQS", "messagebus", "orders-queue", "MANAGED")
dyObs = Node("Grafana Cloud", "external", "metrics + logs", "MANAGED")
dyHttps = Edge(dyUsers, dyCdn, "HTTPS")
dyAssets = Edge(dyCdn, dyGateway, "origin", "emphasis")
dyRoute = Edge(dyGateway, dyWeb, "/")
dyCall = Edge(dyWeb, dyApi, "REST")
dyJobs = Edge(dyApi, dyQueue, "enqueue", "dashed")
dyRead = Edge(dyApi, dyDb, "SQL")
dyConsume = Edge(dyQueue, dyWorker, "poll", "dashed")
dyMetrics = Edge(dyWorker, dyObs, "OTLP", "dashed")
dyEdge = Group("edge", [dyCdn, dyGateway], "security")
dyProd = Group("prod / eu-west-1", [dyWeb, dyApi, dyWorker, dyDb, dyQueue], "region")
dyCluster = Group("k8s cluster", [dyWeb, dyApi, dyWorker])
dyData = Group("data zone", [dyDb, dyQueue])`,
    ],
  },
  {
    name: "DependencyGraph",
    group: "Diagrams",
    family: "Architecture",
    description:
      "What depends on what across packages, modules or services, with shared dependencies and a cycle visible: Architecture with a fan-in tag and a danger cycle.",
    uses: USES,
    keywords: [
      "dependency graph",
      "dependencies",
      "what depends on what",
      "depends on",
      "imports",
      "packages",
      "modules",
      "circular dependency",
      "cycle",
      "fan-in",
    ],
    guide: dependencyGraph,
    examples: [
      `deps = Architecture([dgApp, dgAuth, dgDb], [dgUsesAuth, dgUsesDb, dgAuthDb])
dgApp = Node("app")
dgAuth = Node("auth")
dgDb = Node("db", "database", null, "2 in", "strong")
dgUsesAuth = Edge(dgApp, dgAuth)
dgUsesDb = Edge(dgApp, dgDb)
dgAuthDb = Edge(dgAuth, dgDb)`,
      `monorepo = Architecture([pkWeb, pkApi, pkWorker, pkAuth, pkBilling, pkDb, pkLog, pkStripe], [pkWebApi, pkApiAuth, pkApiBilling, pkWorkerBilling, pkBillingDb, pkAuthDb, pkApiLog, pkWorkerLog, pkBillingStripe, pkAuthBilling, pkBillingAuth])
pkWeb = Node("web", "frontend", "apps/web")
pkApi = Node("api", "backend", "services/api")
pkWorker = Node("worker", "backend", "services/worker")
pkAuth = Node("auth", "backend", "packages/auth", "cycle", "danger")
pkBilling = Node("billing", "backend", "packages/billing", "cycle · 3 in", "danger")
pkDb = Node("db", "database", "packages/db", "2 in", "strong")
pkLog = Node("log", "backend", "packages/log", "2 in")
pkStripe = Node("stripe", "external", "npm", "3rd party")
pkWebApi = Edge(pkWeb, pkApi)
pkApiAuth = Edge(pkApi, pkAuth)
pkApiBilling = Edge(pkApi, pkBilling)
pkWorkerBilling = Edge(pkWorker, pkBilling)
pkBillingDb = Edge(pkBilling, pkDb)
pkAuthDb = Edge(pkAuth, pkDb)
pkApiLog = Edge(pkApi, pkLog)
pkWorkerLog = Edge(pkWorker, pkLog)
pkBillingStripe = Edge(pkBilling, pkStripe)
pkAuthBilling = Edge(pkAuth, pkBilling, "plan limits", null, "danger")
pkBillingAuth = Edge(pkBilling, pkAuth, "session lookup", "dashed", "danger")`,
    ],
  },
  {
    name: "SBGN",
    group: "Diagrams",
    family: "Architecture",
    description:
      "A biological process as species and reactions, with what each reaction consumes and produces: Architecture with tagged species and process nodes (no SBGN glyphs).",
    uses: USES,
    keywords: [
      "sbgn",
      "biochemical",
      "biological pathway",
      "pathway",
      "metabolic map",
      "reaction",
      "molecule",
      "enzyme",
      "signalling cascade",
      "systems biology",
    ],
    guide: sbgn,
    examples: [
      `cleavage = Architecture([sbCarotene, sbCleave, sbRetinal], [sbIn, sbOut], [sbCell])
sbCarotene = Node("beta-carotene", "database", null, "species")
sbCleave = Node("cleavage", "backend", null, "process", "strong")
sbRetinal = Node("retinal", "database", null, "species")
sbIn = Edge(sbCarotene, sbCleave, "consumed")
sbOut = Edge(sbCleave, sbRetinal, "produced")
sbCell = Group("cytosol", [sbCarotene, sbCleave, sbRetinal], "region")`,
      `retinoid = Architecture([rtCarotene, rtOxygen, rtCleave, rtRetinal, rtReduce, rtRetinol, rtBco, rtNadph], [rtUse, rtUseO2, rtMake, rtRetinalIn, rtMakeRetinol, rtCatalyse, rtCofactor], [rtCell])
rtCarotene = Node("beta-carotene", "database", null, "species", "info")
rtOxygen = Node("O2", "database", null, "species")
rtCleave = Node("v1 cleavage", "backend", null, "process", "strong")
rtRetinal = Node("retinal", "database", null, "species")
rtReduce = Node("v2 reduction", "backend", null, "process", "strong")
rtRetinol = Node("retinol", "database", null, "species")
rtBco = Node("BCO1", "cloud", "enzyme", "species")
rtNadph = Node("NADPH", "database", null, "species")
rtUse = Edge(rtCarotene, rtCleave, "consumed")
rtUseO2 = Edge(rtOxygen, rtCleave, "consumed")
rtMake = Edge(rtCleave, rtRetinal, "produced")
rtRetinalIn = Edge(rtRetinal, rtReduce, "consumed")
rtMakeRetinol = Edge(rtReduce, rtRetinol, "produced")
rtCatalyse = Edge(rtBco, rtCleave, "catalysis", "dashed", "success")
rtCofactor = Edge(rtNadph, rtReduce, "consumed")
rtCell = Group("cytosol", [rtCarotene, rtOxygen, rtCleave, rtRetinal, rtReduce, rtRetinol, rtBco, rtNadph], "region")`,
    ],
  },
];
