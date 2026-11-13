// First: component packs read React, zod and the pack API from the host it installs.
import "./host.ts";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Renderer } from "@openuidev/react-lang";
import type { ActionEvent, Library, OpenUIError } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui/ThemeProvider";
import type * as UI from "@openuidev/react-ui";
import uiDefaultsCss from "@openuidev/react-ui/defaults.css";
import uiCss from "@openuidev/react-ui/styles/index.css";
import austereCss from "./austere.css";
import fontCss from "./font.css";
import { austereLibrary, buildLibrary } from "./library.tsx";
import { createAnnotator } from "./annotate.ts";
import type { Annotator, AnnotatorMessage, RefsTo } from "./annotate.ts";
import { onRuntimeError, reportRuntimeError } from "./env.ts";
import type { RuntimeErrorEntry } from "./env.ts";
import { registeredPacks } from "./pack-api.ts";
import { declaredPacks, injectPackStyles, loadPacks, packsFor, served } from "./packs.ts";
import type { WantedPack } from "./packs.ts";
import type { PackRef } from "../shared/packs-meta.ts";
import { changedStatementIds, referencesTo, statementMap } from "../shared/statements.ts";
import type { StatementMap } from "../shared/statements.ts";

/** A button press queued for the agent. */
export interface ActionItem {
  kind: "action";
  message: string;
  form?: Record<string, unknown>;
  context?: unknown;
}

/** A render error as the frame reports it to the chrome. */
export interface ReportedError {
  source: OpenUIError["source"];
  code: OpenUIError["code"];
  statementId?: string;
  message: string;
  hint?: string;
}

/**
 * What the chrome posts to the frame. Fields that the handlers check before use
 * are `unknown`: the data crosses a postMessage boundary.
 */
export type ChromeToFrame =
  | { type: "source"; program: unknown }
  | { type: "reveal"; id: string }
  | { type: "highlight"; ids: unknown; scroll: unknown }
  | { type: "init"; mode: unknown; state?: Record<string, unknown> | null; scrollY: number }
  | { type: "mode"; mode: unknown };

/** What the frame posts to the chrome, sent as { austere: 1, ...message }. */
export type FrameToChrome =
  | AnnotatorMessage
  | { type: "open-url"; url: string }
  | { type: "changes"; ids: string[] }
  | { type: "action"; item: ActionItem }
  | { type: "errors"; errors: ReportedError[] }
  | { type: "state"; state: Record<string, unknown> }
  | { type: "runtime-error"; error: RuntimeErrorEntry }
  | { type: "hello"; title: string; version: string }
  | { type: "ready"; title: string; version: string }
  | { type: "scroll"; y: number };

type ChromeMessageOf<T extends ChromeToFrame["type"]> = Extract<ChromeToFrame, { type: T }>;

interface Bridge {
  framed: boolean;
  connected: boolean;
  send(msg: FrameToChrome): void;
  on<T extends ChromeToFrame["type"]>(type: T, fn: (msg: ChromeMessageOf<T>) => void): () => void;
}

// The subpath's declarations re-export "./ThemeProvider" without an extension,
// which NodeNext resolution cannot follow; name the export from the package root.
declare module "@openuidev/react-ui/ThemeProvider" {
  export const ThemeProvider: typeof UI.ThemeProvider;
}

declare global {
  interface Window {
    __austere: { version: string; library: Library; packs: typeof registeredPacks };
  }
}

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
function plainForm(state: unknown): Record<string, unknown> | undefined {
  if (!state || typeof state !== "object") return undefined;
  const out: Record<string, unknown> = {};
  const entries: [string, unknown][] = Object.entries(state);
  for (const [k, v] of entries) {
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

/** A message from the chrome: austere: 1 and a string type. Each handler checks the fields it reads. */
function isChromeMessage(d: unknown): d is ChromeToFrame {
  return !!d && typeof d === "object" && "austere" in d && d.austere === 1 && "type" in d && typeof d.type === "string";
}

function createBridge(): Bridge {
  const framed = window.parent && window.parent !== window;
  const handlers = new Map<string, Set<(msg: ChromeToFrame) => void>>();
  const send = (msg: FrameToChrome) => {
    if (framed) window.parent.postMessage({ austere: 1, ...msg }, "*");
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const d: unknown = e.data;
    if (!isChromeMessage(d)) return;
    handlers.get(d.type)?.forEach((fn) => fn(d));
  });
  return {
    framed,
    connected: false,
    send,
    on<T extends ChromeToFrame["type"]>(type: T, fn: (msg: ChromeMessageOf<T>) => void) {
      // Dispatch is keyed by type, so a handler only ever sees its own kind of message.
      const handler = fn as (msg: ChromeToFrame) => void;
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };
}

// The frame's popups stay sandboxed, so in review the chrome opens links.
function openExternal(bridge: Bridge, url: string) {
  if (bridge.framed) bridge.send({ type: "open-url", url });
  else window.open(url, "_blank", "noopener");
}

function toast(text: string) {
  const t = document.createElement("div");
  t.className = "austere-toast";
  t.setAttribute("data-austere-ui", "");
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("out"), 2600);
  setTimeout(() => t.remove(), 3100);
}

function actionText(item: ActionItem) {
  const lines = [item.message];
  if (item.form) lines.push(`form: ${JSON.stringify(item.form)}`);
  if (item.context !== undefined) lines.push(`context: ${JSON.stringify(item.context)}`);
  return lines.join("\n");
}

// ── Packs ──

let declared: PackRef[] | null = null; // read at first use: a hand-written tag may sit after the runtime <script>
const failed = new Set<string>(); // packs that failed to load: not retried on every live update
let currentLibrary = austereLibrary;
let librarySignature = "";

function packError(pack: WantedPack, err: Error) {
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
    reportRuntimeError({ source: "pack", message: `packs could not be added (${(err as Error).message}); rendering without them` });
    currentLibrary = austereLibrary;
  }
  window.__austere.library = currentLibrary;
  return currentLibrary;
}

/** Load what a program needs (declared packs, and bundled ones it calls), then the library to render it with. */
async function prepare(program: string): Promise<Library> {
  declared ||= declaredPacks();
  const want = packsFor(program, declared).filter((p) => !failed.has(p.name));
  if (want.some((p) => !registeredPacks().some((r) => r.name === p.name))) await loadPacks(want, { onError: packError });
  return libraryWithPacks();
}

interface AppProps {
  /** The program on screen; App replaces it on live updates. */
  programRef: { current: string };
  initialLibrary: Library;
  bridge: Bridge;
  annotator: Annotator | null;
  initialState: Record<string, unknown> | undefined;
}

function App({ programRef, initialLibrary, bridge, annotator, initialState }: AppProps) {
  const [view, setView] = useState({ program: programRef.current, library: initialLibrary });
  const program = view.program;
  const pendingFlash = useRef<string[] | null>(null);

  useEffect(
    () =>
      bridge.on("source", async ({ program: next }) => {
        if (typeof next !== "string" || next === programRef.current) return;
        const changed = changedStatementIds(programRef.current, next);
        programRef.current = next;
        // The last turn's marks are stale now; the chrome sends this turn's.
        annotator?.highlight([]);
        // A new call to a bundled pack's component may need its pack first.
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
    (event: ActionEvent) => {
      if (event.type === "open_url") {
        const url = event.params?.url;
        if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) openExternal(bridge, url);
        return;
      }
      if (event.type !== "continue_conversation") return;
      const item: ActionItem = { kind: "action", message: event.humanFriendlyMessage || "(button)" };
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
    (errors: OpenUIError[]) => {
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

  const onStateUpdate = useCallback((state: Record<string, unknown>) => bridge.send({ type: "state", state }), [bridge]);

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
  const program = programEl?.textContent ?? "";
  const mount = document.createElement("div");
  mount.id = "austere-root";
  document.body.appendChild(mount);
  const bridge = createBridge();
  // The program on screen; App replaces it on live updates.
  const live = { current: program };
  let annotator: Annotator | null = null;
  let started: Promise<void> | null = null;

  // Packs load while the chrome handshakes; rendering waits for them.
  const ready = prepare(program);
  const render = (initialState: Record<string, unknown> | undefined) =>
    (started ||= ready.then((library) =>
      createRoot(mount).render(
        <App
          programRef={live}
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

  // Starts empty: its null program never matches the one on screen.
  let mapped: { program: string | null; map: StatementMap } = { program: null, map: new Map() };
  const lookup = (): [StatementMap, RefsTo] => {
    if (mapped.program !== live.current) mapped = { program: live.current, map: statementMap(live.current) };
    return [mapped.map, referencesTo];
  };
  const ann = createAnnotator({ post: (msg) => bridge.send(msg), lookup });
  annotator = ann;
  // Registered here, not in App: the chrome may send it as soon as the frame is ready.
  bridge.on("highlight", ({ ids, scroll }) => {
    ann.highlight(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [], !!scroll);
  });
  // Links that would open a new window (markdown, URL cells) would get a
  // sandboxed popup that breaks most sites, so the chrome opens them instead.
  // The chrome refuses this server's own URLs; those keep the sandboxed popup.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    // An SVG <a> has no string href, so it never matched the pattern either.
    if (!(a instanceof HTMLAnchorElement) || !/^(https?|mailto):/i.test(a.href) || (a.protocol === location.protocol && a.host === location.host)) return;
    const target = (a.getAttribute("target") || "").toLowerCase();
    if (!target || target === "_self") return;
    e.preventDefault();
    openExternal(bridge, a.href);
  });
  onRuntimeError((err) => bridge.send({ type: "runtime-error", error: err }));
  bridge.on("init", async (d) => {
    bridge.connected = true;
    ann.setMode(d.mode);
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
  bridge.on("mode", (d) => ann.setMode(d.mode));
  window.addEventListener("scroll", () => bridge.send({ type: "scroll", y: window.scrollY }), { passive: true });
  bridge.send({ type: "hello", title: document.title, version: VERSION });
  // Framed by something that is not the review chrome: render anyway.
  setTimeout(() => render(undefined), 600);
}

window.__austere = { version: VERSION, library: austereLibrary, packs: registeredPacks };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
