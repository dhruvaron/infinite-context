import { IngestionError } from "./errors.js";
import { chunkLines } from "./chunking.js";
import { PARSER_VERSION, type ExtractedDocument, type OcrAdapter } from "./types.js";

interface ImageMetadata {
  format: "png" | "jpeg" | "webp";
  width: number;
  height: number;
  orientation?: number;
  bitDepth?: number;
  colorType?: number;
  animated?: boolean;
}

const MAX_IMAGE_DIMENSION = 100_000;
const MAX_IMAGE_PIXELS = 250_000_000;

function validateDimensions(metadata: ImageMetadata): ImageMetadata {
  if (
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > MAX_IMAGE_DIMENSION ||
    metadata.height > MAX_IMAGE_DIMENSION ||
    metadata.width * metadata.height > MAX_IMAGE_PIXELS
  ) {
    throw new IngestionError("PARSER_LIMIT_EXCEEDED", "Image dimensions exceed safe analysis limits.");
  }
  return metadata;
}

function readPng(bytes: Uint8Array): ImageMetadata {
  if (bytes.length < 29) throw new IngestionError("MALFORMED_CONTENT", "PNG is truncated.");
  if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new IngestionError("MALFORMED_CONTENT", "PNG signature is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13 || Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR") {
    throw new IngestionError("MALFORMED_CONTENT", "PNG is missing its required IHDR header.");
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!width || !height) throw new IngestionError("MALFORMED_CONTENT", "PNG dimensions are invalid.");
  return {
    format: "png",
    width,
    height,
    ...(bytes[24] !== undefined ? { bitDepth: bytes[24] } : {}),
    ...(bytes[25] !== undefined ? { colorType: bytes[25] } : {})
  };
}

function readExifOrientation(segment: Uint8Array): number | undefined {
  if (segment.length < 14 || Buffer.from(segment.subarray(0, 6)).toString("binary") !== "Exif\0\0") return undefined;
  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  const tiff = 6;
  const byteOrder = String.fromCharCode(segment[tiff] ?? 0, segment[tiff + 1] ?? 0);
  const little = byteOrder === "II";
  if (!little && byteOrder !== "MM") return undefined;
  const ifdOffset = view.getUint32(tiff + 4, little);
  const start = tiff + ifdOffset;
  if (start + 2 > segment.length) return undefined;
  const count = view.getUint16(start, little);
  for (let index = 0; index < count; index += 1) {
    const offset = start + 2 + index * 12;
    if (offset + 12 > segment.length) return undefined;
    if (view.getUint16(offset, little) === 0x0112) return view.getUint16(offset + 8, little);
  }
  return undefined;
}

function readJpeg(bytes: Uint8Array): ImageMetadata {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new IngestionError("MALFORMED_CONTENT", "JPEG signature is invalid.");
  }
  let offset = 2;
  let orientation: number | undefined;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new IngestionError("MALFORMED_CONTENT", "JPEG marker is invalid.");
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) throw new IngestionError("MALFORMED_CONTENT", "JPEG segment is truncated.");
    const payload = bytes.subarray(offset + 2, offset + length);
    if (marker === 0xe1) orientation = readExifOrientation(payload);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (payload.length < 5) throw new IngestionError("MALFORMED_CONTENT", "JPEG dimensions are truncated.");
      const height = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
      const width = ((payload[3] ?? 0) << 8) | (payload[4] ?? 0);
      if (!width || !height) throw new IngestionError("MALFORMED_CONTENT", "JPEG dimensions are invalid.");
      return { format: "jpeg", width, height, ...(orientation ? { orientation } : {}) };
    }
    offset += length;
  }
  throw new IngestionError("MALFORMED_CONTENT", "JPEG has no supported frame header.");
}

function readWebp(bytes: Uint8Array): ImageMetadata {
  if (bytes.length < 30) throw new IngestionError("MALFORMED_CONTENT", "WebP is truncated.");
  if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF" || Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WEBP") {
    throw new IngestionError("MALFORMED_CONTENT", "WebP signature is invalid.");
  }
  const chunk = Buffer.from(bytes.subarray(12, 16)).toString("ascii");
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    return { format: "webp", width, height, animated: Boolean((bytes[20] ?? 0) & 0x02) };
  }
  if (chunk === "VP8 ") {
    const signature = Buffer.from(bytes.subarray(23, 26));
    if (!signature.equals(Buffer.from([0x9d, 0x01, 0x2a]))) throw new IngestionError("MALFORMED_CONTENT", "WebP VP8 frame is malformed.");
    const width = ((bytes[27] ?? 0) << 8 | (bytes[26] ?? 0)) & 0x3fff;
    const height = ((bytes[29] ?? 0) << 8 | (bytes[28] ?? 0)) & 0x3fff;
    return { format: "webp", width, height };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) throw new IngestionError("MALFORMED_CONTENT", "WebP lossless signature is invalid.");
    const b0 = bytes[21] ?? 0;
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6));
    return { format: "webp", width, height };
  }
  throw new IngestionError("MALFORMED_CONTENT", "Unsupported WebP frame type.");
}

export async function extractImageDocument(input: {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  ocr?: OcrAdapter;
  signal?: AbortSignal;
}): Promise<ExtractedDocument> {
  const metadata = validateDimensions(
    input.mediaType === "image/png"
      ? readPng(input.bytes)
      : input.mediaType === "image/jpeg"
        ? readJpeg(input.bytes)
        : readWebp(input.bytes)
  );
  const warnings: string[] = [];
  let ocrText = "";
  let ocrMetadata: Record<string, unknown> = {};
  if (input.ocr) {
    try {
      const result = await input.ocr.recognize({
        bytes: input.bytes,
        mediaType: input.mediaType,
        ...(input.signal ? { signal: input.signal } : {})
      });
      ocrText = result.text.replace(/\r\n?/g, "\n");
      ocrMetadata = {
        ocrEngine: result.engine,
        ...(result.engineVersion ? { ocrEngineVersion: result.engineVersion } : {}),
        ...(result.words ? { ocrWordCount: result.words.length } : {})
      };
    } catch {
      warnings.push("Image OCR failed; metadata remains available.");
    }
  }
  const description = [
    `Image format: ${metadata.format}`,
    `Dimensions: ${metadata.width} × ${metadata.height}`,
    ...(metadata.orientation ? [`EXIF orientation: ${metadata.orientation}`] : []),
    ...(ocrText ? ["", "OCR text:", ocrText] : [])
  ].join("\n");
  return {
    mediaType: input.mediaType,
    text: ocrText,
    chunks: chunkLines(description, `${PARSER_VERSION}:image-metadata`),
    metadata: { ...metadata, ...ocrMetadata, requiresVisionAnalysis: true },
    warnings,
    parserVersion: PARSER_VERSION,
    chunkerVersion: "continuum-chunker/1.0.0"
  };
}
