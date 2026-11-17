// What a unit `server install` replaces runs with, read out of its text: a systemd unit (the
// one it wrote, or one the owner wrote by hand) or a launchd agent. Text in, settings out;
// service.ts does the file and service manager work.

/** The variables the unit `server install` writes sets itself, from its options. */
const MANAGED_ENV: Record<string, true> = { AUSTERE_AXI_LINK_URL: true, AUSTERE_AXI_STATE_DIR: true, AUSTERE_AXI_PORT: true };

/** Settings a drop-in carries over to the new unit, by section. Everything else is the new unit's own. */
const KEPT_KEYS: Record<string, Record<string, true>> = {
  Unit: { After: true, Wants: true, Requires: true },
  Service: { Environment: true, EnvironmentFile: true, ExecStartPre: true, ExecStartPost: true },
};

/** One assignment of a systemd unit. */
interface Assignment {
  section: string;
  key: string;
  value: string;
  /** The line as written, trimmed (continuation lines joined). */
  raw: string;
}

/** A line the new unit carries over, in its section. */
export interface KeptLine {
  section: "Unit" | "Service";
  line: string;
}

/** What a unit runs with. Null: the unit does not say (the server's default applies). */
export interface UnitSettings {
  /** The script node runs (the CLI), with systemd's `%%` and `$$` undone; specifiers such as `%h` are left as written. */
  cli: string | null;
  port: number | null;
  stateDir: string | null;
  linkUrl: string | null;
  /** Lines the new unit keeps: in a drop-in for systemd, in the agent's environment for launchd. */
  kept: KeptLine[];
  /** Other lines, as written; the caller leaves out those the new unit has too. */
  other: string[];
}

/** The assignments of a systemd unit, in order. Comments and blank lines are left out; a trailing `\` joins the next line. */
function assignments(text: string): Assignment[] {
  const out: Assignment[] = [];
  const lines = text.split(/\r?\n/);
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (line.endsWith("\\") && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i]}`;
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) continue;
    const head = /^\[(.+)\]$/.exec(t);
    if (head) {
      section = head[1];
      continue;
    }
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out.push({ section, key: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim(), raw: t });
  }
  return out;
}

/** A value split into words the way systemd splits ExecStart= and Environment=: spaces, with quotes grouping. */
function words(value: string): { raw: string; text: string }[] {
  const out: { raw: string; text: string }[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i])) i++;
    if (i >= value.length) break;
    const start = i;
    let text = "";
    while (i < value.length && !/\s/.test(value[i])) {
      const q = value[i];
      if (q === '"' || q === "'") {
        i++;
        while (i < value.length && value[i] !== q) {
          if (value[i] === "\\" && i + 1 < value.length) i++;
          text += value[i++];
        }
        i++;
      } else {
        if (q === "\\" && i + 1 < value.length) i++;
        text += value[i++];
      }
    }
    out.push({ raw: value.slice(start, i), text });
  }
  return out;
}

/** The script a command runs with node: the word after `node` (or `nodejs`), or null. */
function scriptOf(argv: string[]): string | null {
  const i = argv.findIndex((a) => /(^|\/)(node|nodejs)$/.test(a));
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const portOf = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

/** The port a command line names, as the CLI reads it: `--port n` or `--port=n`. */
function portArg(argv: string[]): number | null {
  const i = argv.indexOf("--port");
  return portOf(i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--port="))?.slice("--port=".length));
}

/** What a systemd unit runs with, and what of it a drop-in keeps. */
export function systemdSettings(text: string): UnitSettings {
  const env = new Map<string, string>();
  const kept: KeptLine[] = [];
  const other: string[] = [];
  let argv: string[] = [];
  for (const a of assignments(text)) {
    if (a.section === "Service" && a.key === "ExecStart") {
      // A prefix such as `-` or `@` changes how systemd runs it, not what.
      // systemd's escapes for a literal `%` and `$`, undone.
      argv = words(a.value.replace(/^[-@:+!]+/, "")).map((w) => w.text.replace(/%%/g, "%").replace(/\$\$/g, "$"));
      continue;
    }
    if (a.section === "Service" && a.key === "Environment") {
      // The new unit sets its own variables; the rest of the line is kept, as written.
      const rest: string[] = [];
      for (const w of words(a.value)) {
        const eq = w.text.indexOf("=");
        const name = eq > 0 ? w.text.slice(0, eq) : w.text;
        if (MANAGED_ENV[name] === true) env.set(name, w.text.slice(eq + 1));
        else rest.push(w.raw);
      }
      if (rest.length) kept.push({ section: "Service", line: `Environment=${rest.join(" ")}` });
      continue;
    }
    if (a.section === "Unit" && a.key === "Description") continue;
    if (KEPT_KEYS[a.section]?.[a.key] === true) kept.push({ section: a.section as KeptLine["section"], line: a.raw });
    else other.push(a.raw);
  }
  return {
    cli: scriptOf(argv),
    port: portArg(argv) ?? portOf(env.get("AUSTERE_AXI_PORT")),
    stateDir: env.get("AUSTERE_AXI_STATE_DIR") || null,
    linkUrl: env.get("AUSTERE_AXI_LINK_URL") || null,
    kept,
    other,
  };
}

const unxml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** What a launchd agent runs with; the variables it sets besides the managed ones are kept. */
export function launchdSettings(text: string): UnitSettings {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const argv = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]));
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
  const env = new Map<string, string>();
  const kept: KeptLine[] = [];
  for (const m of dict.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    const [name, value] = [unxml(m[1]), unxml(m[2])];
    if (MANAGED_ENV[name] === true) env.set(name, value);
    else kept.push({ section: "Service", line: `${name}=${value}` });
  }
  return {
    cli: scriptOf(argv),
    port: portArg(argv) ?? portOf(env.get("AUSTERE_AXI_PORT")),
    stateDir: env.get("AUSTERE_AXI_STATE_DIR") || null,
    linkUrl: env.get("AUSTERE_AXI_LINK_URL") || null,
    kept,
    other: [],
  };
}
