// Hand-written declarations for layout.mjs (plain JS so it can run under
// `node --test` without a build step; the client bundles it via esbuild).
import type { TouchKey } from "./src/touchKeys";

export function parseLayout(raw: unknown, defaults: TouchKey[]): { keys: TouchKey[]; error: string | null };
