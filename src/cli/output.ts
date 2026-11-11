// Compact, YAML-shaped output: cheap for agents to read, easy for humans to scan.

const PLAIN = /^[A-Za-z0-9_./@:+-][A-Za-z0-9 _./@:+(),=<>*#%?!'-]*$/;

/** JSON.stringify leaves NEL, LS and PS raw; YAML readers treat them as line breaks, so escape them. */
const json = (v: unknown): string => JSON.stringify(v).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (PLAIN.test(s) && !/^(true|false|null|yes|no|-?\d[\d.]*)$/i.test(s) && !/: /.test(s) && !/\s$/.test(s)) return s;
  return json(s);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const isList = (v: unknown): v is unknown[] => Array.isArray(v);

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** Keys can come from reviewer data: anything that is not a simple identifier is quoted, so it cannot add structure. */
const key = (k: string): string => (KEY.test(k) ? k : json(k));

function emit(value: object, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  if (isList(value)) {
    if (!value.length) return;
    for (const item of value) {
      if (isPlainObject(item)) {
        const sub: string[] = [];
        emit(item, indent + 2, sub);
        if (sub.length) {
          sub[0] = pad + "- " + sub[0].slice(indent + 2);
          lines.push(...sub);
        } else lines.push(pad + "- {}");
      } else if (Array.isArray(item)) {
        lines.push(pad + "- " + json(item));
      } else {
        pushScalar(lines, pad + "- ", item, indent + 2);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (isList(v)) {
      if (!v.length) continue;
      if (v.every((x) => !isPlainObject(x) && !Array.isArray(x)) && v.join(", ").length < 100) {
        lines.push(`${pad}${key(k)}: [${v.map(scalar).join(", ")}]`);
      } else {
        lines.push(`${pad}${key(k)}:`);
        emit(v, indent + 2, lines);
      }
    } else if (isPlainObject(v)) {
      const inline = json(v);
      if (inline.length <= 100 && !Object.values(v).some((x) => typeof x === "object" && x)) {
        lines.push(`${pad}${key(k)}: ${inline}`);
      } else {
        lines.push(`${pad}${key(k)}:`);
        emit(v, indent + 2, lines);
      }
    } else {
      pushScalar(lines, `${pad}${key(k)}: `, v, indent + 2);
    }
  }
}

function pushScalar(lines: string[], prefix: string, v: unknown, indent: number): void {
  // A block scalar holds only LF line breaks: a CR, VT, FF, NEL, LS or PS would start a line in a YAML parser or terminal.
  if (typeof v === "string" && v.includes("\n") && !/[\r\u000b\u000c\u0085\u2028\u2029]/.test(v)) {
    lines.push(prefix + "|");
    const pad = " ".repeat(indent);
    for (const l of v.replace(/\n+$/, "").split("\n")) lines.push(pad + l);
    return;
  }
  lines.push(prefix + scalar(v));
}

export function format(obj: object): string {
  const lines: string[] = [];
  emit(obj, 0, lines);
  return lines.join("\n");
}

export function print(obj: object): void {
  process.stdout.write(format(obj) + "\n");
}
