// The OpenUI Lang lexer reads a double-quoted string with JSON.parse, which refuses a raw newline
// or tab. A string that spans lines then keeps every escape literally (`\"` stays a backslash and
// a quote, `\n` stays two characters), though the prompt tells agents to write both. Writing the
// raw control characters as escapes before parsing gives the string the same meaning the agent
// meant, with one result for one-line and multi-line strings. Single-quoted strings are untouched.
// Used wherever a program is parsed: `check`, `show`, the runtime. Free of Node APIs.

export function normalizeProgram(source: string): string {
  if (!/["]/.test(source) || !/["][^"\\]*[\n\t\r]/.test(source)) return source;
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote === '"') {
      if (c === "\\") {
        out += c + (source[i + 1] ?? "");
        i++;
      } else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else {
        out += c;
        if (c === '"') quote = null;
      }
    } else if (quote === "'") {
      out += c;
      if (c === "\\") {
        out += source[i + 1] ?? "";
        i++;
      } else if (c === "'") quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === "#" || (c === "/" && source[i + 1] === "/")) {
      // A comment runs to the end of the line; a quote in it opens nothing.
      let j = i;
      while (j < source.length && source[j] !== "\n") j++;
      out += source.slice(i, j);
      i = j - 1;
    } else out += c;
  }
  return out;
}
