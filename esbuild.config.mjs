import esbuild from "esbuild";
import process from "node:process";
import path from "node:path";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  alias: { "@": path.resolve("src") },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
