import { sha256 } from "./content-store.js";
import { CHUNKER_VERSION, type SourceChunk, type SourceLocation, type SymbolRange } from "./types.js";

const TARGET_CHARS = 6_000;
const MAX_CHARS = 8_000;

function makeChunk(
  text: string,
  ordinal: number,
  location: SourceLocation,
  parserVersion: string,
  metadata: Record<string, unknown> = {}
): SourceChunk {
  return {
    ordinal,
    text,
    contentHash: sha256(text),
    estimatedTokens: Math.ceil(text.length / 4),
    location,
    parserVersion,
    chunkerVersion: CHUNKER_VERSION,
    metadata
  };
}

export function chunkLines(
  text: string,
  parserVersion: string,
  base: SourceLocation = {},
  options: { targetChars?: number; maxChars?: number } = {}
): SourceChunk[] {
  if (text.length === 0) return [];
  const target = options.targetChars ?? TARGET_CHARS;
  const maximum = options.maxChars ?? MAX_CHARS;
  const lines = text.split("\n");
  const chunks: SourceChunk[] = [];
  let start = 0;
  let buffer: string[] = [];
  let length = 0;

  const flush = (endExclusive: number): void => {
    if (buffer.length === 0) return;
    const lineOffset = base.lineStart ? base.lineStart - 1 : 0;
    const value = buffer.join("\n");
    chunks.push(
      makeChunk(
        value,
        chunks.length,
        {
          ...base,
          lineStart: lineOffset + start + 1,
          lineEnd: lineOffset + endExclusive
        },
        parserVersion
      )
    );
    buffer = [];
    length = 0;
    start = endExclusive;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > maximum) {
      flush(index);
      for (let offset = 0; offset < line.length; offset += maximum) {
        const value = line.slice(offset, offset + maximum);
        chunks.push(
          makeChunk(
            value,
            chunks.length,
            {
              ...base,
              lineStart: (base.lineStart ?? 1) + index,
              lineEnd: (base.lineStart ?? 1) + index,
              columnStart: offset,
              columnEnd: offset + value.length
            },
            parserVersion,
            { splitLongLine: true }
          )
        );
      }
      start = index + 1;
      continue;
    }
    if (buffer.length > 0 && length + line.length + 1 > target) flush(index);
    buffer.push(line);
    length += line.length + (buffer.length > 1 ? 1 : 0);
  }
  flush(lines.length);
  return chunks;
}

/** Heading boundaries improve Markdown retrieval without losing exact line citations. */
export function chunkMarkdown(text: string, parserVersion: string): SourceChunk[] {
  const lines = text.split("\n");
  const sections: Array<{ start: number; end: number; heading?: string }> = [];
  let start = 0;
  let heading: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (match && index > start) {
      sections.push({ start, end: index, ...(heading ? { heading } : {}) });
      start = index;
    }
    if (match) heading = match[2];
  }
  sections.push({ start, end: lines.length, ...(heading ? { heading } : {}) });
  const output: SourceChunk[] = [];
  for (const section of sections) {
    const sectionText = lines.slice(section.start, section.end).join("\n");
    for (const chunk of chunkLines(sectionText, parserVersion, { lineStart: section.start + 1 })) {
      output.push({
        ...chunk,
        ordinal: output.length,
        metadata: { ...chunk.metadata, ...(section.heading ? { heading: section.heading } : {}) }
      });
    }
  }
  return output;
}

export function chunkCodeSymbols(
  text: string,
  symbols: readonly SymbolRange[],
  parserVersion: string
): SourceChunk[] {
  const lines = text.split("\n");
  const output: SourceChunk[] = [];
  const valid = [...symbols]
    .filter(
      (symbol) =>
        symbol.lineStart >= 1 &&
        symbol.lineEnd >= symbol.lineStart &&
        symbol.lineEnd <= lines.length
    )
    .sort((left, right) => left.lineStart - right.lineStart || left.lineEnd - right.lineEnd);
  let nextUncoveredLine = 1;
  const appendContext = (lineStart: number, lineEnd: number): void => {
    if (lineEnd < lineStart) return;
    const value = lines.slice(lineStart - 1, lineEnd).join("\n");
    for (const chunk of chunkLines(value, parserVersion, { lineStart })) {
      output.push({
        ...chunk,
        ordinal: output.length,
        metadata: { ...chunk.metadata, symbolKind: "context" }
      });
    }
  };
  for (const symbol of valid) {
    if (symbol.lineStart > nextUncoveredLine) appendContext(nextUncoveredLine, symbol.lineStart - 1);
    const value = lines.slice(symbol.lineStart - 1, symbol.lineEnd).join("\n");
    if (value.length > MAX_CHARS) {
      for (const chunk of chunkLines(value, parserVersion, {
        lineStart: symbol.lineStart,
        symbol: symbol.name
      })) {
        output.push({
          ...chunk,
          ordinal: output.length,
          metadata: { ...chunk.metadata, symbolKind: symbol.kind }
        });
      }
    } else {
      output.push(
        makeChunk(
          value,
          output.length,
          { lineStart: symbol.lineStart, lineEnd: symbol.lineEnd, symbol: symbol.name },
          parserVersion,
          { symbolKind: symbol.kind }
        )
      );
    }
    nextUncoveredLine = Math.max(nextUncoveredLine, symbol.lineEnd + 1);
  }
  if (valid.length > 0 && nextUncoveredLine <= lines.length) appendContext(nextUncoveredLine, lines.length);
  return output.length > 0 ? output : chunkLines(text, parserVersion);
}

export class RegexCodeSymbolAdapter {
  readonly name = "builtin-regex-symbols";
  readonly version = "1.0.0";

  supports(): boolean {
    return true;
  }

  async extractSymbols(text: string, filename: string): Promise<SymbolRange[]> {
    const lines = text.split("\n");
    const python = /\.py$/i.test(filename);
    const starts: Array<{ name: string; kind: string; lineStart: number; indent: number }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const match = python
        ? /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_$][\w$]*)/.exec(line)
        : /^\s*(?:(?:export|public|private|protected|static|async|final|abstract)\s+)*(class|interface|enum|function|def|fn|func)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (match) {
        starts.push({
          name: python ? match[3] ?? "anonymous" : match[2] ?? "anonymous",
          kind: python ? match[2] ?? "symbol" : match[1] ?? "symbol",
          lineStart: index + 1,
          indent: python ? (match[1] ?? "").length : 0
        });
      }
    }
    return starts.map((start, index) => {
      let lineEnd = (starts[index + 1]?.lineStart ?? lines.length + 1) - 1;
      if (python) {
        for (let current = start.lineStart; current < lineEnd; current += 1) {
          const line = lines[current] ?? "";
          if (line.trim() && /^\s*/.exec(line)?.[0].length === 0 && start.indent === 0) {
            lineEnd = current;
            break;
          }
        }
      }
      return { name: start.name, kind: start.kind, lineStart: start.lineStart, lineEnd };
    });
  }
}
