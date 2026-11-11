// @ts-check
// `check --render`: render the page in headless Chrome and report, as text, what only
// rendering shows: render errors (unknown components, Mermaid syntax, components that
// throw), uncaught exceptions, and statements that make the page scroll sideways.
// No screenshot. Opt-in: the reviewer judges how a page looks; this is for when the
// user asks for a check, or no review tab is open to report render errors.
//
// The page is exported (runtime and packs inlined, so no network) and framed by a small
// harness that speaks the review bridge, the way the review chrome frames it. Chrome is
// driven over the DevTools protocol with Node's WebSocket, so no browser library ships.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { exportHtml } from "./export.js";

const WIDTHS = [1280, 390];
const LAUNCH_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 30_000;

/** CHROME_PATH, else the first Chrome, Chromium or Edge found in the usual places. */
export function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  /** @type {string[]} */
  let candidates = [];
  if (process.platform === "darwin") {
    candidates = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].map(
      (p) => path.join("/Applications", p),
    );
  } else if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((x) => typeof x === "string");
    for (const r of roots) candidates.push(path.join(r, "Google/Chrome/Application/chrome.exe"), path.join(r, "Microsoft/Edge/Application/msedge.exe"));
  } else {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      for (const d of dirs) candidates.push(path.join(d, name));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

// The harness frames the page and answers its bridge as the review chrome does. Same origin as
// the page, so it can also measure the page's layout.
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<iframe id="f" src="/page.html" style="border:0;width:${WIDTHS[0]}px;height:900px"></iframe>
<script>
const errors = [];
let ready = false;
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.austere !== 1) return;
  if (d.type === "hello") e.source.postMessage({ austere: 1, type: "init", mode: "explore", scrollY: 0 }, "*");
  else if (d.type === "ready") ready = true;
  else if (d.type === "errors") for (const x of d.errors || []) errors.push({ statement: x.statementId || "", error: String(x.message || "") });
  else if (d.type === "runtime-error" && d.error) errors.push({ statement: d.error.statementId || "", error: String(d.error.message || "") });
});
window.__austereReport = async (widths) => {
  const f = document.getElementById("f");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 150 && !ready; i++) await sleep(100);
  const doc = () => f.contentDocument;
  // Mermaid renders after the page: wait until each diagram drew or failed.
  for (let i = 0; i < 100; i++) {
    const pending = [...doc().querySelectorAll(".austere-mermaid")].filter((m) => !m.querySelector("svg, .austere-render-error"));
    if (!pending.length) break;
    await sleep(100);
  }
  await sleep(200);
  // Failures the page shows but did not report over the bridge.
  for (const el of doc().querySelectorAll(".austere-render-error")) {
    const statement = el.closest("[data-oui-id]")?.getAttribute("data-oui-id") || "";
    if (!errors.some((x) => x.statement === statement)) errors.push({ statement, error: el.textContent.trim().slice(0, 300) });
  }
  const overflow = [];
  for (const w of widths) {
    f.style.width = w + "px";
    await sleep(300);
    const d = doc();
    const se = d.scrollingElement;
    if (se.scrollWidth <= se.clientWidth + 1) continue;
    const vw = se.clientWidth;
    const view = d.defaultView;
    // Past the right edge and not inside a box that clips or scrolls it (a wide table in its own scroller is fine).
    const sticksOut = (el) => {
      if (el.getBoundingClientRect().right <= vw + 1) return false;
      for (let a = el.parentElement; a && a !== d.body; a = a.parentElement) {
        if (view.getComputedStyle(a).overflowX !== "visible" && a.getBoundingClientRect().right <= vw + 1) return false;
      }
      return true;
    };
    // Statement wrappers have no box of their own (display: contents), so find the innermost elements that
    // stick out and name the statement around each.
    const out = [...d.body.querySelectorAll("*")].slice(0, 20000).filter(sticksOut);
    const outSet = new Set(out);
    const leaves = out.filter((el) => ![...el.children].some((c) => outSet.has(c)));
    const ids = leaves.map((el) => el.closest("[data-oui-id]")?.getAttribute("data-oui-id")).filter(Boolean);
    overflow.push({ width: w, statements: [...new Set(ids)].slice(0, 8) });
  }
  return {
    rendered: ready,
    statements: new Set([...doc().querySelectorAll("[data-oui-id]")].map((el) => el.getAttribute("data-oui-id"))).size,
    errors,
    overflow,
  };
};
</script></body></html>`;

/**
 * A DevTools protocol connection over the browser's WebSocket.
 * @param {string} url
 */
function connect(url) {
  const ws = new WebSocket(url);
  let next = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  /** @type {((m: any) => void)[]} */
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    const p = m.id != null ? pending.get(m.id) : undefined;
    if (p) {
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else for (const fn of listeners) fn(m);
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(undefined);
    ws.onerror = () => reject(new Error("could not connect to Chrome's DevTools endpoint"));
  });
  return {
    opened,
    /** @param {string} method @param {Record<string, any>} [params] @param {string} [sessionId] @returns {Promise<any>} */
    send(method, params = {}, sessionId) {
      const id = ++next;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    /** @param {(m: any) => void} fn */
    on(fn) {
      listeners.push(fn);
    },
    close() {
      ws.close();
    },
  };
}

/**
 * Starts Chrome headless and resolves with its DevTools WebSocket url.
 * @param {string} bin
 * @param {string} profile
 */
function launch(bin, profile) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-breakpad",
    "--disable-sync",
    "--disable-dev-shm-usage",
    // Without these, Chrome waits about 25 s for a desktop keyring (Linux) or keychain (macOS) that may never answer.
    "--password-store=basic",
    "--use-mock-keychain",
    "--mute-audio",
    "--window-size=1400,1000",
  ];
  // Chrome refuses to run as root with its sandbox (containers, CI).
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  args.push("about:blank");
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const endpoint = new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start within ${LAUNCH_TIMEOUT_MS / 1000} s`)), LAUNCH_TIMEOUT_MS);
    child.stderr?.on("data", (c) => {
      err += c;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}): ${err.trim().split("\n").pop() || "no output"}`));
    });
  });
  return { child, endpoint: /** @type {Promise<string>} */ (endpoint) };
}

/**
 * Serves the harness and the exported page on an ephemeral loopback port.
 * @param {string} page
 * @returns {Promise<{ url: string, close: () => void }>}
 */
function serve(page) {
  const server = http.createServer((req, res) => {
    const body = req.url === "/" ? HARNESS : req.url === "/page.html" ? page : null;
    if (body == null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${addr.port}/`, close: () => server.close() });
    });
  });
}

/**
 * @typedef {{ statement: string, error: string }} RenderError
 * @typedef {{ status: "ok", statements: number, errors: RenderError[], overflow: { width: number, statements: string[] }[], notices: string[] }
 *   | { status: "unavailable", reason: string }} RenderReport
 */

/**
 * Render the page headlessly and report what only rendering shows.
 * @param {string} html the artifact file's contents
 * @returns {Promise<RenderReport>}
 */
export async function renderCheck(html) {
  const bin = findChrome();
  if (!bin) {
    const reason = process.env.CHROME_PATH ? `CHROME_PATH does not exist: ${process.env.CHROME_PATH}` : "no Chrome, Chromium or Edge found; install one or set CHROME_PATH";
    return { status: "unavailable", reason };
  }
  const { html: page, notices } = exportHtml(html);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "austere-render-"));
  const site = await serve(page);
  const { child, endpoint } = launch(bin, profile);
  /** @type {ReturnType<typeof connect> | null} */
  let cdp = null;
  let timer;
  try {
    const run = (async () => {
      cdp = connect(await endpoint);
      await cdp.opened;
      /** @type {RenderError[]} */
      const exceptions = [];
      cdp.on((m) => {
        if (m.method !== "Runtime.exceptionThrown") return;
        const d = m.params.exceptionDetails;
        const text = String(d.exception?.description || d.text || "exception").split("\n")[0];
        exceptions.push({ statement: "", error: text.slice(0, 300) });
      });
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      const loaded = new Promise((resolve) => cdp?.on((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId && resolve(undefined)));
      await cdp.send("Page.navigate", { url: site.url }, sessionId);
      await loaded;
      const r = await cdp.send(
        "Runtime.evaluate",
        { expression: `window.__austereReport(${JSON.stringify(WIDTHS)})`, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (r.exceptionDetails) throw new Error(`render report failed: ${r.exceptionDetails.text}`);
      const report = r.result.value;
      if (!report.rendered && !report.errors.length) report.errors.push({ statement: "", error: "the page did not finish rendering" });
      const errors = [...report.errors, ...exceptions.filter((x) => !report.errors.some((e) => e.error === x.error))];
      return /** @type {RenderReport} */ ({ status: "ok", statements: report.statements, errors, overflow: report.overflow, notices });
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`rendering took longer than ${RENDER_TIMEOUT_MS / 1000} s`)), RENDER_TIMEOUT_MS);
    });
    return await Promise.race([run, timeout]);
  } catch (err) {
    return { status: "unavailable", reason: String(/** @type {Error} */ (err).message || err) };
  } finally {
    clearTimeout(timer);
    const exited = new Promise((r) => (child.exitCode != null ? r(undefined) : child.once("exit", () => r(undefined))));
    // Browser.close lets Chrome stop its helper processes, which keep writing to the profile after a kill.
    // Chrome exits before it answers, so wait for the exit.
    /** @type {any} */ (cdp)?.send("Browser.close").catch(() => {});
    let grace;
    await Promise.race([exited, new Promise((r) => (grace = setTimeout(r, 3000)))]);
    clearTimeout(grace);
    /** @type {any} */ (cdp)?.close();
    if (child.exitCode == null) child.kill();
    site.close();
    await exited;
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // A helper may still hold a file in it; the OS cleans its temp dir.
    }
  }
}
