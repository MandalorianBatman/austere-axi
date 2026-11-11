// Scoring a page. Each tool is judged by its own validator, the one its agent is
// told to satisfy, plus one tool-neutral render check in headless Chrome.
//
//   austere-axi  `austere-axi check` (Node, no browser)
//   lavish-axi   what `lavish-axi <file>` reports on open (self_paint_warning) and the
//                layout audit lavish runs in the review page, at a desktop and a phone
//                viewport (its "Layout issues" inbox)
//   both         page errors, console errors, render errors and sideways scrolling at
//                1440 and 390 px wide
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "../../scripts/lib/browser.mjs";
import { statementLines } from "../../src/cli/check.js";
import { LAVISH_CLI, ROOT, STATE, lavishEnv, setLavishPort } from "./paths.mjs";

const AUSTERE_CLI = path.join(ROOT, "dist", "cli.mjs");
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

function node(args, { cwd, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile("node", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 << 20, timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    );
    if (input != null) child.stdin.end(input);
  });
}

const austereEnv = () => ({ AUSTERE_AXI_STATE_DIR: path.join(STATE, "austere"), AUSTERE_AXI_NO_OPEN: "1", AUSTERE_AXI_NO_TAILSCALE: "1" });

/** `austere-axi check`: ok, and the error codes it listed. */
export async function austereCheck(file) {
  const { code, out } = await node([AUSTERE_CLI, "check", file], { env: austereEnv() });
  const errors = [...out.matchAll(/^\s+- code: (\S+)/gm)].map((m) => m[1]);
  return { ok: code === 0, errors, output: out.slice(0, 4000) };
}

/** `austere-axi patch`, with the statements on stdin. */
export async function austerePatch(file, statements) {
  const { code, out } = await node([AUSTERE_CLI, "patch", file], { env: austereEnv(), input: statements });
  return { ok: code === 0 && /status: patched/.test(out), output: out.slice(0, 4000) };
}

/** The smallest statement whose source contains the anchor text: what austere-axi poll names. */
export function austereAnchor(html, anchorText) {
  const want = anchorText.toLowerCase();
  let best = null;
  for (const [id, s] of statementLines(html)) {
    if (!s.text.toLowerCase().includes(want)) continue;
    if (!best || s.text.length < best.source.length) best = { statement: id, line: s.line, source: s.text };
  }
  if (!best) {
    const root = statementLines(html).get("root");
    best = { statement: "root", line: root?.line ?? 1, source: root?.text ?? "", found: false };
  }
  best.component = /^\s*[\w$]+\s*=\s*([A-Z]\w*)\s*\(/.exec(best.source)?.[1] ?? "value";
  if (best.source.length > 1200) best.source = `${best.source.slice(0, 1200)}…`;
  return { found: true, ...best };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

export class Checker {
  async start() {
    const { browser, reason } = await launchBrowser();
    if (!browser) throw new Error(`Chrome is needed for the render and lavish checks: ${reason}`);
    this.browser = browser;
    this.lavishPort = await freePort();
    setLavishPort(this.lavishPort);
  }

  async stop() {
    await node([LAVISH_CLI, "stop"], { env: lavishEnv() });
    await this.browser?.close();
  }

  /**
   * Tool-neutral render check at both viewports. For lavish pages it also finds the
   * element a reviewer would click to leave the note (its selector and text).
   */
  async render(file, anchorText) {
    const result = { anchor: null };
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const context = await this.browser.newContext({ viewport });
      const page = await context.newPage();
      const pageErrors = [];
      const consoleErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
      // A page under review gets the runtime from the review server; here it comes from dist/.
      await page.route(/\/(austere\.js|mermaid\.min\.js|packs\/[\w-]+\/pack\.js)(\?.*)?$/, (route) => {
        const name = /\/(austere\.js|mermaid\.min\.js|packs\/[\w-]+\/pack\.js)(\?.*)?$/.exec(route.request().url())[1];
        route.fulfill({ path: path.join(ROOT, "dist", name), contentType: "text/javascript" });
      });
      try {
        await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 60000 });
      } catch (err) {
        pageErrors.push(`load: ${String(err.message).split("\n")[0]}`);
      }
      await page.waitForTimeout(3000);
      const info = await page
        .evaluate((anchor) => {
          const want = anchor.toLowerCase();
          const has = (el) => (el.textContent || "").toLowerCase().includes(want);
          let el = document.body && has(document.body) ? document.body : null;
          while (el) {
            const next = [...el.children].find((c) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(c.tagName) && has(c));
            if (!next) break;
            el = next;
          }
          const part = (e) => {
            let s = e.tagName.toLowerCase();
            if (e.id) return `${s}#${CSS.escape(e.id)}`;
            const cls = [...e.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
            const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
            return s + cls + (sib.length > 1 ? `:nth-of-type(${sib.indexOf(e) + 1})` : "");
          };
          const chain = [];
          for (let e = el; e && e !== document.body && chain.length < 4; e = e.parentElement) chain.unshift(part(e));
          return {
            overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
            renderErrors: [...document.querySelectorAll(".austere-render-error")].map((e) => (e.textContent || "").trim().slice(0, 300)),
            anchor: el && el !== document.body ? { selector: chain.join(" > "), text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) } : null,
          };
        }, anchorText)
        .catch((err) => ({ overflowX: false, renderErrors: [`evaluate: ${err.message}`], anchor: null }));
      result[name] = { pageErrors, consoleErrors, overflowX: info.overflowX, renderErrors: info.renderErrors };
      if (name === "desktop") result.anchor = info.anchor;
      await context.close();
    }
    result.ok = ["desktop", "mobile"].every((v) => !result[v].pageErrors.length && !result[v].renderErrors.length && !result[v].overflowX);
    return result;
  }

  /** lavish-axi's own checks: the open-time warnings and the in-browser layout audit. */
  async lavishAudit(file) {
    const cwd = path.dirname(path.dirname(file));
    const open = await node([LAVISH_CLI, file, "--no-open"], { cwd, env: lavishEnv() });
    const url = /url: "?(http[^"\s]+)/.exec(open.out)?.[1];
    const openWarnings = [...open.out.matchAll(/^(\w+_warning):/gm)].map((m) => m[1]);
    if (!url) return { ok: false, openWarnings, findings: [], incomplete: true, output: open.out.slice(0, 2000) };
    const sessionUrl = `http://127.0.0.1:${this.lavishPort}${new URL(url).pathname}`;
    const findings = [];
    const failures = [];
    let incomplete = false;
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const context = await this.browser.newContext({ viewport });
      const page = await context.newPage();
      const messages = [];
      await page.exposeFunction("__benchMessage", (m) => messages.push(m));
      await page.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener("message", (e) => {
          const t = e.data?.type;
          if (t === "lavish:layoutDiagnostics" || t === "lavish:artifactAssetFailure") window.__benchMessage(e.data);
        });
      });
      await page.goto(sessionUrl, { waitUntil: "load", timeout: 60000 }).catch(() => {});
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !messages.some((m) => m.type === "lavish:layoutDiagnostics" && m.complete)) await page.waitForTimeout(500);
      await page.waitForTimeout(1500);
      const audits = messages.filter((m) => m.type === "lavish:layoutDiagnostics");
      const last = audits.findLast((m) => m.complete) ?? audits.at(-1);
      if (!last?.complete) incomplete = true;
      for (const f of last?.findings ?? []) findings.push({ viewport: name, width: last.viewport_width, kind: f.kind, selector: String(f.selector).slice(0, 200) });
      for (const m of messages.filter((m) => m.type === "lavish:artifactAssetFailure")) failures.push(m.detail);
      await context.close();
    }
    await node([LAVISH_CLI, "end", file], { cwd, env: lavishEnv() });
    return { ok: !openWarnings.length && !findings.length && !failures.length, openWarnings, findings, failures, incomplete, output: open.out.slice(0, 4000) };
  }
}

/**
 * Facts from the task that appear in the page source (case-insensitive, entities
 * decoded). A number also counts without its thousands separators, as chart data
 * holds it (15,900 → 15900).
 */
export function factsFound(source, facts) {
  const text = source
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const has = (f) => {
    const want = f.toLowerCase().replace(/\s+/g, " ");
    return text.includes(want) || text.includes(want.replace(/(\d),(?=\d{3}\b)/g, "$1"));
  };
  return facts.filter(has);
}

export function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
