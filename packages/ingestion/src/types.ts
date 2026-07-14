import { AttachmentSchema, IdSchema, TimestampSchema } from "@continuum/contracts";
import { z } from "zod";

export const INGESTION_SCHEMA_VERSION = "1.0.0";
export const PARSER_VERSION = "continuum-ingestion/1.0.0";
export const CHUNKER_VERSION = "continuum-chunker/1.0.0";

export const SourceLocationSchema = z.object({
  page: z.number().int().positive().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  rowStart: z.number().int().positive().optional(),
  rowEnd: z.number().int().positive().optional(),
  columnStart: z.number().int().nonnegative().optional(),
  columnEnd: z.number().int().nonnegative().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  symbol: z.string().max(500).optional()
});

export const SourceChunkSchema = z.object({
  id: IdSchema.optional(),
  ordinal: z.number().int().nonnegative(),
  text: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  estimatedTokens: z.number().int().nonnegative(),
  location: SourceLocationSchema,
  parserVersion: z.string(),
  chunkerVersion: z.string(),
  metadata: z.record(z.unknown()).default({})
});

export const ExtractedDocumentSchema = z.object({
  mediaType: z.string(),
  title: z.string().optional(),
  text: z.string(),
  chunks: z.array(SourceChunkSchema),
  metadata: z.record(z.unknown()),
  warnings: z.array(z.string()),
  parserVersion: z.string(),
  chunkerVersion: z.string()
});

export const StoredBlobSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  deduplicated: z.boolean()
});

export const IngestedAttachmentSchema = AttachmentSchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageKey: z.string(),
  parserVersion: z.string(),
  chunkerVersion: z.string(),
  extractedAt: TimestampSchema,
  document: ExtractedDocumentSchema
});

export const AttachmentInputSchema = z.object({
  id: IdSchema,
  sourceId: IdSchema,
  filename: z.string().min(1).max(255),
  declaredMediaType: z.string().min(1).max(127),
  bytes: z.instanceof(Uint8Array),
  createdAt: TimestampSchema.optional()
});

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type SourceChunk = z.infer<typeof SourceChunkSchema>;
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;
export type StoredBlob = z.infer<typeof StoredBlobSchema>;
export type IngestedAttachment = z.infer<typeof IngestedAttachmentSchema>;
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export interface OcrWord {
  text: string;
  confidence?: number;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface OcrResult {
  text: string;
  words?: OcrWord[];
  engine: string;
  engineVersion?: string;
}

export interface OcrAdapter {
  recognize(input: {
    bytes: Uint8Array;
    mediaType: string;
    page?: number;
    signal?: AbortSignal;
  }): Promise<OcrResult>;
}

export interface PdfTextItem {
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface PdfPageExtraction {
  page: number;
  text: string;
  items?: PdfTextItem[];
  renderedImage?: Uint8Array;
}

export interface PdfExtractorAdapter {
  readonly name: string;
  readonly version: string;
  extract(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfPageExtraction[]>;
}

export interface SymbolRange {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
}

export interface CodeSymbolAdapter {
  readonly name: string;
  readonly version: string;
  supports(filename: string, mediaType: string): boolean;
  extractSymbols(text: string, filename: string): Promise<SymbolRange[]>;
}
