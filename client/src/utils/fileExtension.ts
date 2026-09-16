// Shared by extensions.ts's findFileViewerFor and iconThemes.ts's
// getFileIconResult — both need "the lowercase extension of this filename,
// or none" and had drifted into two independent implementations.
export function getFileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}
