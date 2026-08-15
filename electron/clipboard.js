import { clipboard } from "electron";
import { stat } from "node:fs/promises";
import path from "node:path";

/** Windows exposes a copied file as a path in one of these two formats. */
export function ClipboardFilePath() {
  for (const format of ["FileNameW", "FileName"]) {
    try {
      const buffer = clipboard.readBuffer(format);
      if (!buffer?.length) continue;

      const decoded = buffer.toString(format === "FileNameW" ? "utf16le" : "utf8");
      const trimmed = decoded.split("\0")[0].trim();
      if (trimmed) return trimmed;
    } catch {
      // Format not on the clipboard. Try the next one.
    }
  }

  return null;
}

/**
 * A pasted file reaches the renderer with no path, so without this it would be
 * read into memory, pushed through IPC as bytes, and written back out as a copy
 * that Claude edits instead of the original.
 *
 * Chromium only re-exposes the *first* entry of a CF_HDROP paste, so a
 * multi-file copy is resolved against that entry's folder. Explorer copies come
 * from one selection in one folder, which makes that safe, and every candidate
 * is confirmed against a real stat before it is trusted. Any mismatch returns
 * nothing at all, so the caller falls back to bytes rather than attaching a
 * half-correct set.
 */
export async function ResolveClipboardFiles(files) {
  const first = ClipboardFilePath();
  if (!first || !files?.length) return [];

  const folder = path.dirname(first);
  const resolved = [];

  for (const file of files) {
    const candidate = path.basename(first) === file.name ? first : path.join(folder, file.name);

    try {
      const info = await stat(candidate);
      if (!info.isFile() || info.size !== file.size) return [];
      resolved.push(candidate);
    } catch {
      return [];
    }
  }

  return resolved;
}
