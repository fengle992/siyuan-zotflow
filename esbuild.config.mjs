import esbuild from "esbuild";
import { copyFileSync } from "fs";

const production = process.argv[2] === "production";

function copyCss() {
  copyFileSync("styles/index.css", "index.css");
}

const context = await esbuild.context({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "index.js",
  format: "cjs",
  target: "es2020",
  external: ["siyuan"],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  legalComments: "none",
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  copyCss();
  process.exit(0);
} else {
  copyCss();
  await context.watch();
}
