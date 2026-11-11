// npm run signatures — record new components and appended props in
// test/fixtures/signatures.json. Refuses (exit 1) on any change that would
// break stored artifacts.
import { loadLibrary } from "./lib/plugins.mjs";
import { compareSignatures, readSnapshot, signaturesOf, writeSnapshot } from "./lib/signatures.mjs";

const lib = await loadLibrary();
const { errors, added, appended, next } = compareSignatures(readSnapshot(), signaturesOf(lib.schema()));
if (errors.length) {
  console.error("Refusing to update signatures; these changes break stored artifacts:\n- " + errors.join("\n- "));
  process.exit(1);
}
if (!added.length && !appended.length) {
  console.log("signatures: up to date");
} else {
  writeSnapshot(next);
  if (added.length) console.log(`signatures: recorded ${added.length} new component(s): ${added.join(", ")}`);
  if (appended.length) console.log(`signatures: recorded appended props: ${appended.join("; ")}`);
}
