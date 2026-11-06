/**
 * What an uploaded attachment is, decided on the server (audit 2026-10-20,
 * R100).
 *
 * The upload stored whatever `mimeType` the browser sent and served the file
 * back with it, so a file could be labelled text/html or image/svg+xml — or a
 * PDF that was really a page of script — and open inline from the storage
 * link. Now the name's extension picks the type from a short list, the first
 * bytes must agree with it where the format has a signature, and anything not
 * on the list is stored as application/octet-stream, which a browser
 * downloads instead of rendering. The browser's claim is not read at all.
 */

/** The largest attachment accepted: the same 8 MB the Files tab checks. */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** The base64 length of a file at that size. */
export const ATTACHMENT_MAX_BASE64 = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

type Kind = { mime: string; magic?: (b: Buffer) => boolean; text?: boolean };

const startsWith = (sig: number[]) => (b: Buffer) => sig.every((x, i) => b[i] === x);
const ZIP = startsWith([0x50, 0x4b, 0x03, 0x04]);
const OLE = startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const KINDS: Record<string, Kind> = {
  pdf: { mime: "application/pdf", magic: startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]) },
  png: { mime: "image/png", magic: startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { mime: "image/jpeg", magic: startsWith([0xff, 0xd8, 0xff]) },
  jpeg: { mime: "image/jpeg", magic: startsWith([0xff, 0xd8, 0xff]) },
  gif: { mime: "image/gif", magic: (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a" },
  webp: { mime: "image/webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: ZIP },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: ZIP },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", magic: ZIP },
  zip: { mime: "application/zip", magic: ZIP },
  doc: { mime: "application/msword", magic: OLE },
  xls: { mime: "application/vnd.ms-excel", magic: OLE },
  ppt: { mime: "application/vnd.ms-powerpoint", magic: OLE },
  txt: { mime: "text/plain", text: true },
  csv: { mime: "text/csv", text: true },
  md: { mime: "text/plain", text: true },
};

export type AttachmentType = { ok: true; mimeType: string } | { ok: false; reason: string };

export function attachmentType(fileName: string, buf: Buffer): AttachmentType {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim())?.[1]?.toLowerCase() ?? "";
  const kind = KINDS[ext];
  // Off the list: kept, but only ever downloaded.
  if (!kind) return { ok: true, mimeType: "application/octet-stream" };
  if (kind.magic && !kind.magic(buf)) {
    return { ok: false, reason: `This file isn't a real .${ext} file — its contents don't match its name.` };
  }
  if (kind.text && buf.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: `This file isn't plain text, so it can't be a .${ext} file.` };
  }
  return { ok: true, mimeType: kind.mime };
}
