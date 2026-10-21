// Minimal copy of the file-content helpers from client/src/api.ts that the
// preview viewers need — see extensions/_shared's module comment on why
// this is a copy, not a shared runtime import.

export function downloadUrl(targetPath: string): string {
  return `/api/download?path=${encodeURIComponent(targetPath)}`;
}

// Renders a file inline instead of downloading it — for content an <iframe>
// navigates to (PdfView), where Content-Disposition: attachment would
// trigger a download instead of rendering. <img>/<video> subresource loads
// don't need this: they ignore that header regardless.
export function inlineUrl(targetPath: string): string {
  return `/api/download?inline=1&path=${encodeURIComponent(targetPath)}`;
}

// Why a file a viewer showed couldn't load: the server's own message (not
// found, not readable), or null when it loads fine (the browser then can't
// show its contents: an unsupported codec, a broken image). The body of a
// file that does load is never read.
export async function fileLoadProblem(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `${res.status} ${res.statusText}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function fetchFileText(targetPath: string): Promise<string> {
  const res = await fetch(downloadUrl(targetPath));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// Writes content back to targetPath via the upload route in overwrite mode
// — used by JsonView's Format & Save and CsvView's Save.
export function saveFileText(targetPath: string, content: string): Promise<{ path: string }> {
  const slash = targetPath.lastIndexOf("/");
  const dir = targetPath.slice(0, slash);
  const name = targetPath.slice(slash + 1);
  const url = `/api/upload?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(name)}&conflict=overwrite`;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: content,
  }).then(async (res) => {
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        // non-JSON error body; keep the status message
      }
      throw new Error(message);
    }
    return res.json();
  });
}
