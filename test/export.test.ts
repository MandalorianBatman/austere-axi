import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { exportHtml, packedScripts } from "../src/cli/export.ts";
import { hasInlineRuntime, readArtifact, rewriteRuntime } from "../src/cli/artifact.ts";
import { assetPath } from "../src/cli/paths.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "austere-export-"));
const PAGE = path.join(ROOT, "page");
const OUTSIDE = path.join(ROOT, "outside");
fs.mkdirSync(path.join(PAGE, "img"), { recursive: true });
fs.mkdirSync(OUTSIDE);
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const BYTES = Buffer.from([1, 2, 3, 250, 251]);
const uri = (type: string) => `data:${type};base64,${BYTES.toString("base64")}`;

const page = (program: string) => `<!doctype html><html><head><title>t</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head><body><script type="text/openui">\n${program}\n</script></body></html>`;
const exported = (program: string) => {
  const out = exportHtml(page(program), PAGE);
  return { ...out, program: readArtifact(out.html).program ?? "" };
};

test("relative images of every supported type become data URIs", () => {
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif" };
  for (const ext of Object.keys(types)) fs.writeFileSync(path.join(PAGE, `p.${ext}`), BYTES);
  fs.writeFileSync(path.join(PAGE, "img", "my pic.PNG"), BYTES);
  const lines = Object.keys(types).map((ext, i) => `i${i} = Image("alt", "p.${ext}")`);
  lines.push(`sp = Image('alt', 'img/my%20pic.PNG')`, `q = Image(alt, "p.png?v=2#x")`, `d = Image(alt, "./img/./my pic.PNG")`);
  const out = exported(["root = Stack([" + [...Object.keys(types).map((_, i) => `i${i}`), "sp", "q", "d"].join(", ") + "])", ...lines].join("\n"));
  assert.deepEqual(out.notices, []);
  Object.values(types).forEach((type, i) => assert.ok(out.program.includes(`i${i} = Image("alt", "${uri(type)}")`), `type ${type}`));
  assert.ok(out.program.includes(`sp = Image('alt', "${uri("image/png")}")`), "percent-encoded name, any extension case");
  assert.ok(out.program.includes(`q = Image(alt, "${uri("image/png")}")`), "a query or fragment is not part of the file name");
  assert.ok(out.program.includes(`d = Image(alt, "${uri("image/png")}")`), "./ segments are the folder itself");
});

test("everything outside the image sources is unchanged", () => {
  fs.writeFileSync(path.join(PAGE, "a.png"), BYTES);
  const program = `root = Stack([a, m, n, r])\na = Image("alt, with (parens) and a comma", "a.png")\nm = CodeBlock("text", "x = Image(\\"a.png\\", \\"a.png\\")")\nn = Image("x", "https://example.com/x.png")\nr = Image("x", "data:image/png;base64,AAAA")\n# Image("c", "a.png")`;
  const out = exported(program);
  assert.deepEqual(out.notices, []);
  const expected = program.replace(`Image("alt, with (parens) and a comma", "a.png")`, `Image("alt, with (parens) and a comma", "${uri("image/png")}")`);
  assert.equal(out.program, `\n${expected}\n`);
});

test("a missing, hidden, escaping or oversized image is left as written, with a notice that names it", () => {
  fs.writeFileSync(path.join(PAGE, ".secret.png"), BYTES);
  fs.writeFileSync(path.join(OUTSIDE, "o.png"), BYTES);
  fs.symlinkSync(path.join(OUTSIDE, "o.png"), path.join(PAGE, "link.png"));
  fs.symlinkSync(path.join(PAGE, ".secret.png"), path.join(PAGE, "plain.png"));
  fs.writeFileSync(path.join(PAGE, "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(PAGE, "doc.bmp"), BYTES);
  const srcs = ["gone.png", ".secret.png", "../outside/o.png", "link.png", "plain.png", "big.png", "doc.bmp", "/etc/hostname.png", "gone.png"];
  const out = exported(["root = Stack([" + srcs.map((_, i) => `i${i}`).join(", ") + "])", ...srcs.map((s, i) => `i${i} = Image("alt", "${s}")`)].join("\n"));
  for (const s of srcs) assert.ok(out.program.includes(`Image("alt", "${s}")`), `${s} untouched`);
  assert.ok(!out.html.includes(BYTES.toString("base64")), "no file content leaked");
  assert.equal(out.notices.length, srcs.length - 1, "one notice per source, not per use");
  const text = out.notices.join("\n");
  for (const [s, why] of [["gone.png", /no such file/], [".secret.png", /hidden/], ["../outside/o.png", /outside/], ["link.png", /outside/], ["plain.png", /hidden/], ["big.png", /over 10 MB/], ["doc.bmp", /not a png/]] as const) {
    assert.match(text, new RegExp(`Image "${s.replace(/[.]/g, "\\.")}" is not inlined: [^\\n]*${why.source}`));
  }
});

test("an image the process cannot read is left as written, and the export still finishes", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const locked = path.join(PAGE, "locked.png");
  fs.writeFileSync(locked, BYTES);
  fs.chmodSync(locked, 0);
  const out = exported(`root = Stack([a, b])\na = Image("alt", "locked.png")\nb = Image("alt", "p.png")`);
  assert.ok(out.program.includes(`a = Image("alt", "locked.png")`));
  assert.ok(out.program.includes(`b = Image("alt", "${uri("image/png")}")`), "the others are still inlined");
  assert.match(out.notices.join("\n"), /Image "locked\.png" is not inlined: it cannot be read/);
});

test("comments and line breaks between an Image call's arguments do not hide its source", () => {
  fs.writeFileSync(path.join(PAGE, "c.png"), BYTES);
  const out = exported(`root = Stack([a, b])\na = Image("alt", // the picture\n  "c.png")\nb = Image( # first\n  "alt, // not a comment" , # second\n  'c.png' )`);
  assert.deepEqual(out.notices, []);
  assert.equal(out.program.split(uri("image/png")).length - 1, 2);
  assert.ok(out.program.includes(`"alt, // not a comment"`), "a string stays as written");
});

test("the runtime is inlined packed: whole, under 1.5 MB, and once", () => {
  const out = exportHtml(page('root = Stack([t])\nt = TextContent("hi")'), PAGE);
  const packed = packedScripts(out.html);
  assert.deepEqual(packed.map((x) => x.name), ["austere.js"]);
  assert.equal(packed[0].code, fs.readFileSync(assetPath("austere.js"), "utf8"), "unpacks to the runtime as built");
  assert.ok(out.html.length < 1.5 * 1024 * 1024, `exported page is ${out.html.length} bytes`);
  assert.match(out.html, /<script data-austere-inline="loader">[^<]*DecompressionStream/, "a loader unpacks it");
  assert.doesNotMatch(out.html, /<script[^>]*\bsrc=/, "no network fetch");
  assert.ok(hasInlineRuntime(out.html));
  // Exporting the copy, or serving it for review, adds no second runtime.
  assert.equal(exportHtml(out.html, PAGE).html, out.html);
  assert.equal(rewriteRuntime(out.html, '<script src="/__austere/austere.js"></script>'), out.html);
});

test("an export from before packing counts as an exported copy", () => {
  const legacy = page("root = Stack([])").replace(/<script src="[^"]*"><\/script>/, "<script>(()=>{window.__austere={version:\"0.4.1\"}})()</script>");
  assert.ok(hasInlineRuntime(legacy));
  assert.equal(rewriteRuntime(legacy, '<script src="/__austere/austere.js"></script>'), legacy);
  assert.ok(!hasInlineRuntime(page("root = Stack([])")), "a page with a runtime tag is not");
});
