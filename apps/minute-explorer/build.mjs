// Bundles @observa/core into a global (ObservaCore) and inlines it ahead of the
// page script, so the explorer compiles its sampled playbacks with the same
// reference SDK the tests exercise, and still ships as one self-contained file.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../minute-explorer.html");

const core = await build({
  entryPoints: [path.resolve(here, "../../packages/core/src/index.ts")],
  bundle: true,
  format: "iife",
  globalName: "ObservaCore",
  target: "es2020",
  minify: true,
  legalComments: "none",
  write: false,
});
const js = core.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const page = await readFile(path.join(here, "src/explorer.html"), "utf8");
const marker = "<script>\n\"use strict\";";
if (!page.includes(marker)) throw new Error("page script marker not found");
const html = page.replace(marker, `<script>/* @observa/core */\n${js}</script>\n${marker}`);
await writeFile(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(0)} KB)`);
