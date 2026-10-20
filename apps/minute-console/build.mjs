// Bundles the console and inlines it into one self-contained HTML file, so the
// prototype opens straight from the repository or publishes as a single page.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../minute-console.html");

const result = await build({
  entryPoints: [path.join(here, "src/main.js")],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "none",
  write: false,
  // The core library is consumed from source so the page always matches the tests.
  alias: { "@observa/core": path.resolve(here, "../../packages/core/src/index.ts") },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile(path.join(here, "src/index.html"), "utf8");
const html = template.replace("<!--APP-->", `<script>\n${js}</script>`);
await writeFile(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(0)} KB)`);
