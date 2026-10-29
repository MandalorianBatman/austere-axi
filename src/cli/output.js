// @ts-check
// Compact, YAML-shaped output: cheap for agents to read, easy for humans to scan.

const PLAIN = /^[A-Za-z0-9_./@:+-][A-Za-z0-9 _./@:+(),=<>*#%?!'-]*$/;

function scalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (PLAIN.test(s) && !/^(true|false|null|yes|no|-?\d[\d.]*)$/i.test(s) && !/: /.test(s) && !/\s$/.test(s)) return s;
  return JSON.stringify(s);
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function emit(value, indent, lines) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return;
    for (const item of value) {
      if (isPlainObject(item)) {
        const sub = [];
        emit(item, indent + 2, sub);
        if (sub.length) {
          sub[0] = pad + "- " + sub[0].slice(indent + 2);
          lines.push(...sub);
        } else lines.push(pad + "- {}");
      } else if (Array.isArray(item)) {
        lines.push(pad + "- " + JSON.stringify(item));
      } else {
        pushScalar(lines, pad + "- ", item, indent + 2);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      if (v.every((x) => !isPlainObject(x) && !Array.isArray(x)) && v.join(", ").length < 100) {
        lines.push(`${pad}${k}: [${v.map(scalar).join(", ")}]`);
      } else {
        lines.push(`${pad}${k}:`);
        emit(v, indent + 2, lines);
      }
    } else if (isPlainObject(v)) {
      const json = JSON.stringify(v);
      if (json.length <= 100 && !Object.values(v).some((x) => typeof x === "object" && x)) {
        lines.push(`${pad}${k}: ${json}`);
      } else {
        lines.push(`${pad}${k}:`);
        emit(v, indent + 2, lines);
      }
    } else {
      pushScalar(lines, `${pad}${k}: `, v, indent + 2);
    }
  }
}

function pushScalar(lines, prefix, v, indent) {
  if (typeof v === "string" && v.includes("\n")) {
    lines.push(prefix + "|");
    const pad = " ".repeat(indent);
    for (const l of v.replace(/\n+$/, "").split("\n")) lines.push(pad + l);
    return;
  }
  lines.push(prefix + scalar(v));
}

export function format(obj) {
  const lines = [];
  emit(obj, 0, lines);
  return lines.join("\n");
}

export function print(obj) {
  process.stdout.write(format(obj) + "\n");
}
