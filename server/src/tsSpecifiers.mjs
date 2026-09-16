// A resolve hook that lets `node --test` import server sources directly.
//
// Node strips TypeScript types natively, so a .ts file runs with no build
// step and no tsx - but TypeScript's own convention is to write relative
// imports as "./ai.js" even though the file on disk is ai.ts, and Node
// resolves that specifier literally and fails. This maps a .js specifier back
// to the .ts beside it, and only when that .ts actually exists, so a real .js
// import is untouched.
//
// Registered by the test script (--import). The server itself runs under tsx
// in dev and never loads this.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true, format: "module-typescript" };
    }
  }
  return nextResolve(specifier, context);
}

register(pathToFileURL(import.meta.filename));
