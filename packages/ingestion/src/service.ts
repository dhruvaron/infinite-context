import { AttachmentInputSchema, IngestedAttachmentSchema, type AttachmentInput, type CodeSymbolAdapter, type ExtractedDocument, type IngestedAttachment, type OcrAdapter, type PdfExtractorAdapter } from "./types.js";
import type { ContentAddressedStore } from "./content-store.js";
import { extractCsvDocument, extractJsonDocument, extractTextDocument } from "./text-extractors.js";
import { extractImageDocument } from "./image-extractor.js";
import { extractPdfDocument } from "./pdf-extractor.js";
import { isTextMediaType, validateAttachmentPolicy, validateMessageAttachments } from "./policy.js";
import { IngestionError } from "./errors.js";

export interface IngestionServiceOptions {
  store: ContentAddressedStore;
  ocr?: OcrAdapter;
  pdfExtractor?: PdfExtractorAdapter;
  symbolAdapters?: readonly CodeSymbolAdapter[];
  now?: () => Date;
}

export class IngestionService {
  readonly #store: ContentAddressedStore;
  readonly #ocr: OcrAdapter | undefined;
  readonly #pdfExtractor: PdfExtractorAdapter | undefined;
  readonly #symbolAdapters: readonly CodeSymbolAdapter[] | undefined;
  readonly #now: () => Date;

  constructor(options: IngestionServiceOptions) {
    this.#store = options.store;
    this.#ocr = options.ocr;
    this.#pdfExtractor = options.pdfExtractor;
    this.#symbolAdapters = options.symbolAdapters;
    this.#now = options.now ?? (() => new Date());
  }

  async ingest(input: AttachmentInput, signal?: AbortSignal): Promise<IngestedAttachment> {
    signal?.throwIfAborted();
    const validatedInput = AttachmentInputSchema.parse(input);
    const mediaType = validateAttachmentPolicy(validatedInput);
    // Persist the immutable original even if extraction later fails. The caller can
    // record a failed parse and retry with a newer parser without another upload.
    const stored = await this.#store.put(validatedInput.bytes);
    let document: ExtractedDocument;
    try {
      document = await this.#extract(validatedInput, mediaType, signal);
    } catch (error) {
      if (error instanceof IngestionError) {
        throw new IngestionError(error.code, error.message, {
          ...error.details,
          storedBlob: stored,
          extractionFailed: true
        });
      }
      throw error;
    }
    signal?.throwIfAborted();
    return IngestedAttachmentSchema.parse({
      id: validatedInput.id,
      sourceId: validatedInput.sourceId,
      filename: validatedInput.filename,
      mediaType,
      size: validatedInput.bytes.byteLength,
      status: "ready",
      createdAt: validatedInput.createdAt ?? this.#now().toISOString(),
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      parserVersion: document.parserVersion,
      chunkerVersion: document.chunkerVersion,
      extractedAt: this.#now().toISOString(),
      document
    });
  }

  async ingestMessage(inputs: readonly AttachmentInput[], signal?: AbortSignal): Promise<IngestedAttachment[]> {
    validateMessageAttachments(inputs);
    const results: IngestedAttachment[] = [];
    for (const input of inputs) results.push(await this.ingest(input, signal));
    return results;
  }

  async #extract(input: AttachmentInput, mediaType: string, signal?: AbortSignal) {
    if (mediaType === "application/json") return extractJsonDocument(input.bytes);
    if (mediaType === "text/csv") return extractCsvDocument(input.bytes);
    if (mediaType === "application/pdf") {
      return extractPdfDocument({
        bytes: input.bytes,
        ...(this.#pdfExtractor ? { extractor: this.#pdfExtractor } : {}),
        ...(this.#ocr ? { ocr: this.#ocr } : {}),
        ...(signal ? { signal } : {})
      });
    }
    if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp") {
      return extractImageDocument({
        bytes: input.bytes,
        mediaType,
        ...(this.#ocr ? { ocr: this.#ocr } : {}),
        ...(signal ? { signal } : {})
      });
    }
    if (isTextMediaType(mediaType)) {
      return extractTextDocument({
        bytes: input.bytes,
        mediaType,
        filename: input.filename,
        ...(this.#symbolAdapters ? { symbolAdapters: this.#symbolAdapters } : {})
      });
    }
    // Policy and dispatcher deliberately advance together. Reaching this branch is
    // a programmer error rather than a format downgrade.
    throw new Error(`No extractor registered for ${mediaType}`);
  }
}
