// npm run build && npm run demo [-- --out docs] [--keep]
//
// Records the review loop for the README, the site and launch posts:
//   an agent writes a page → the browser opens it → the reviewer clicks a table
//   cell and a diagram node, types a note on each, presses Send → the agent's
//   `poll` returns both, the agent `patch`es two statements → the page updates in
//   place and the changed statements flash.
//
// Everything on screen is the real thing: the real server, the real CLI
// (dist/cli.mjs) and the real review page driven by Playwright. The terminal pane
// is a small HTML terminal that prints what those CLI commands actually returned.
//
// Outputs (default docs/): demo.gif (< 5 MB), demo.mp4, demo.webm.
// Needs: Chrome or CHROME_PATH (as `npm run shot`), ffmpeg on PATH, `npm run build`.
// A run takes about a minute and does not touch ~/.austere-axi (state is a temp dir).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "./lib/browser.ts";
import { PAGE, PATCH } from "./lib/demo-page.ts";
import { ROOT } from "./lib/plugins.ts";
import type { Locator, Page } from "playwright-core";

// Globals the stage page defines (see STAGE); used inside page.evaluate callbacks.
declare global {
  interface Window {
    __mouse?: { x: number; y: number };
  }
  function openReview(url: string | undefined): void;
  function cursor(x: number, y: number, click?: boolean): void;
}

interface StageTerminal {
  type(text: string, cps?: number): Promise<void>;
  out(text: string, ms?: number): Promise<void>;
  raw(html: string, cls: string): Promise<void>;
  idle(): Promise<void>;
}

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, value("out", "docs"));
const W = 1440;
const H = 720;
const REVIEW_W = 1060; // above the 860px breakpoint: desktop layout, diagram laid out left to right
const FPS = 25;
const GIF_FPS = 12;
const GIF_WIDTH = 1080;
const MAX_GIF_BYTES = 5 * 1024 * 1024;

const CLI = path.join(ROOT, "dist", "cli.mjs");
for (const f of [CLI, path.join(ROOT, "dist", "austere.js"), path.join(ROOT, "dist", "chrome", "chrome.js")]) {
  if (!fs.existsSync(f)) {
    console.error(`${path.relative(ROOT, f)} is missing: run npm run build first`);
    process.exit(2);
  }
}
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
  console.error("ffmpeg is not on PATH (needed to encode the GIF, MP4 and WebM)");
  process.exit(2);
}

// ── The page the agent writes, and the two statements it patches in ────────────
const NOTES = [
  { target: { cell: "5 days" }, text: "5 days is too long: can it fit in 3?" },
  { target: { node: "pg" }, text: "Add a read replica for failover" },
];
const REPLY = "Effort is 3 days; Postgres now has a replica.";

// ── Isolated environment ────────────────────────────────────────────────────────
const free = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "austere-demo-"));
const WORK = path.join(TMP, "project");
fs.mkdirSync(WORK);
fs.writeFileSync(path.join(WORK, "plan.html"), PAGE);
const PORT = await free();
const ENV = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: path.join(TMP, "state"),
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  OPENUI_TELEMETRY_DISABLED: "1",
};
const cli = (cliArgs: string[], input?: string) => spawnSync(process.execPath, [CLI, ...cliArgs], { cwd: WORK, env: ENV, encoding: "utf8", input });
const startPoll = (extra: string[] = []) => {
  const child = spawn(process.execPath, [CLI, "poll", "plan.html", ...extra], { cwd: WORK, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise<string>((resolve) => {
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out));
  });
  return { child, done };
};
/**
 * Terminal text as the reader should see it. Nothing is rewritten: lines that do not fit
 * the pane are cut with an ellipsis, and the long hints (next:, source:, file paths,
 * the --no-open note) are left out so the notes stay readable.
 */
const SKIP = /^\s*(browser: not opened|next:|source:|file:|line:|excerpt:)/;
const tidy = (s: string): string =>
  s
    .split("\n")
    .filter((l) => l.trim() && !SKIP.test(l))
    .map((l) => (l.length > 50 ? `${l.slice(0, 49)}…` : l))
    .join("\n");

// ── The stage: a terminal on the right, the real review page on the left ────────
const STAGE = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${W}px;height:${H}px;background:#0b0b0d;overflow:hidden}
#review{position:absolute;left:0;top:0;width:${REVIEW_W}px;height:${H}px;border:0;background:#0c0c0c}
#idle{position:absolute;left:0;top:0;width:${REVIEW_W}px;height:${H}px;background:#0c0c0c;display:flex;align-items:center;justify-content:center;color:#5b5b66;font:15px system-ui,sans-serif}
#term{position:absolute;left:${REVIEW_W}px;top:0;width:${W - REVIEW_W}px;height:${H}px;background:#101014;border-left:1px solid #26262e;color:#d8d8e0;font:12.5px/18px ui-monospace,"DejaVu Sans Mono",Menlo,monospace;display:flex;flex-direction:column}
#bar{height:36px;flex:none;display:flex;align-items:center;gap:7px;padding:0 14px;border-bottom:1px solid #26262e;color:#7c7c88;font:12px system-ui,sans-serif}
#bar i{width:10px;height:10px;border-radius:50%;background:#2c2c36;display:block}
#screen{flex:1;padding:12px 14px;overflow:hidden;white-space:pre-wrap;word-break:break-all}
.dim{color:#74747f}.ok{color:#7ee2a0}.key{color:#8fb4ff}.agent{color:#c9a7ff}.p{color:#7ee2a0}.cmd{color:#fff}
.caret{display:inline-block;width:7px;height:14px;background:#d8d8e0;vertical-align:-2px;animation:b 1s steps(1) infinite}@keyframes b{50%{opacity:0}}
#cursor{position:absolute;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:9;transition:none;opacity:0}
#ring{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #8fb4ff;pointer-events:none;z-index:8;opacity:0}
</style>
<iframe id="review" src="about:blank"></iframe>
<div id="idle">waiting for a page…</div>
<div id="term"><div id="bar"><i></i><i></i><i></i><span style="margin-left:6px">agent terminal</span></div><div id="screen"></div></div>
<svg id="cursor" viewBox="0 0 22 22"><path d="M3 2l14 8-6 1.6L8 18z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>
<div id="ring"></div>
<script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const screen = document.getElementById("screen");
let cur = null;
function caret() { document.querySelectorAll(".caret").forEach((c) => c.remove()); if (cur) { const c = document.createElement("span"); c.className = "caret"; cur.append(c); } }
window.T = {
  line(html = "", cls = "") { cur = document.createElement("div"); cur.className = cls; cur.innerHTML = html || "&nbsp;"; screen.append(cur); this.trim(); caret(); },
  async type(text, cps = 38) { this.line('<span class="p">$</span> <span class="cmd"></span>'); const c = cur.querySelector(".cmd"); for (const ch of text) { c.textContent += ch; await sleep(1000 / cps); } },
  // A command's output: one line at a time, as plain text.
  async out(text, ms = 40) { for (const l of text.split("\\n")) { this.line(esc(l), "dim"); await sleep(ms); } },
  raw(html, cls) { this.line(html, cls); },
  trim() { while (screen.scrollHeight > screen.clientHeight + 1 && screen.firstChild) screen.firstChild.remove(); },
  idle() { cur = screen.lastChild; caret(); },
};
window.openReview = (url) => { document.getElementById("review").src = url; document.getElementById("idle").remove(); };
window.cursor = (x, y, click) => {
  const c = document.getElementById("cursor"), r = document.getElementById("ring");
  c.style.opacity = 1; c.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)";
  if (click) { r.style.left = x + "px"; r.style.top = y + "px"; r.style.opacity = 1; r.animate([{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 450 }); }
};
</script>`;

// ── Screencast: CDP frames with timestamps → constant-rate video via ffmpeg ─────
const frames: { t: number; data: Buffer }[] = [];
async function startRecording(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ t: f.metadata.timestamp!, data: Buffer.from(f.data, "base64") });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {});
  };
}

function encode(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const list: string[] = [];
  frames.forEach((f, i) => {
    const name = `f${String(i).padStart(5, "0")}.jpg`;
    fs.writeFileSync(path.join(dir, name), f.data);
    const dur = i + 1 < frames.length ? frames[i + 1].t - f.t : 1;
    list.push(`file '${name}'`, `duration ${Math.max(dur, 0.001).toFixed(4)}`);
  });
  list.push(`file 'f${String(frames.length - 1).padStart(5, "0")}.jpg'`); // concat needs the last file twice
  fs.writeFileSync(path.join(dir, "frames.txt"), list.join("\n") + "\n");
  const ff = (extra: string[], out: string) => {
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"), ...extra, out], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${path.basename(out)}: ${r.stderr}`);
  };
  fs.mkdirSync(OUT, { recursive: true });
  const base = `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`;
  ff(["-vf", base, "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-movflags", "+faststart", "-an"], path.join(OUT, "demo.mp4"));
  ff(["-vf", base, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-an"], path.join(OUT, "demo.webm"));
  // GIF: shared palette, bayer dither. Drop the frame rate / colours until it is under budget.
  const gif = path.join(OUT, "demo.gif");
  for (const [fps, colors] of [[GIF_FPS, 128], [10, 96], [8, 64]]) {
    const vf = `fps=${fps},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    ff(["-filter_complex", vf, "-loop", "0"], gif);
    if (fs.statSync(gif).size < MAX_GIF_BYTES) return;
  }
  throw new Error(`demo.gif is still ${fs.statSync(gif).size} bytes (limit ${MAX_GIF_BYTES})`);
}

// ── Run ─────────────────────────────────────────────────────────────────────────
const { browser, reason } = await launchBrowser();
if (!browser) {
  console.error(`Could not start a browser: ${reason}`);
  process.exit(2);
}
let exit = 0;
let poll: ReturnType<typeof startPoll> | undefined;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.setContent(STAGE);
  const stop = await startRecording(page);
  const pause = (ms: number) => page.waitForTimeout(ms);
  // Inside page.evaluate, T is the stage page's window.T (same methods).
  const T: StageTerminal = {
    type: (s, cps) => page.evaluate(([a, b]) => T.type(a, b), [s, cps] as const),
    out: (s, ms) => page.evaluate(([a, b]) => T.out(a, b), [s, ms] as const),
    raw: (h, c) => page.evaluate(([a, b]) => T.raw(a, b), [h, c] as const),
    idle: () => page.evaluate(() => T.idle()),
  };
  const review = page.frameLocator("#review");
  const artifact = review.frameLocator("iframe.frame");

  // 1. The agent writes the page.
  await pause(600);
  await T.raw("agent writes plan.html", "agent");
  await pause(500);
  const statements = PAGE.split("\n").filter((l) => /^\w+ = /.test(l));
  for (const l of statements) {
    const shown = l.length > 46 ? `${l.slice(0, 45)}…` : l;
    await T.raw(`<span class="key">${shown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/^(\w+)/, "$1</span>")}`, "dim");
    await pause(110);
  }
  await pause(900);

  // 2. It opens the page for review.
  await T.type("austere-axi plan.html");
  await pause(350);
  const opened = cli(["plan.html", "--no-open"]);
  if (opened.status !== 0) throw new Error(`austere-axi plan.html failed: ${opened.stdout}${opened.stderr}`);
  const url = /^url: (\S+)/m.exec(opened.stdout)?.[1];
  await T.out(tidy(opened.stdout));
  await page.evaluate((u) => openReview(u), url);
  await artifact.locator("[data-oui-id]").first().waitFor({ timeout: 20_000 });
  await artifact.locator(".austere-mermaid, [data-oui-id='pg']").first().waitFor();
  await pause(1200);

  // 3. The agent waits for feedback.
  await T.raw("", "");
  await T.type("austere-axi poll plan.html");
  poll = startPoll();
  await T.raw("waiting for the reviewer…", "dim");
  await T.idle();
  await pause(1000);

  // 4. The reviewer annotates a table cell and a diagram node, then sends.
  const moveTo = async (loc: Locator, { click = false, dy = 0 }: { click?: boolean; dy?: number } = {}) => {
    await loc.scrollIntoViewIfNeeded();
    const b = (await loc.boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2 + dy;
    const from = (await page.evaluate(() => window.__mouse)) || { x: W / 2, y: H / 2 };
    const steps = 22;
    for (let i = 1; i <= steps; i++) {
      const e = 1 - (1 - i / steps) ** 3;
      const px = from.x + (x - from.x) * e;
      const py = from.y + (y - from.y) * e;
      await page.mouse.move(px, py);
      await page.evaluate(([a, b]) => { window.__mouse = { x: a, y: b }; cursor(a, b); }, [px, py]);
      await pause(16);
    }
    await pause(250);
    if (click) {
      await page.evaluate(([a, b]) => cursor(a, b, true), [x, y]);
      await page.mouse.click(x, y);
    }
  };
    for (const note of NOTES) {
    const target = note.target.cell ? artifact.locator("td.openui-table-cell").filter({ hasText: note.target.cell }).first() : artifact.locator(`[data-oui-id="${note.target.node}"]`).first();
    await moveTo(target, { click: true });
    const box = artifact.locator(".austere-pop textarea");
    await box.waitFor({ timeout: 5000 });
    await pause(450);
    await box.pressSequentially(note.text, { delay: 42 });
    await pause(450);
    await box.press("Enter");
    await pause(900);
  }
  const send = review.locator(".composer .send");
  await moveTo(send);
  // The runtime hides its hover box on a document mouseleave, which a scripted pointer
  // does not always produce when it leaves the artifact frame.
  await artifact.locator("body").evaluate(() => document.dispatchEvent(new MouseEvent("mouseleave")));
  await moveTo(send, { click: true });
  const feedback = await poll.done;
  if (!/^status: feedback/m.test(feedback)) throw new Error(`poll did not return feedback:\n${feedback}`);
  for (const n of NOTES) if (!feedback.includes(n.text)) throw new Error(`poll is missing the note "${n.text}":\n${feedback}`);
  await pause(500);

  // 5. The agent reads the notes (the real poll output) and patches the two statements they name.
  await T.out(tidy(feedback), 70);
  await pause(2200);
  await T.raw("", "");
  await T.type("austere-axi patch plan.html <<'EOF'", 45);
  for (const l of PATCH.trimEnd().split("\n")) {
    const shown = l.length > 46 ? `${l.slice(0, 45)}…` : l;
    await T.raw(`<span class="key">${shown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/^(\w+)/, "$1</span>")}`, "dim");
    await pause(350);
  }
  await T.raw("EOF", "cmd");
  await pause(500);
  const patched = cli(["patch", "plan.html"], PATCH);
  if (!/^status: patched/m.test(patched.stdout)) throw new Error(`patch failed: ${patched.stdout}${patched.stderr}`);
  await T.out(tidy(patched.stdout));
  // The page updates in place; the changed statements flash for ~2.4 s.
  await artifact.locator(".austere-flash").first().waitFor({ timeout: 10_000 });
  await pause(2800);

  // 6. The agent replies and goes back to polling; the reply lands in the conversation.
  await T.raw("", "");
  await T.type(`austere-axi poll plan.html --agent-reply "${REPLY}"`, 60);
  poll = startPoll(["--agent-reply", REPLY]);
  await review.locator(".msg, .bubble, .reply").filter({ hasText: REPLY }).first().waitFor({ timeout: 10_000 }).catch(() => {});
  await pause(3200);

  await stop();
  if (problems.length) console.warn(`page errors:\n${problems.join("\n")}`);
  console.log(`captured ${frames.length} frames over ${(frames.at(-1)!.t - frames[0].t).toFixed(1)} s`);
  encode(path.join(TMP, "frames"));
  for (const f of ["demo.gif", "demo.mp4", "demo.webm"]) {
    console.log(`${path.relative(ROOT, path.join(OUT, f))}  ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`);
  }
} catch (err) {
  console.error((err as Error).stack || err);
  exit = 1;
} finally {
  poll?.child.kill();
  await browser.close();
  cli(["stop"]);
  if (flag("keep")) console.log(`kept ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(exit);
