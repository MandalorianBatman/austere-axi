// Shipped skills never install anything: an agent that downloads and runs code because a skill says so
// is what skill audits flag as remote code execution. Installing lives in README.md, docs/install.md
// and the site; the skills run the `austere-axi` command the user installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const SKILLS = path.resolve(import.meta.dirname, "..", "skills");

test("no shipped skill installs anything or runs the CLI through npx", () => {
  for (const name of fs.readdirSync(SKILLS)) {
    const text = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
    for (const [install] of text.matchAll(
      /\bnpx\b[^\n`]*|\bnpm (?:i|install|update|exec)\b[^\n`]*|\bskills add\b[^\n`]*/g,
    )) {
      assert.fail(
        `skills/${name}/SKILL.md: \`${install}\` installs or downloads; installing belongs in README.md and docs/install.md`,
      );
    }
  }
});
