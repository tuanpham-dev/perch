// Hand-written declarations for textareaInput.mjs (plain JS so it can run
// under `node --test` without a build step; the engine bundles it via esbuild).
export function keepTextareaClear(textarea: HTMLTextAreaElement): () => void;
