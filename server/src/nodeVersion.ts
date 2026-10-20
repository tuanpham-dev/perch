// Imported first by index.ts, so it runs before any module that needs a newer
// Node does (extension storage uses node:sqlite, unflagged and warning-free
// on Node 24). bin/perch checks the same before starting; this covers
// `npm start` and the desktop app's bundled server, which skip it.
export const MIN_NODE_MAJOR = 24;

const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE_MAJOR) {
  console.error(`Perch needs Node.js ${MIN_NODE_MAJOR} or newer (found ${process.version}) - install it from https://nodejs.org`);
  process.exit(1);
}
