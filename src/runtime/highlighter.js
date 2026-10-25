// Stand-in for `react-syntax-highlighter`'s full Prism build (every language,
// ~0.6 MB) used by OpenUI's CodeBlock: the light build plus the languages
// review artifacts actually show. Unknown languages render as plain text.
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light.js";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash.js";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c.js";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp.js";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp.js";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css.js";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff.js";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker.js";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go.js";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql.js";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java.js";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript.js";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json.js";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx.js";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin.js";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown.js";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup.js";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php.js";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python.js";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby.js";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust.js";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss.js";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql.js";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift.js";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml.js";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx.js";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript.js";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml.js";

const LANGS = {
  bash: [bash, "sh", "shell", "zsh", "console"],
  c: [c, "h"],
  cpp: [cpp, "c++", "cc", "hpp"],
  csharp: [csharp, "cs", "c#"],
  css: [css],
  diff: [diff, "patch"],
  docker: [docker, "dockerfile"],
  go: [go, "golang"],
  graphql: [graphql, "gql"],
  java: [java],
  javascript: [javascript, "js", "mjs", "cjs", "node"],
  json: [json, "jsonc", "json5"],
  jsx: [jsx],
  kotlin: [kotlin, "kt"],
  markdown: [markdown, "md"],
  markup: [markup, "html", "xml", "svg", "vue"],
  php: [php],
  python: [python, "py"],
  ruby: [ruby, "rb"],
  rust: [rust, "rs"],
  scss: [scss, "sass"],
  sql: [sql, "postgres", "postgresql", "mysql", "sqlite"],
  swift: [swift],
  toml: [toml],
  tsx: [tsx],
  typescript: [typescript, "ts", "mts", "cts"],
  yaml: [yaml, "yml"],
};

for (const [name, [lang, ...aliases]] of Object.entries(LANGS)) {
  PrismLight.registerLanguage(name, lang);
  for (const a of aliases) PrismLight.registerLanguage(a, lang);
}

export { PrismLight as Prism, PrismLight };
export default PrismLight;
