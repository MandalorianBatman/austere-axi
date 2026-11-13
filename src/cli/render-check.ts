// `check --render`: render the page in headless Chrome and report, as text, what only
// rendering shows: render errors (unknown components, components that throw), uncaught
// exceptions and statements that make the page scroll sideways.
// No screenshot. Opt-in: the reviewer judges how a page looks; this is for when the
// user asks for a check.
//
// The page is exported (runtime and packs inlined, so no network) and framed, sandboxed
// with an opaque origin as in the review page, by a small harness that speaks the review
// bridge. Pack code therefore runs only in a sandboxed frame. A measuring script appended
// to the exported page answers the harness over postMessage. Chrome is driven over the
// DevTools protocol with Node's WebSocket, so no browser library ships.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { exportHtml } from "./export.ts";

const WIDTHS = [1280, 390];
const LAUNCH_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 30_000;
const FRAME_SANDBOX = "allow-scripts";

export interface RenderError {
  statement: string;
  error: string;
}
export interface Overflow {
  width: number;
  statements: string[];
}
export type RenderReport =
  | { status: "ok"; statements: number; errors: RenderError[]; overflow: Overflow[]; notices: string[] }
  | { status: "unavailable"; reason: string };

/** CHROME_PATH, else the first Chrome, Chromium or Edge found in the usual places. */
export function findChrome(): string | null {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    for (const p of ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]) {
      candidates.push(path.join("/Applications", p));
    }
  } else if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((x): x is string => typeof x === "string");
    for (const r of roots) candidates.push(path.join(r, "Google/Chrome/Application/chrome.exe"), path.join(r, "Microsoft/Edge/Application/msedge.exe"));
  } else {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      for (const d of dirs) candidates.push(path.join(d, name));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

// Appended to the exported page. It runs in the sandboxed frame and, when the harness asks,
// reports render errors shown on the page, uncaught exceptions and the statements past the
// right edge at the frame's current width. Inactive tabs are not mounted, so it opens each
// tab in turn, measures again, and then restores the tabs that were open.
const MEASURE = `<script>(() => {
  const exceptions = [];
  addEventListener("error", (e) => exceptions.push(String((e.error && e.error.message) || e.message || "error")));
  addEventListener("unhandledrejection", (e) => exceptions.push(String((e.reason && e.reason.message) || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idOf = (el) => (el.closest("[data-oui-id]") && el.closest("[data-oui-id]").getAttribute("data-oui-id")) || "";
  const snapshot = () => {
    const shown = [...document.querySelectorAll(".austere-render-error")].map((el) => ({ statement: idOf(el), error: el.textContent.trim().slice(0, 300) }));
    const se = document.scrollingElement;
    let past = null;
    if (se.scrollWidth > se.clientWidth + 1) {
      const vw = se.clientWidth;
      // Past the right edge and not inside a box that clips or scrolls it (a wide table in its own scroller is fine).
      const sticksOut = (el) => {
        if (el.getBoundingClientRect().right <= vw + 1) return false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          if (getComputedStyle(a).overflowX !== "visible" && a.getBoundingClientRect().right <= vw + 1) return false;
        }
        return true;
      };
      // Statement wrappers have no box of their own (display: contents), so find the innermost
      // elements that stick out and name the statement around each.
      const out = [...document.body.querySelectorAll("*")].slice(0, 20000).filter(sticksOut);
      const outSet = new Set(out);
      const leaves = out.filter((el) => ![...el.children].some((c) => outSet.has(c)));
      past = leaves.map(idOf).filter(Boolean);
    }
    const ids = [...document.querySelectorAll("[data-oui-id]")].map((el) => el.getAttribute("data-oui-id"));
    return { shown, past, ids };
  };
  // Radix tabs switch on mousedown with the main button.
  const press = (tab) => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  // Opens every tab under \`scope\` (the page, or an open tab panel), measuring each, then walks
  // the tabs inside each panel while it is open: an inner Tabs mounts only with its panel.
  // Restores each tab list's open tab. Capped so a huge page cannot stall the check.
  let presses = 0;
  const walk = async (scope, snaps) => {
    const lists = [...scope.querySelectorAll('[role="tablist"]')].filter((l) => (l.parentElement.closest('[role="tabpanel"]') || document) === scope);
    for (const list of lists) {
      const count = list.querySelectorAll('[role="tab"]').length;
      const opened = [...list.querySelectorAll('[role="tab"]')].findIndex((t) => t.getAttribute("aria-selected") === "true");
      for (let i = 0; i < count && presses < 200; i++) {
        const tab = list.querySelectorAll('[role="tab"]')[i];
        if (!tab) break;
        if (tab.getAttribute("aria-selected") !== "true") {
          press(tab);
          presses++;
          await sleep(200);
          snaps.push(snapshot());
        }
        const panel = document.getElementById(tab.getAttribute("aria-controls") || "");
        if (panel) await walk(panel, snaps);
      }
      const back = list.querySelectorAll('[role="tab"]')[opened];
      if (back && back.getAttribute("aria-selected") !== "true") press(back);
    }
  };
  addEventListener("message", async (e) => {
    const d = e.data;
    if (e.source !== parent || !d || d.austereMeasure !== 1) return;
    await sleep(200);
    presses = 0;
    const snaps = [snapshot()];
    await walk(document, snaps);
    const overflowed = snaps.filter((x) => x.past);
    const past = overflowed.length ? [...new Set(overflowed.flatMap((x) => x.past))].slice(0, 8) : null;
    const shown = [];
    for (const s of snaps.flatMap((x) => x.shown)) if (!shown.some((y) => y.statement === s.statement && y.error === s.error)) shown.push(s);
    const statements = new Set(snaps.flatMap((x) => x.ids)).size;
    parent.postMessage({ austereMeasured: 1, id: d.id, shown, exceptions: exceptions.slice(0, 20), past, statements }, "*");
  });
})();</script>`;

// The harness frames the page and answers its bridge as the review chrome does.
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<iframe id="f" sandbox="${FRAME_SANDBOX}" src="/page.html" style="border:0;width:${WIDTHS[0]}px;height:900px"></iframe>
<script>
const f = document.getElementById("f");
const errors = [];
const answers = new Map();
let ready = false;
addEventListener("message", (e) => {
  const d = e.data;
  if (e.source !== f.contentWindow || !d) return;
  if (d.austereMeasured === 1) return answers.get(d.id)?.(d);
  if (d.austere !== 1) return;
  if (d.type === "hello") f.contentWindow.postMessage({ austere: 1, type: "init", mode: "explore", scrollY: 0 }, "*");
  else if (d.type === "ready") ready = true;
  else if (d.type === "errors") for (const x of d.errors || []) errors.push({ statement: String(x.statementId || ""), error: String(x.message || "") });
  else if (d.type === "runtime-error" && d.error) errors.push({ statement: String(d.error.statementId || ""), error: String(d.error.message || "") });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let next = 0;
const measure = () => new Promise((resolve) => {
  const id = ++next;
  answers.set(id, resolve);
  f.contentWindow.postMessage({ austereMeasure: 1, id }, "*");
});
window.__austereReport = async (widths) => {
  for (let i = 0; i < 150 && !ready; i++) await sleep(100);
  const overflow = [];
  let last = null;
  for (const w of widths) {
    f.style.width = w + "px";
    await sleep(300);
    last = await measure();
    if (last.past) overflow.push({ width: w, statements: last.past });
  }
  const all = [...errors];
  for (const s of last.shown) if (!all.some((x) => x.statement === s.statement)) all.push(s);
  for (const x of last.exceptions) if (!all.some((y) => y.error === x)) all.push({ statement: "", error: x.slice(0, 300) });
  return { rendered: ready, statements: last.statements, errors: all, overflow };
};
</script></body></html>`;

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

/** A DevTools protocol connection over the browser's WebSocket. */
interface Cdp {
  opened: Promise<void>;
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(fn: (m: CdpMessage) => void): void;
  close(): void;
}

function connect(url: string): Cdp {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners: ((m: CdpMessage) => void)[] = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as CdpMessage;
    const p = m.id != null ? pending.get(m.id) : undefined;
    if (p && m.id != null) {
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else for (const fn of listeners) fn(m);
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not connect to Chrome's DevTools endpoint"));
  });
  return {
    opened,
    send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      const id = ++next;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise<T>((resolve, reject) => pending.set(id, { resolve: (v) => resolve(v as T), reject }));
    },
    on(fn: (m: CdpMessage) => void): void {
      listeners.push(fn);
    },
    close(): void {
      ws.close();
    },
  };
}

/** Starts Chrome headless; `endpoint` resolves with its DevTools WebSocket url, `exited` once it is gone (or never started). */
function launch(bin: string, profile: string): { child: ChildProcess; endpoint: Promise<string>; exited: Promise<void> } {
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
  // A binary that cannot run emits "error" and never "exit"; either one means it is gone.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const endpoint = new Promise<string>((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start within ${LAUNCH_TIMEOUT_MS / 1000} s`)), LAUNCH_TIMEOUT_MS);
    child.stderr?.on("data", (c: Buffer) => {
      err += c;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}): ${err.trim().split("\n").pop() || "no output"}`));
    });
  });
  return { child, endpoint, exited };
}

/** Serves the harness and the exported page (with the frame's sandbox as CSP too) on an ephemeral loopback port. */
function serve(page: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(HARNESS);
    } else if (req.url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `sandbox ${FRAME_SANDBOX}` }).end(page);
    } else res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}/`, close: () => server.close() });
    });
  });
}

/** The exported page with the measuring script before </body> (or at the end). */
function withMeasure(html: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at < 0 ? html + MEASURE : html.slice(0, at) + MEASURE + html.slice(at);
}

interface HarnessReport {
  rendered: boolean;
  statements: number;
  errors: RenderError[];
  overflow: Overflow[];
}

/** Render the page headlessly and report what only rendering shows. */
export async function renderCheck(html: string, dir: string): Promise<RenderReport> {
  const bin = findChrome();
  if (!bin) {
    const reason = process.env.CHROME_PATH ? `CHROME_PATH does not exist: ${process.env.CHROME_PATH}` : "no Chrome, Chromium or Edge found; install one or set CHROME_PATH";
    return { status: "unavailable", reason };
  }
  const { html: page, notices } = exportHtml(html, dir);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "austere-render-"));
  const site = await serve(withMeasure(page));
  const { child, endpoint, exited } = launch(bin, profile);
  let cdp: Cdp | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = (async (): Promise<RenderReport> => {
      const conn = connect(await endpoint);
      cdp = conn;
      await conn.opened;
      const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await conn.send("Page.enable", {}, sessionId);
      const loaded = new Promise<void>((resolve) => conn.on((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId && resolve()));
      await conn.send("Page.navigate", { url: site.url }, sessionId);
      await loaded;
      const r = await conn.send<{ result: { value: HarnessReport }; exceptionDetails?: { text: string } }>(
        "Runtime.evaluate",
        { expression: `window.__austereReport(${JSON.stringify(WIDTHS)})`, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (r.exceptionDetails) throw new Error(`render report failed: ${r.exceptionDetails.text}`);
      const report = r.result.value;
      if (!report.rendered && !report.errors.length) report.errors.push({ statement: "", error: "the page did not finish rendering" });
      return { status: "ok", statements: report.statements, errors: report.errors, overflow: report.overflow, notices };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`rendering took longer than ${RENDER_TIMEOUT_MS / 1000} s`)), RENDER_TIMEOUT_MS);
    });
    return await Promise.race([run, timeout]);
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    const conn = cdp as Cdp | null;
    // Browser.close lets Chrome stop its helper processes, which keep writing to the profile after a kill.
    // Chrome exits before it answers, so wait for the exit.
    conn?.send("Browser.close").catch(() => {});
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>((r) => (grace = setTimeout(r, 3000)))]);
    clearTimeout(grace);
    conn?.close();
    if (child.exitCode == null && child.pid != null) child.kill();
    site.close();
    let killGrace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>((r) => (killGrace = setTimeout(r, 3000)))]);
    clearTimeout(killGrace);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // A helper may still hold a file in it; the OS cleans its temp dir.
    }
  }
}
