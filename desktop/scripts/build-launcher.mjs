// Builds the launcher window (desktop/launcher) into launcher/dist, which
// tauri.conf.json serves as the app's own pages.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "launcher");
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, "main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "warning",
});
for (const file of ["index.html", "style.css"]) copyFileSync(join(root, file), join(out, file));
console.log("[launcher] built");
