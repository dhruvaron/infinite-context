import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IngestionError } from "./errors.js";
import type { OcrAdapter, OcrResult, OcrWord, PdfExtractorAdapter, PdfPageExtraction, PdfTextItem } from "./types.js";

const CLANG = "/usr/bin/clang";
const SOURCE = fileURLToPath(new URL("../scripts/macos-ingestion.m", import.meta.url));
const MAX_NATIVE_OUTPUT_BYTES = 64 * 1024 * 1024;
const NATIVE_TIMEOUT_MS = 120_000;

type NativeMode = "ocr" | "pdf" | "thumbnail";
export type NativeRunner = (input: {
  mode: NativeMode;
  bytes: Uint8Array;
  mediaType: string;
  page?: number;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type MacNativeIngestionStatus = {
  available: boolean;
  ocrEngine: "apple-vision" | "unavailable";
  pdfEngine: "pdfkit" | "builtin-fallback";
  reason?: string;
};

export function macNativeIngestionStatus(
  platform = process.platform,
  compilerExists = existsSync(CLANG),
  sourceExists = existsSync(SOURCE)
): MacNativeIngestionStatus {
  if (platform !== "darwin") {
    return { available: false, ocrEngine: "unavailable", pdfEngine: "builtin-fallback", reason: "Apple Vision and PDFKit require macOS." };
  }
  if (!compilerExists || !sourceExists) {
    return { available: false, ocrEngine: "unavailable", pdfEngine: "builtin-fallback", reason: "The bundled macOS ingestion runtime is unavailable." };
  }
  return { available: true, ocrEngine: "apple-vision", pdfEngine: "pdfkit" };
}

let nativeExecutablePromise: Promise<string> | undefined;

async function compileNativeExecutable(): Promise<string> {
  if (nativeExecutablePromise) return nativeExecutablePromise;
  nativeExecutablePromise = (async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-native-helper-"));
    const executable = join(directory, "continuum-native-ingestion");
    const moduleCache = join(directory, "module-cache");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(CLANG, [
        "-fobjc-arc", "-fblocks", `-fmodules-cache-path=${moduleCache}`,
        "-framework", "Foundation", "-framework", "Vision", "-framework", "PDFKit",
        "-framework", "ImageIO", "-framework", "CoreGraphics",
        SOURCE, "-o", executable
      ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      const stderr: Buffer[] = [];
      const timeout = setTimeout(() => { child.kill("SIGKILL"); rejectPromise(new IngestionError("OCR_UNAVAILABLE", "The local macOS extraction helper could not be prepared in time.")); }, 60_000);
      timeout.unref();
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 16_384) stderr.push(chunk); });
      child.on("error", () => { clearTimeout(timeout); rejectPromise(new IngestionError("OCR_UNAVAILABLE", "The macOS compiler could not be started.")); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolvePromise();
        else rejectPromise(new IngestionError("OCR_UNAVAILABLE", Buffer.concat(stderr).toString("utf8").trim().slice(0, 500) || "The local macOS extraction helper could not be compiled."));
      });
    });
    return executable;
  })();
  try { return await nativeExecutablePromise; }
  catch (error) { nativeExecutablePromise = undefined; throw error; }
}

/**
 * Performs the real compile probe used by the worker's runtime status. Merely
 * having clang and the bundled source on disk is not enough to claim that
 * Vision/PDFKit are ready on the installed macOS SDK.
 */
export async function prepareMacNativeIngestion(): Promise<MacNativeIngestionStatus> {
  const status = macNativeIngestionStatus();
  if (!status.available) return status;
  try {
    await compileNativeExecutable();
    return status;
  } catch (error) {
    return {
      available: false,
      ocrEngine: "unavailable",
      pdfEngine: "builtin-fallback",
      reason: error instanceof Error ? error.message.slice(0, 500) : "The bundled macOS ingestion runtime could not be prepared."
    };
  }
}

async function runNative(input: Parameters<NativeRunner>[0]): Promise<unknown> {
  const status = macNativeIngestionStatus();
  if (!status.available) throw new IngestionError("OCR_UNAVAILABLE", status.reason ?? "Native extraction is unavailable.");
  input.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "continuum-native-ingestion-"));
  const inputPath = join(directory, "input.bin");
  try {
    await writeFile(inputPath, input.bytes, { mode: 0o600 });
    const executable = await compileNativeExecutable();
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const child = spawn(executable, [input.mode, inputPath, input.mediaType, ...(input.page ? [String(input.page)] : [])], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? tmpdir(), TMPDIR: directory }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };
      const abort = () => {
        child.kill("SIGKILL");
        finish(Object.assign(new Error("Native ingestion was cancelled."), { name: "AbortError" }));
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new IngestionError(input.mode === "ocr" ? "OCR_FAILED" : "PDF_EXTRACTION_FAILED", "Native extraction exceeded its two-minute safety limit."));
      }, NATIVE_TIMEOUT_MS);
      timeout.unref();
      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_NATIVE_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(new IngestionError("PARSER_LIMIT_EXCEEDED", "Native extraction output exceeded its safety limit."));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 16_384) stderr.push(chunk);
      });
      child.on("error", () => finish(new IngestionError(input.mode === "ocr" ? "OCR_UNAVAILABLE" : "PDF_EXTRACTION_FAILED", "The macOS extraction helper could not be started.")));
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new IngestionError(input.mode === "ocr" ? "OCR_FAILED" : "PDF_EXTRACTION_FAILED", Buffer.concat(stderr).toString("utf8").trim().slice(0, 500) || "Native extraction failed."));
          return;
        }
        try { finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
        catch { finish(new IngestionError(input.mode === "ocr" ? "OCR_FAILED" : "PDF_EXTRACTION_FAILED", "Native extraction returned malformed output.")); }
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const MAX_PROVIDER_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PROVIDER_IMAGE_DIMENSION = 1_024;

/**
 * Produces a bounded, orientation-correct JPEG derivative for a provider call.
 * The content-addressed original remains untouched in local storage.
 */
export async function createMacProviderThumbnail(input: {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  signal?: AbortSignal;
}, runner: NativeRunner = runNative): Promise<{ bytes: Uint8Array; mediaType: "image/jpeg"; width: number; height: number }> {
  const raw = await runner({ mode: "thumbnail", ...input }) as Record<string, unknown>;
  if (!raw || raw.mediaType !== "image/jpeg" || typeof raw.base64 !== "string" || typeof raw.width !== "number" || typeof raw.height !== "number") {
    throw new IngestionError("PARSER_LIMIT_EXCEEDED", "The provider image derivative was malformed.");
  }
  const bytes = Buffer.from(raw.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROVIDER_IMAGE_BYTES) throw new IngestionError("PARSER_LIMIT_EXCEEDED", "The provider image derivative exceeded 2 MiB.");
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height) || raw.width < 1 || raw.height < 1 || raw.width > MAX_PROVIDER_IMAGE_DIMENSION || raw.height > MAX_PROVIDER_IMAGE_DIMENSION) {
    throw new IngestionError("PARSER_LIMIT_EXCEEDED", "The provider image derivative exceeded its dimension limit.");
  }
  return { bytes, mediaType: "image/jpeg", width: raw.width, height: raw.height };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class MacVisionOcrAdapter implements OcrAdapter {
  readonly #runner: NativeRunner;

  constructor(runner: NativeRunner = runNative) { this.#runner = runner; }

  async recognize(input: { bytes: Uint8Array; mediaType: string; page?: number; signal?: AbortSignal }): Promise<OcrResult> {
    const raw = await this.#runner({ mode: "ocr", ...input }) as Record<string, unknown>;
    if (!raw || typeof raw.text !== "string" || typeof raw.engine !== "string") {
      throw new IngestionError("OCR_FAILED", "Apple Vision returned an invalid OCR result.");
    }
    const words = Array.isArray(raw.words) ? raw.words.slice(0, 250_000).flatMap((value): OcrWord[] => {
      if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).text !== "string") return [];
      const word = value as Record<string, unknown>;
      const parsed: OcrWord = { text: String(word.text) };
      const confidence = finite(word.confidence);
      const page = finite(word.page);
      const x = finite(word.x);
      const y = finite(word.y);
      const width = finite(word.width);
      const height = finite(word.height);
      if (confidence !== undefined) parsed.confidence = confidence;
      if (page !== undefined) parsed.page = page;
      if (x !== undefined) parsed.x = x;
      if (y !== undefined) parsed.y = y;
      if (width !== undefined) parsed.width = width;
      if (height !== undefined) parsed.height = height;
      return [parsed];
    }) : undefined;
    return {
      text: raw.text.slice(0, 32 * 1024 * 1024),
      engine: raw.engine,
      ...(typeof raw.engineVersion === "string" ? { engineVersion: raw.engineVersion.slice(0, 200) } : {}),
      ...(words ? { words } : {})
    };
  }
}

export class MacPdfKitExtractor implements PdfExtractorAdapter {
  readonly name = "macos-pdfkit";
  readonly version = "1.0.0";
  readonly #runner: NativeRunner;

  constructor(runner: NativeRunner = runNative) { this.#runner = runner; }

  async extract(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfPageExtraction[]> {
    const raw = await this.#runner({ mode: "pdf", bytes, mediaType: "application/pdf", ...(signal ? { signal } : {}) });
    if (!Array.isArray(raw)) throw new IngestionError("PDF_EXTRACTION_FAILED", "PDFKit returned an invalid document result.");
    return raw.slice(0, 10_000).map((value, index) => {
      if (!value || typeof value !== "object") throw new IngestionError("PDF_EXTRACTION_FAILED", "PDFKit returned an invalid page result.");
      const page = value as Record<string, unknown>;
      const pageNumber = Number(page.page);
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || typeof page.text !== "string") throw new IngestionError("PDF_EXTRACTION_FAILED", "PDFKit returned malformed page content.");
      const items = Array.isArray(page.items) ? page.items.slice(0, 200_000).flatMap((item): PdfTextItem[] => {
        if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).text !== "string") return [];
        const record = item as Record<string, unknown>;
        const parsed: PdfTextItem = { text: String(record.text) };
        const x = finite(record.x);
        const y = finite(record.y);
        const width = finite(record.width);
        const height = finite(record.height);
        if (x !== undefined) parsed.x = x;
        if (y !== undefined) parsed.y = y;
        if (width !== undefined) parsed.width = width;
        if (height !== undefined) parsed.height = height;
        return [parsed];
      }) : [];
      return { page: pageNumber || index + 1, text: page.text, items };
    });
  }
}

export function createMacNativeIngestionAdapters(): {
  status: MacNativeIngestionStatus;
  ocr?: OcrAdapter;
  pdfExtractor?: PdfExtractorAdapter;
} {
  const status = macNativeIngestionStatus();
  if (!status.available) return { status };
  return { status, ocr: new MacVisionOcrAdapter(), pdfExtractor: new MacPdfKitExtractor() };
}
