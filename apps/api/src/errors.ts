import type { FastifyInstance } from "fastify";
import { IngestionError } from "@continuum/ingestion";
import { ZodError } from "zod";

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (details) this.details = details;
  }
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({ error: { code: "NOT_FOUND", message: "That local resource was not found.", retryable: false, traceId: request.id } });
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      await reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Some submitted fields were invalid.",
          retryable: false,
          traceId: request.id,
          details: { fields: error.flatten().fieldErrors }
        }
      });
      return;
    }
    if (error instanceof AppError) {
      await reply.code(error.status).send({
        error: { code: error.code, message: error.message, retryable: error.retryable, traceId: request.id, ...(error.details ? { details: error.details } : {}) }
      });
      return;
    }
    if (error instanceof IngestionError) {
      const status = error.code === "FILE_TOO_LARGE" || error.code === "MESSAGE_TOO_LARGE" ? 413
        : error.code === "UNSUPPORTED_MEDIA_TYPE" || error.code === "MEDIA_TYPE_MISMATCH" ? 415
          : 400;
      await reply.code(status).send({
        error: { code: error.code, message: error.message, retryable: error.code === "OCR_UNAVAILABLE" || error.code === "OCR_FAILED", traceId: request.id, ...(error.details ? { details: error.details } : {}) }
      });
      return;
    }
    const unknownError = error instanceof Error ? error : new Error("Unknown request error");
    request.log.error({ err: { name: unknownError.name, message: unknownError.message } }, "request failed");
    await reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Continuum could not complete that request.", retryable: true, traceId: request.id } });
  });
}
