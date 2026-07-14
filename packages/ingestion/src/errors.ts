export type IngestionErrorCode =
  | "FILE_TOO_LARGE"
  | "MESSAGE_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "MEDIA_TYPE_MISMATCH"
  | "INVALID_FILENAME"
  | "INVALID_ENCODING"
  | "MALFORMED_CONTENT"
  | "PARSER_LIMIT_EXCEEDED"
  | "ENCRYPTED_PDF"
  | "PDF_EXTRACTION_FAILED"
  | "OCR_UNAVAILABLE"
  | "OCR_FAILED"
  | "STORAGE_INTEGRITY_FAILED";

export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: IngestionErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "IngestionError";
    this.code = code;
    this.details = details;
  }
}
