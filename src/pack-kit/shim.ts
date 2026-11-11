// esbuild plugin for building a component pack: its imports of React, zod
// and "austere-axi/pack" become reads of globalThis.__austereHost, which the
// runtime (in a page) or the pack kit (in Node, for the catalog) provides. A
// pack bundle therefore carries none of them, and shares the page's single
// React and the library's zod.
export const HOST_MODULES = {
  react: "React",
  "react/jsx-runtime": "jsxRuntime",
  "react/jsx-dev-runtime": "jsxRuntime",
  zod: "zod",
  "austere-axi/pack": "pack",
};

const FILTER = /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|zod|austere-axi\/pack)$/;

export const hostShimPlugin = {
  name: "austere-host-shim",
  setup(build) {
    build.onResolve({ filter: FILTER }, (args) => ({ path: args.path, namespace: "austere-host" }));
    build.onLoad({ filter: /.*/, namespace: "austere-host" }, (args) => ({
      contents:
        "var h = globalThis.__austereHost;\n" +
        'if (!h) throw new Error("this austere-axi component pack needs the austere-axi runtime on the page");\n' +
        `module.exports = h[${JSON.stringify(HOST_MODULES[args.path])}];\n`,
      loader: "js",
    }));
  },
};
