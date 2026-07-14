import { extname } from "node:path";
import { IngestionError } from "./errors.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const MAX_EXTRACTED_TEXT_BYTES = 32 * 1024 * 1024;
export const MAX_CSV_ROWS = 1_000_000;
export const MAX_CSV_COLUMNS = 10_000;
export const MAX_PDF_PAGES = 10_000;

export const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "application/typescript",
  "text/x-python",
  "text/x-c",
  "text/x-c++",
  "text/x-java-source",
  "text/x-go",
  "text/x-rust",
  "text/x-shellscript",
  "text/css",
  "text/html",
  "application/x-yaml",
  "text/yaml"
]);

const EXTENSION_MEDIA = new Map<string, string>([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".mdx", "text/markdown"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".jsx", "text/javascript"],
  [".ts", "text/typescript"],
  [".mts", "text/typescript"],
  [".cts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".py", "text/x-python"],
  [".c", "text/x-c"],
  [".h", "text/x-c"],
  [".cc", "text/x-c++"],
  [".cpp", "text/x-c++"],
  [".hpp", "text/x-c++"],
  [".java", "text/x-java-source"],
  [".go", "text/x-go"],
  [".rs", "text/x-rust"],
  [".sh", "text/x-shellscript"],
  [".bash", "text/x-shellscript"],
  [".css", "text/css"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".yaml", "text/yaml"],
  [".yml", "text/yaml"]
]);

const MEDIA_ALIASES = new Map([
  ["application/x-javascript", "application/javascript"],
  ["application/x-typescript", "application/typescript"],
  ["text/json", "application/json"],
  ["image/jpg", "image/jpeg"]
]);

export function normalizeMediaType(value: string): string {
  const base = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MEDIA_ALIASES.get(base) ?? base;
}

export function mediaTypeForFilename(filename: string): string | undefined {
  return EXTENSION_MEDIA.get(extname(filename).toLowerCase());
}

export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function validateFilename(filename: string): string {
  const normalized = filename.normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    normalized.includes("\0") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new IngestionError("INVALID_FILENAME", "Attachment filename is not safe.");
  }
  return normalized;
}

export function validateAttachmentPolicy(input: {
  filename: string;
  declaredMediaType: string;
  bytes: Uint8Array;
}): string {
  validateFilename(input.filename);
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new IngestionError("FILE_TOO_LARGE", "Attachment exceeds the 25 MB limit.", {
      size: input.bytes.byteLength,
      maximum: MAX_ATTACHMENT_BYTES
    });
  }
  const declared = normalizeMediaType(input.declaredMediaType);
  if (!ALLOWED_MEDIA_TYPES.has(declared)) {
    throw new IngestionError("UNSUPPORTED_MEDIA_TYPE", "Attachment media type is not allowed.", {
      mediaType: declared
    });
  }
  const sniffed = sniffMediaType(input.bytes);
  const expected = mediaTypeForFilename(input.filename);
  if (sniffed && sniffed !== declared) {
    throw new IngestionError("MEDIA_TYPE_MISMATCH", "Attachment bytes do not match its media type.", {
      declared,
      detected: sniffed
    });
  }
  if (expected && expected !== declared) {
    const codePairs = new Set([
      "application/javascript:text/javascript",
      "application/typescript:text/typescript",
      "text/yaml:application/x-yaml"
    ]);
    if (!codePairs.has(`${declared}:${expected}`) && !codePairs.has(`${expected}:${declared}`)) {
      throw new IngestionError("MEDIA_TYPE_MISMATCH", "Filename extension does not match its media type.", {
        declared,
        expected
      });
    }
  }
  return declared;
}

export function validateMessageAttachments(
  inputs: ReadonlyArray<{ bytes: Uint8Array }>
): void {
  if (inputs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new IngestionError("MESSAGE_TOO_LARGE", "A message may contain at most 20 attachments.");
  }
  const total = inputs.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw new IngestionError("MESSAGE_TOO_LARGE", "Attachments exceed the 100 MB per-message limit.", {
      size: total,
      maximum: MAX_MESSAGE_ATTACHMENT_BYTES
    });
  }
}

export function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/javascript" ||
    mediaType === "application/typescript" ||
    mediaType === "application/x-yaml"
  );
}

export function isCodeMediaType(mediaType: string): boolean {
  return (
    /(?:javascript|typescript|x-python|x-c(?:\+\+)?|x-java|x-go|x-rust|x-shell)/.test(
      mediaType
    )
  );
}
