// Hand-written declarations for searchQuery.mjs (plain JS so it can run
// under `node --test` without a build step; the client bundles it via
// esbuild).
export interface SearchQuery {
  grep: string;
  author: string;
  path: string;
}

export function parseSearchQuery(text: string): SearchQuery;
export function hasFilters(query: SearchQuery): boolean;
