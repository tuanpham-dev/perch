// Shared shapes between client.tsx, Grid.tsx, and undo.ts — split out so
// none of the three needs to import from each other just for a type.
export type SortDir = "asc" | "desc" | null;
export type CellPos = { row: number; col: number };
export type CellRange = { anchor: CellPos; focus: CellPos };
export type Bounds = { minRow: number; maxRow: number; minCol: number; maxCol: number };
export type Snapshot = { rows: string[][]; headers: string[] };
