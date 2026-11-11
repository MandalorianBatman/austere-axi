// Stand-in for `react-syntax-highlighter`'s full Prism build (every language,
// ~0.6 MB) used by OpenUI's CodeBlock: the light build plus the languages
// review artifacts actually show. Unknown languages render as plain text.
/// <reference types="react-syntax-highlighter" />
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

const LANGS: Record<string, [unknown, ...string[]]> = {
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
