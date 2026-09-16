#!/usr/bin/env node
// Builds every extensions/<name>/src/client.tsx into extensions/<name>/dist/client.js
// (+ dist/client.css if the entry pulls in CSS, e.g. highlight.js's theme).
// react/react-dom/react-jsx-runtime are aliased to _shared/shims so every
// bundled extension shares the host's single React instance instead of
// shipping its own — see _shared/shims/*.mjs and client/src/main.tsx.
import { context } from "esbuild";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const shims = {
  react: path.join(__dirname, "_shared/shims/react.mjs"),
  "react-dom": path.join(__dirname, "_shared/shims/react-dom.mjs"),
  "react-dom/client": path.join(__dirname, "_shared/shims/react-dom-client.mjs"),
  "react/jsx-runtime": path.join(__dirname, "_shared/shims/react-jsx-runtime.mjs"),
  "@perch/engine-support": path.join(__dirname, "_shared/shims/engine-support.mjs"),
};

function findExtensionNames() {
  return readdirSync(__dirname, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(__dirname, name, "src/client.tsx")));
}

async function buildOne(name) {
  const entry = path.join(__dirname, name, "src/client.tsx");
  const outfile = path.join(__dirname, name, "dist/client.js");
  const ctx = await context({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    sourcemap: true,
    alias: shims,
    logLevel: "info",
    // esbuild has no Vite-style import.meta.env — core's own bundle defines
    // import.meta.env.DEV via Vite, but an extension moved from core (see
    // e.g. ghostty-engine/src/engine.ts) can still reference it out of habit
    // and get `undefined.DEV` instead, at runtime, in every build (this
    // isn't a prod/dev split like Vite's — every extension build in and out
    // of --watch ships to real usage — so this maps watch to "DEV" as the
    // closest equivalent: on while iterating locally, off for a built dist).
    define: { "import.meta.env.DEV": JSON.stringify(watch) },
  });
  if (watch) {
    await ctx.watch();
    console.log(`[extensions] watching ${name}`);
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`[extensions] built ${name}`);
  }
}

const names = findExtensionNames();
if (names.length === 0) {
  console.log("[extensions] no extensions with a src/client.tsx entry found");
} else {
  await Promise.all(names.map(buildOne));
}
