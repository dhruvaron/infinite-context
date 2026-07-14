import { inflateSync } from "node:zlib";
import { chunkLines } from "./chunking.js";
import { IngestionError } from "./errors.js";
import { MAX_EXTRACTED_TEXT_BYTES, MAX_PDF_PAGES } from "./policy.js";
import {
  PARSER_VERSION,
  type ExtractedDocument,
  type OcrAdapter,
  type PdfExtractorAdapter,
  type PdfPageExtraction,
  type PdfTextItem,
  type SourceChunk
} from "./types.js";

interface PdfObject {
  number: number;
  body: string;
}

function parseObjects(bytes: Uint8Array): Map<number, PdfObject> {
  const source = Buffer.from(bytes).toString("latin1");
  const objects = new Map<number, PdfObject>();
  const pattern = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g;
  for (const match of source.matchAll(pattern)) {
    const number = Number(match[1]);
    const body = match[3] ?? "";
    if (Number.isSafeInteger(number) && !objects.has(number)) objects.set(number, { number, body });
    if (objects.size > 1_000_000) throw new IngestionError("PARSER_LIMIT_EXCEEDED", "PDF has too many objects.");
  }
  return objects;
}

function streamFromObject(object: PdfObject): string {
  const marker = /stream\r?\n/.exec(object.body);
  if (!marker?.index && marker?.index !== 0) return "";
  const start = marker.index + marker[0].length;
  const end = object.body.lastIndexOf("endstream");
  if (end < start) throw new IngestionError("MALFORMED_CONTENT", "PDF stream is truncated.");
  const raw = Buffer.from(object.body.slice(start, end).replace(/\r?\n$/, ""), "latin1");
  if (/\/FlateDecode\b/.test(object.body.slice(0, marker.index))) {
    try {
      return inflateSync(raw, { maxOutputLength: MAX_EXTRACTED_TEXT_BYTES }).toString("latin1");
    } catch {
      throw new IngestionError("PDF_EXTRACTION_FAILED", "A compressed PDF content stream could not be decoded.");
    }
  }
  if (/\/(?:LZWDecode|DCTDecode|JPXDecode|ASCII85Decode)\b/.test(object.body.slice(0, marker.index))) {
    return "";
  }
  return raw.toString("latin1");
}

function decodePdfLiteral(token: string): string {
  if (token.startsWith("<") && !token.startsWith("<<")) {
    const clean = token.slice(1, -1).replace(/\s/g, "");
    const padded = clean.length % 2 === 0 ? clean : `${clean}0`;
    const bytes = Buffer.from(padded, "hex");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let output = "";
      for (let index = 2; index + 1 < bytes.length; index += 2) {
        output += String.fromCharCode(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
      }
      return output;
    }
    return bytes.toString("latin1");
  }
  let output = "";
  for (let index = 1; index < token.length - 1; index += 1) {
    const char = token[index] ?? "";
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = token[++index] ?? "";
    const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
    if (next in escapes) output += escapes[next];
    else if (next === "\r" || next === "\n") {
      if (next === "\r" && token[index + 1] === "\n") index += 1;
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && /[0-7]/.test(token[index + 1] ?? ""); count += 1) octal += token[++index];
      output += String.fromCharCode(Number.parseInt(octal, 8));
    } else output += next;
  }
  return output;
}

function scanStringTokens(block: string): Array<{ token: string; index: number }> {
  const tokens: Array<{ token: string; index: number }> = [];
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] === "(") {
      const start = index;
      let depth = 1;
      let escaped = false;
      while (++index < block.length && depth > 0) {
        const char = block[index] ?? "";
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
      }
      if (depth === 0) tokens.push({ token: block.slice(start, index + 1), index: start });
    } else if (block[index] === "<" && block[index + 1] !== "<") {
      const end = block.indexOf(">", index + 1);
      if (end !== -1) {
        tokens.push({ token: block.slice(index, end + 1), index });
        index = end;
      }
    }
  }
  return tokens;
}

function extractTextItems(stream: string): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  const blocks = stream.match(/BT[\s\S]*?ET/g) ?? [];
  for (const block of blocks) {
    let x = 0;
    let y = 0;
    let cursor = 0;
    for (const item of scanStringTokens(block)) {
      const prefix = block.slice(cursor, item.index);
      const transforms = [...prefix.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(?:Td|TD)\b|(?:-?\d+(?:\.\d+)?\s+){4}(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b/g)];
      const transform = transforms.at(-1);
      if (transform) {
        if (transform[3] !== undefined) {
          x = Number(transform[3]);
          y = Number(transform[4]);
        } else {
          x += Number(transform[1]);
          y += Number(transform[2]);
        }
      }
      const text = decodePdfLiteral(item.token).replace(/\0/g, "");
      if (text.trim()) items.push({ text, x, y });
      cursor = item.index + item.token.length;
      if (items.length > 2_000_000) throw new IngestionError("PARSER_LIMIT_EXCEEDED", "PDF has too many text items.");
    }
  }
  return items;
}

function contentReferences(body: string): number[] {
  const direct = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(body);
  if (direct) return [Number(direct[1])];
  const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? "";
  return [...array.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
}

/**
 * Dependency-free extractor for ordinary text PDFs. Complex object streams and
 * image-only pages should use an injected production PdfExtractorAdapter/OCR.
 */
export class BasicPdfExtractor implements PdfExtractorAdapter {
  readonly name = "builtin-pdf-content-stream";
  readonly version = "1.0.0";

  async extract(bytes: Uint8Array): Promise<PdfPageExtraction[]> {
    if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) {
      throw new IngestionError("MALFORMED_CONTENT", "PDF signature is invalid.");
    }
    const source = Buffer.from(bytes).toString("latin1");
    if (/\/Encrypt\b/.test(source)) throw new IngestionError("ENCRYPTED_PDF", "Encrypted PDFs are not supported.");
    const objects = parseObjects(bytes);
    const pageObjects = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/.test(object.body));
    if (pageObjects.length > MAX_PDF_PAGES) throw new IngestionError("PARSER_LIMIT_EXCEEDED", "PDF has too many pages.");
    const pages: PdfPageExtraction[] = [];
    for (let index = 0; index < pageObjects.length; index += 1) {
      const pageObject = pageObjects[index];
      if (!pageObject) continue;
      const streams = contentReferences(pageObject.body)
        .map((reference) => objects.get(reference))
        .filter((value): value is PdfObject => Boolean(value))
        .map(streamFromObject);
      const items = streams.flatMap(extractTextItems);
      pages.push({ page: index + 1, text: items.map((item) => item.text).join(" ").trim(), items });
    }
    if (pages.length === 0) {
      const streams = [...objects.values()].map(streamFromObject).filter(Boolean);
      for (let index = 0; index < streams.length; index += 1) {
        const items = extractTextItems(streams[index] ?? "");
        if (items.length > 0) pages.push({ page: pages.length + 1, text: items.map((item) => item.text).join(" "), items });
      }
    }
    return pages;
  }
}

export async function extractPdfDocument(input: {
  bytes: Uint8Array;
  extractor?: PdfExtractorAdapter;
  ocr?: OcrAdapter;
  signal?: AbortSignal;
}): Promise<ExtractedDocument> {
  let extractor = input.extractor ?? new BasicPdfExtractor();
  const warnings: string[] = [];
  let pages: PdfPageExtraction[];
  try {
    pages = await extractor.extract(input.bytes, input.signal);
  } catch (error) {
    // Native PDFKit is an acceleration and fidelity layer, not a single point
    // of failure. Keep encrypted/malformed document errors authoritative, but
    // fall back to the bounded local parser when the optional adapter itself is
    // unavailable or fails.
    if (input.extractor && !(input.extractor instanceof BasicPdfExtractor)) {
      extractor = new BasicPdfExtractor();
      pages = await extractor.extract(input.bytes, input.signal);
      warnings.push("Native PDF extraction failed; the built-in local parser was used.");
    } else if (error instanceof IngestionError) throw error;
    else throw new IngestionError("PDF_EXTRACTION_FAILED", "PDF text extraction failed.");
  }
  if (pages.length > MAX_PDF_PAGES) throw new IngestionError("PARSER_LIMIT_EXCEEDED", "PDF has too many pages.");
  const chunks: SourceChunk[] = [];
  const texts: string[] = [];
  const pageMetadata: Array<Record<string, unknown>> = [];
  let totalTextBytes = 0;
  let remainingCoordinateItems = 200_000;
  const seenPages = new Set<number>();
  for (const page of pages) {
    if (page.page < 1 || !Number.isInteger(page.page)) throw new IngestionError("MALFORMED_CONTENT", "PDF adapter returned an invalid page number.");
    if (seenPages.has(page.page)) throw new IngestionError("MALFORMED_CONTENT", "PDF adapter returned a duplicate page number.");
    seenPages.add(page.page);
    let text = page.text.replace(/\r\n?/g, "\n");
    let usedOcr = false;
    if (text.trim().length < 20 && input.ocr) {
      try {
        const result = await input.ocr.recognize({
          bytes: page.renderedImage ?? input.bytes,
          mediaType: page.renderedImage ? "image/png" : "application/pdf",
          page: page.page,
          ...(input.signal ? { signal: input.signal } : {})
        });
        if (result.text.trim()) {
          text = result.text.replace(/\r\n?/g, "\n");
          usedOcr = true;
        }
      } catch {
        warnings.push(`OCR failed for PDF page ${page.page}.`);
      }
    }
    texts.push(text);
    totalTextBytes += Buffer.byteLength(text);
    if (totalTextBytes > MAX_EXTRACTED_TEXT_BYTES) throw new IngestionError("PARSER_LIMIT_EXCEEDED", "Extracted PDF text exceeds its safety limit.");
    const pageChunks = chunkLines(text, `${PARSER_VERSION}:${extractor.name}/${extractor.version}`, { page: page.page });
    for (const chunk of pageChunks) chunks.push({ ...chunk, ordinal: chunks.length });
    const coordinates = (page.items ?? []).slice(0, Math.max(0, remainingCoordinateItems));
    remainingCoordinateItems -= coordinates.length;
    pageMetadata.push({
      page: page.page,
      textItemCount: page.items?.length ?? 0,
      usedOcr,
      coordinates,
      coordinatesTruncated: coordinates.length < (page.items?.length ?? 0)
    });
  }
  if (texts.join("").length === 0) warnings.push("No text was extracted; the PDF may require a richer renderer/OCR adapter.");
  return {
    mediaType: "application/pdf",
    text: texts.map((text, index) => `--- Page ${pages[index]?.page ?? index + 1} ---\n${text}`).join("\n\n"),
    chunks,
    metadata: { pageCount: pages.length, pages: pageMetadata, extractor: extractor.name, extractorVersion: extractor.version },
    warnings,
    parserVersion: PARSER_VERSION,
    chunkerVersion: "continuum-chunker/1.0.0"
  };
}
