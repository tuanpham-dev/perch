// Byte counts as MB, for the upload size limit's settings copy and every
// message that reports a file was refused for being too big. Shared so the
// wire layer (api.ts's 413 mapping) and the upload pipeline (upload.ts's
// pre-flight check) can't drift apart in how they phrase a size.
export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
