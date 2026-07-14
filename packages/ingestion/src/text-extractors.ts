import { IngestionError } from "./errors.js";
import { chunkCodeSymbols, chunkLines, chunkMarkdown, RegexCodeSymbolAdapter } from "./chunking.js";
import { MAX_CSV_COLUMNS, MAX_CSV_ROWS, MAX_EXTRACTED_TEXT_BYTES } from "./policy.js";
import { PARSER_VERSION, type CodeSymbolAdapter, type ExtractedDocument, type SourceChunk } from "./types.js";

export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (Buffer.byteLength(text, "utf8") > MAX_EXTRACTED_TEXT_BYTES) {
      throw new IngestionError("PARSER_LIMIT_EXCEEDED", "Extracted text exceeds its safety limit.");
    }
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (normalized.includes("\0")) {
      throw new IngestionError("INVALID_ENCODING", "Text attachment contains NUL bytes and appears to be binary.");
    }
    return normalized;
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError("INVALID_ENCODING", "Text attachment is not valid UTF-8.");
  }
}

function baseDocument(
  mediaType: string,
  text: string,
  chunks: SourceChunk[],
  metadata: Record<string, unknown> = {},
  warnings: string[] = []
): ExtractedDocument {
  return {
    mediaType,
    text,
    chunks,
    metadata,
    warnings,
    parserVersion: PARSER_VERSION,
    chunkerVersion: chunks[0]?.chunkerVersion ?? "continuum-chunker/1.0.0"
  };
}

export async function extractTextDocument(input: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
  symbolAdapters?: readonly CodeSymbolAdapter[];
}): Promise<ExtractedDocument> {
  const text = decodeUtf8Strict(input.bytes);
  let chunks: SourceChunk[];
  if (input.mediaType === "text/markdown") {
    chunks = chunkMarkdown(text, PARSER_VERSION);
  } else if (isCode(input.mediaType)) {
    const adapters = input.symbolAdapters ?? [new RegexCodeSymbolAdapter()];
    const adapter = adapters.find((candidate) => candidate.supports(input.filename, input.mediaType));
    const symbols = adapter ? await adapter.extractSymbols(text, input.filename) : [];
    chunks = chunkCodeSymbols(text, symbols, `${PARSER_VERSION}:${adapter?.name ?? "line-fallback"}/${adapter?.version ?? "1"}`);
  } else {
    chunks = chunkLines(text, PARSER_VERSION);
  }
  return baseDocument(input.mediaType, text, chunks, {
    encoding: "utf-8",
    lineCount: text.length === 0 ? 0 : text.split("\n").length
  });
}

function isCode(mediaType: string): boolean {
  return /(?:javascript|typescript|x-python|x-c|x-java|x-go|x-rust|x-shell)/.test(mediaType);
}

export function extractJsonDocument(bytes: Uint8Array): ExtractedDocument {
  const text = decodeUtf8Strict(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IngestionError("MALFORMED_CONTENT", "JSON attachment is malformed.");
  }
  let nodes = 0;
  let maximumDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    maximumDepth = Math.max(maximumDepth, current.depth);
    if (nodes > 1_000_000 || current.depth > 1_000) {
      throw new IngestionError("PARSER_LIMIT_EXCEEDED", "JSON structure exceeds parser limits.");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return baseDocument("application/json", text, chunkLines(text, PARSER_VERSION), {
    rootType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    nodes,
    maximumDepth
  });
}

interface CsvRow {
  cells: string[];
  record: number;
  lineStart: number;
  lineEnd: number;
}

function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let justClosedQuote = false;
  let line = 1;
  let rowStart = 1;

  const pushCell = (): void => {
    cells.push(cell);
    cell = "";
    if (cells.length > MAX_CSV_COLUMNS) {
      throw new IngestionError("PARSER_LIMIT_EXCEEDED", "CSV has too many columns.");
    }
  };
  const pushRow = (): void => {
    pushCell();
    rows.push({ cells, record: rows.length + 1, lineStart: rowStart, lineEnd: line });
    cells = [];
    rowStart = line + 1;
    if (rows.length > MAX_CSV_ROWS) {
      throw new IngestionError("PARSER_LIMIT_EXCEEDED", "CSV has too many rows.");
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        cell += char;
        if (char === "\n") line += 1;
      }
      continue;
    }
    if (justClosedQuote && char !== "," && char !== "\n") {
      throw new IngestionError("MALFORMED_CONTENT", "CSV contains characters after a closing quote.");
    }
    if (char === '"' && cell.length === 0) {
      quoted = true;
      justClosedQuote = false;
    } else if (char === ",") {
      pushCell();
      justClosedQuote = false;
    } else if (char === "\n") {
      pushRow();
      line += 1;
      justClosedQuote = false;
    } else if (char === '"') {
      throw new IngestionError("MALFORMED_CONTENT", "CSV contains a quote inside an unquoted field.");
    } else {
      cell += char;
    }
  }
  if (quoted) throw new IngestionError("MALFORMED_CONTENT", "CSV contains an unterminated quoted field.");
  if (cell.length > 0 || cells.length > 0 || text.endsWith(",")) pushRow();
  return rows;
}

function encodeCsvRow(cells: readonly string[]): string {
  return cells
    .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
    .join(",");
}

export function extractCsvDocument(bytes: Uint8Array): ExtractedDocument {
  const text = decodeUtf8Strict(bytes);
  const rows = parseCsv(text);
  const header = rows[0];
  const dataRows = rows.slice(1);
  const chunks: SourceChunk[] = [];
  const headerText = header ? encodeCsvRow(header.cells) : "";
  let group: CsvRow[] = [];
  let chars = headerText.length;
  const flush = (): void => {
    if (group.length === 0) return;
    const value = [headerText, ...group.map((row) => encodeCsvRow(row.cells))]
      .filter((lineValue, index) => index > 0 || lineValue.length > 0)
      .join("\n");
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return;
    chunks.push({
      ordinal: chunks.length,
      text: value,
      contentHash: (awaitHash(value)),
      estimatedTokens: Math.ceil(value.length / 4),
      location: {
        rowStart: first.record,
        rowEnd: last.record,
        lineStart: first.lineStart,
        lineEnd: last.lineEnd
      },
      parserVersion: PARSER_VERSION,
      chunkerVersion: "continuum-chunker/1.0.0",
      metadata: { header: header?.cells ?? [], dataRowStart: first.record - 1, dataRowEnd: last.record - 1 }
    });
    group = [];
    chars = headerText.length;
  };
  for (const row of dataRows) {
    const rowText = encodeCsvRow(row.cells);
    if (group.length > 0 && chars + rowText.length + 1 > 6_000) flush();
    group.push(row);
    chars += rowText.length + 1;
  }
  flush();
  if (chunks.length === 0 && header) {
    chunks.push(...chunkLines(headerText, PARSER_VERSION, { rowStart: 1, rowEnd: 1 }));
  }
  const widths = rows.map((row) => row.cells.length);
  return baseDocument("text/csv", text, chunks, {
    rowCount: dataRows.length,
    columnCount: widths.reduce((maximum, width) => Math.max(maximum, width), 0),
    headers: header?.cells ?? [],
    ragged: new Set(widths).size > 1
  });
}

// Kept local to avoid making CSV parsing depend on content storage.
import { createHash } from "node:crypto";
function awaitHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
