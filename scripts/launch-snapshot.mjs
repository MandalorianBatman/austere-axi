// node scripts/launch-snapshot.mjs [--label before-hn] [--out docs/launch/metrics.csv]
//
// Appends one row of public reach numbers to a CSV, so launch results can be
// compared before and after each post: GitHub stars, forks, watchers and open
// issues; npm downloads (last day, week, month) for austere-axi and the example
// pack; and, when a token with push access is available, GitHub traffic for the
// last 14 days (views, unique visitors, clones, unique cloners) plus the top
// referrer. Token: GITHUB_TOKEN, GH_TOKEN, or `gh auth token`. Without one the
// traffic columns stay empty.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "MandalorianBatman/austere-axi";
const PACKAGES = ["austere-axi", "austere-pack-gantt"];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const label = flag("label", "");
const out = path.resolve(ROOT, flag("out", "docs/launch/metrics.csv"));

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const auth = token();

async function github(route) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "austere-axi-launch-snapshot" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}${route}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${route || "/"}: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Downloads for one period; 0 for a package that is not published yet. */
async function npmDownloads(pkg, period) {
  const res = await fetch(`https://api.npmjs.org/downloads/point/${period}/${pkg}`);
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`npm ${pkg} ${period}: ${res.status} ${res.statusText}`);
  return (await res.json()).downloads;
}

/** Traffic needs push access; anything else leaves the columns empty. */
async function traffic() {
  if (!auth) return { views: "", visitors: "", clones: "", cloners: "", referrer: "" };
  try {
    const [views, clones, referrers] = await Promise.all([
      github("/traffic/views"),
      github("/traffic/clones"),
      github("/traffic/popular/referrers"),
    ]);
    const top = referrers[0];
    return {
      views: views.count,
      visitors: views.uniques,
      clones: clones.count,
      cloners: clones.uniques,
      referrer: top ? `${top.referrer} (${top.uniques})` : "",
    };
  } catch (err) {
    console.error(`traffic skipped: ${err.message}`);
    return { views: "", visitors: "", clones: "", cloners: "", referrer: "" };
  }
}

const repo = await github("");
const t = await traffic();
const row = {
  time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  label,
  stars: repo.stargazers_count,
  forks: repo.forks_count,
  watchers: repo.subscribers_count,
  open_issues: repo.open_issues_count,
};
for (const pkg of PACKAGES) {
  for (const period of ["last-day", "last-week", "last-month"]) {
    row[`${pkg}_${period.replace("last-", "")}`] = await npmDownloads(pkg, period);
  }
}
Object.assign(row, {
  views_14d: t.views,
  visitors_14d: t.visitors,
  clones_14d: t.clones,
  cloners_14d: t.cloners,
  top_referrer: t.referrer,
});

const csv = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const header = Object.keys(row).join(",");
if (fs.existsSync(out)) {
  const existing = fs.readFileSync(out, "utf8").split("\n")[0];
  if (existing !== header) throw new Error(`${path.relative(ROOT, out)} has different columns; move it aside or pass --out`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, header + "\n");
}
fs.appendFileSync(out, Object.values(row).map(csv).join(",") + "\n");

for (const [k, v] of Object.entries(row)) console.log(`${k}: ${v}`);
console.log(`appended to ${path.relative(ROOT, out)}`);
