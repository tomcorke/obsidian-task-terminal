import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

const pluginDir = resolve(
  process.env.HOME,
  "working/obsidian/test-vault/Test/.obsidian/plugins/task-terminal"
);

mkdirSync(pluginDir, { recursive: true });

const copyPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => {
      copyFileSync("manifest.json", resolve(pluginDir, "manifest.json"));
      copyFileSync("styles.css", resolve(pluginDir, "styles.css"));
      console.log("Copied manifest.json and styles.css to plugin dir");
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: resolve(pluginDir, "main.js"),
  format: "cjs",
  platform: "node",
  external: [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "path",
    "os",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  minify: isProduction,
  sourcemap: isProduction ? false : "inline",
  treeShaking: true,
  plugins: [copyPlugin],
});

if (isWatch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
