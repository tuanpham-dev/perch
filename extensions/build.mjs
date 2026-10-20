#!/usr/bin/env node
// Builds every extensions/<name>/src/client.tsx into extensions/<name>/dist/client.js
// (+ dist/client.css if the entry pulls in CSS, e.g. highlight.js's theme).
// Each .ts/.tsx directly in extensions/<name>/src/chunks/ is built to
// dist/chunks/<file>.js: a bundle the client import()s by URL through
// ctx.assetUrl on first use, so its weight stays out of client.js — the same
// convention perch-extensions' build uses (markdown-preview's Mermaid chunk).
// react/react-dom/react-jsx-runtime are aliased to _shared/shims so every
// bundled extension shares the host's single React instance instead of
// shipping its own — see _shared/shims/*.mjs and client/src/main.tsx.
import { build, context } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, watchFile, writeFileSync } from "node:fs";
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

// The .ts/.tsx files directly inside extensions/<name>/src/chunks, if any.
function findChunkEntries(name) {
  const dir = path.join(__dirname, name, "src/chunks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(dir, e.name));
}

async function buildChunks(name) {
  const entryPoints = findChunkEntries(name);
  if (entryPoints.length === 0) return;
  const ctx = await context({
    entryPoints,
    outdir: path.join(__dirname, name, "dist/chunks"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    alias: shims,
    // Minified, unlike client.js: chunks are the heavy, rarely-read artifacts.
    minify: true,
    logLevel: "info",
    define: { "import.meta.env.DEV": JSON.stringify(watch) },
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`[extensions] built ${name} chunks (${entryPoints.length})`);
  }
}

async function buildOne(name) {
  await buildChunks(name);
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

// The page agent: the tools a preview tab installs into the page it shows
// (see _shared/pageAgent.js). One script, the screenshot library, the
// bootstrap and the agent in that order, written to each extension that
// previews pages, where its client fetches it through ctx.assetUrl.
const PAGE_AGENT_CONSUMERS = ["live-preview", "ports"];

async function buildPageAgent() {
  const shared = path.join(__dirname, "_shared");
  const lib = await build({
    entryPoints: [path.join(shared, "pageCaptureEntry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2018",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  const source = [
    lib.outputFiles[0].text,
    readFileSync(path.join(shared, "pageBootstrap.js"), "utf8"),
    readFileSync(path.join(shared, "pageAgent.js"), "utf8"),
  ].join("\n;\n");
  for (const name of PAGE_AGENT_CONSUMERS) {
    const dir = path.join(__dirname, name, "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "page-agent.js"), source);
  }
  console.log("[extensions] built page agent");
}

async function watchPageAgent() {
  await buildPageAgent();
  const shared = path.join(__dirname, "_shared");
  let timer = null;
  for (const file of ["pageAgent.js", "pageBootstrap.js", "pageCaptureEntry.ts"]) {
    watchFile(path.join(shared, file), { interval: 500 }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => buildPageAgent().catch((err) => console.error("[extensions] page agent:", err)), 100);
    });
  }
}

const names = findExtensionNames();
if (names.length === 0) {
  console.log("[extensions] no extensions with a src/client.tsx entry found");
} else {
  await Promise.all([...names.map(buildOne), watch ? watchPageAgent() : buildPageAgent()]);
}
