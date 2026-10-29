// First: component packs read React, zod and the pack API from the host it installs.
import "./host.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Renderer } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui/ThemeProvider";
import uiDefaultsCss from "@openuidev/react-ui/defaults.css";
import uiCss from "@openuidev/react-ui/styles/index.css";
import austereCss from "./austere.css";
import fontCss from "./font.css";
import { austereLibrary, buildLibrary } from "./library.jsx";
import { createAnnotator } from "./annotate.js";
import { onRuntimeError, reportRuntimeError } from "./env.js";
import { registeredPacks } from "./pack-api.js";
import { declaredPacks, injectPackStyles, loadPacks, packsFor, served } from "./packs.js";
import { changedStatementIds, referencesTo, statementMap } from "../shared/statements.js";

const VERSION = typeof __AUSTERE_VERSION__ === "string" ? __AUSTERE_VERSION__ : "dev";
const PROGRAM_SELECTOR = 'script[type="text/openui"], script[type="text/openui-lang"]';

function injectStyles() {
  if (document.getElementById("austere-styles")) return;
  const style = document.createElement("style");
  style.id = "austere-styles";
  style.textContent = [fontCss, uiDefaultsCss, uiCss, austereCss].join("\n");
  document.head.appendChild(style);
  if (!document.querySelector('meta[name="viewport"]')) {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1";
    document.head.appendChild(meta);
  }
  document.documentElement.classList.add("austere");
  document.documentElement.style.colorScheme = "dark";
}

/** Form payloads arrive as { form: { field: { value, componentType } } }; keep just the values. */
function plainForm(state) {
  if (!state || typeof state !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("$")) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("value" in v && Object.keys(v).length <= 3) out[k] = v.value;
      else {
        const inner = plainForm(v);
        if (inner && Object.keys(inner).length) out[k] = inner;
      }
    } else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Review bridge (only when framed by the austere-axi chrome) ──

function createBridge() {
  const framed = window.parent && window.parent !== window;
  const handlers = new Map();
  const send = (msg) => {
    if (framed) window.parent.postMessage({ austere: 1, ...msg }, "*");
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.austere !== 1 || typeof d.type !== "string") return;
    handlers.get(d.type)?.forEach((fn) => fn(d));
  });
  return {
    framed,
    connected: false,
    send,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
  };
}

function toast(text) {
  const t = document.createElement("div");
  t.className = "austere-toast";
  t.setAttribute("data-austere-ui", "");
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("out"), 2600);
  setTimeout(() => t.remove(), 3100);
}

function actionText(item) {
  const lines = [item.message];
  if (item.form) lines.push(`form: ${JSON.stringify(item.form)}`);
  if (item.context !== undefined) lines.push(`context: ${JSON.stringify(item.context)}`);
  return lines.join("\n");
}

// ── Packs ──

let declared = null; // read at first use: a hand-written tag may sit after the runtime <script>
const failed = new Set(); // packs that failed to load: not retried on every live update
let currentLibrary = austereLibrary;
let librarySignature = "";

function packError(pack, err) {
  failed.add(pack.name);
  // A script's onerror carries no reason; for an installed pack, check knows it.
  const why = !pack.bundled && served() ? " (`austere-axi check <file>` says why)" : "";
  reportRuntimeError({ source: "pack", component: pack.name, message: `pack ${pack.name}@${pack.version}: ${err.message}${why}` });
}

/** The library with every registered pack, rebuilt only when the set of packs changes. */
function libraryWithPacks() {
  const packs = registeredPacks();
  const signature = packs.map((p) => `${p.name}@${p.version}`).join(",");
  if (signature === librarySignature) return currentLibrary;
  librarySignature = signature;
  injectPackStyles(packs);
  try {
    currentLibrary = packs.length
      ? buildLibrary(
          packs.flatMap((p) => p.components),
          { onSkip: (c, message) => reportRuntimeError({ source: "pack", component: c.name, message }) },
        )
      : austereLibrary;
  } catch (err) {
    // Never let a pack blank the page: render with the core components.
    reportRuntimeError({ source: "pack", message: `packs could not be added (${err.message}); rendering without them` });
    currentLibrary = austereLibrary;
  }
  window.__austere.library = currentLibrary;
  return currentLibrary;
}

/** Load what a program needs (declared packs, and bundled ones it calls), then the library to render it with. */
async function prepare(program) {
  declared ||= declaredPacks();
  const want = packsFor(program, declared).filter((p) => !failed.has(p.name));
  if (want.some((p) => !registeredPacks().some((r) => r.name === p.name))) await loadPacks(want, { onError: packError });
  return libraryWithPacks();
}

function App({ initialProgram, initialLibrary, bridge, annotator, initialState }) {
  const [view, setView] = useState({ program: initialProgram, library: initialLibrary });
  const program = view.program;
  const programRef = useRef(initialProgram);
  const pendingFlash = useRef(null);

  useEffect(
    () =>
      bridge.on("source", async ({ program: next }) => {
        if (typeof next !== "string" || next === programRef.current) return;
        const changed = changedStatementIds(programRef.current, next);
        programRef.current = next;
        // A new Mermaid(...) call may need its pack first.
        const library = await prepare(next);
        if (programRef.current !== next) return;
        pendingFlash.current = changed;
        setView({ program: next, library });
      }),
    [bridge],
  );

  useEffect(
    () =>
      bridge.on("reveal", ({ id }) => {
        annotator?.reveal(id, statementMap(programRef.current), referencesTo);
      }),
    [bridge, annotator],
  );

  // Flash what changed once the new program has painted.
  useEffect(() => {
    const ids = pendingFlash.current;
    if (!ids) return;
    pendingFlash.current = null;
    const t = setTimeout(() => {
      const map = statementMap(programRef.current);
      const shown = ids.filter((id) => id !== "root");
      annotator?.flash(shown, "changed", map, referencesTo);
      bridge.send({ type: "changes", ids: shown });
    }, 120);
    return () => clearTimeout(t);
  }, [program, annotator, bridge]);

  const onAction = useCallback(
    (event) => {
      if (event.type === "open_url") {
        const url = event.params?.url;
        if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) window.open(url, "_blank", "noopener");
        return;
      }
      if (event.type !== "continue_conversation") return;
      const item = { kind: "action", message: event.humanFriendlyMessage || "(button)" };
      const form = plainForm(event.formState);
      if (form) item.form = form;
      if (event.params?.context !== undefined) item.context = event.params.context;
      if (bridge.connected) {
        bridge.send({ type: "action", item });
        toast("Queued for the agent — press Send when ready");
      } else {
        const text = actionText(item);
        navigator.clipboard?.writeText(text).then(
          () => toast("Copied — paste it to your agent"),
          () => toast(text),
        );
      }
    },
    [bridge],
  );

  const onError = useCallback(
    (errors) => {
      bridge.send({
        type: "errors",
        errors: (errors || []).map((e) => ({
          source: e.source,
          code: e.code,
          statementId: e.statementId,
          message: e.message,
          hint: e.hint,
        })),
      });
    },
    [bridge],
  );

  const onStateUpdate = useCallback((state) => bridge.send({ type: "state", state }), [bridge]);

  return (
    <ThemeProvider mode="dark">
      <main className="austere-page">
        <Renderer
          response={program}
          library={view.library}
          isStreaming={false}
          onAction={onAction}
          onError={onError}
          onStateUpdate={onStateUpdate}
          initialState={initialState}
        />
      </main>
    </ThemeProvider>
  );
}

function boot() {
  injectStyles();
  const programEl = document.querySelector(PROGRAM_SELECTOR);
  const program = programEl ? programEl.textContent : "";
  const mount = document.createElement("div");
  mount.id = "austere-root";
  document.body.appendChild(mount);
  const bridge = createBridge();
  let annotator = null;
  let started = null;

  // Packs load while the chrome handshakes; rendering waits for them.
  const ready = prepare(program);
  const render = (initialState) =>
    (started ||= ready.then((library) =>
      createRoot(mount).render(
        <App
          initialProgram={program}
          initialLibrary={library}
          bridge={bridge}
          annotator={annotator}
          initialState={initialState}
        />,
      ),
    ));

  if (!bridge.framed) {
    render(undefined);
    return;
  }

  annotator = createAnnotator({ post: (msg) => bridge.send(msg) });
  onRuntimeError((err) => bridge.send({ type: "runtime-error", error: err }));
  bridge.on("init", async (d) => {
    bridge.connected = true;
    annotator.setMode(d.mode);
    // "ready" only once rendering has started: the chrome sends live updates after it.
    await render(d.state || undefined);
    if (d.scrollY > 0) {
      // Restore position after a full reload once layout has settled.
      let tries = 0;
      const restore = () => {
        window.scrollTo(0, d.scrollY);
        if (Math.abs(window.scrollY - d.scrollY) > 2 && ++tries < 20) setTimeout(restore, 50);
      };
      setTimeout(restore, 30);
    }
    bridge.send({ type: "ready", title: document.title, version: VERSION });
  });
  bridge.on("mode", (d) => annotator.setMode(d.mode));
  window.addEventListener("scroll", () => bridge.send({ type: "scroll", y: window.scrollY }), { passive: true });
  bridge.send({ type: "hello", title: document.title, version: VERSION });
  // Framed by something that is not the review chrome: render anyway.
  setTimeout(() => render(undefined), 600);
}

window.__austere = { version: VERSION, library: austereLibrary, packs: registeredPacks };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
