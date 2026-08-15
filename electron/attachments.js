import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_ATTACHMENT_BYTES = 400 * 1024 * 1024;

/**
 * Anything larger is handed to Claude as a file path instead of an inline
 * image block — the Messages API rejects images past ~5MB, and a path is more
 * useful anyway since Claude can read it with its own tools.
 */
const INLINE_IMAGE_LIMIT = 3 * 1024 * 1024;

const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXTENSION_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

const ILLEGAL_NAME_CHARS = /[^-A-Za-z0-9._]+/g;

export function guessMimeType(filePath, fallback = "") {
  return EXTENSION_TYPES[path.extname(filePath).toLowerCase()] ?? fallback;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function sanitizeName(name) {
  const base = path.basename(name || "pasted-file").replace(ILLEGAL_NAME_CHARS, "_");
  return base.slice(0, 120) || "pasted-file";
}

function tooLarge(label, size) {
  return new Error(
    `"${label}" is ${formatBytes(size)} (${size.toLocaleString()} bytes), over the ` +
      `${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`,
  );
}

async function persistPastedBytes(dir, item) {
  const bytes = Buffer.from(item.bytes);

  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw tooLarge(item.name, bytes.byteLength);
  }

  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${randomUUID().slice(0, 8)}-${sanitizeName(item.name)}`);
  await writeFile(target, bytes);
  return { filePath: target, size: bytes.byteLength };
}

/**
 * Turns the renderer's attachment list into inline image blocks plus a list of
 * on-disk paths to mention in the prompt. Pasted blobs are written into
 * `dir` first so every attachment ends up as a real file Claude can reopen.
 */
export async function prepareAttachments(items, dir) {
  const blocks = [];
  const files = [];

  for (const item of items ?? []) {
    let filePath = item.path;
    let size = item.size ?? 0;

    if (!filePath) {
      const saved = await persistPastedBytes(dir, item);
      filePath = saved.filePath;
      size = saved.size;
    } else {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error(`"${filePath}" is not a file.`);
      size = info.size;
    }

    if (size > MAX_ATTACHMENT_BYTES) {
      throw tooLarge(path.basename(filePath), size);
    }

    const mediaType = item.mime || guessMimeType(filePath);
    const inlineable = INLINE_IMAGE_TYPES.has(mediaType) && size <= INLINE_IMAGE_LIMIT;

    if (inlineable) {
      const data = await readFile(filePath);
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
      });
    }

    files.push({ path: filePath, size, mediaType, inlined: inlineable });
  }

  return { blocks, files };
}

/**
 * Appends a plain-text manifest so Claude knows the paths exist even for
 * attachments too large to inline.
 */
export function describeAttachments(files) {
  if (files.length === 0) return "";

  const lines = files.map((file) => {
    const note = file.inlined
      ? ""
      : ` (${formatBytes(file.size)}, not inlined — read it from disk)`;
    return `- ${file.path}${note}`;
  });

  return `\n\nAttached files:\n${lines.join("\n")}`;
}
