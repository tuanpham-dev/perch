// Loads the optional server/.env (gitignored) into process.env. Imported
// first by index.ts: ES modules run their imports in order, so every module
// after it sees these values even in code that runs as it loads (the config
// directory, for one).
import path from "node:path";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../.env"));
} catch {
  // No .env file — every variable it could set has a fallback.
}
