import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function compactKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
}

function isCredentialKey(key: string): boolean {
  const compact = compactKey(key);
  return compact === "authorization"
    || compact.includes("apikey")
    || compact.includes("password")
    || compact.includes("credential")
    || compact.includes("cookie")
    || compact === "token"
    || compact.endsWith("accesstoken")
    || compact.endsWith("refreshtoken")
    || compact.endsWith("sessiontoken")
    || compact.endsWith("secrettoken")
    || compact === "secret"
    || compact.endsWith("clientsecret");
}

function isContentKey(key: string): boolean {
  const compact = compactKey(key);
  return new Set([
    "prompt", "content", "contextcontent", "message", "messages", "body",
    "tooloutput", "messagearguments", "input"
  ]).has(compact);
}

function scrubCredentialPatterns(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(OPENAI_API_KEY|API_KEY|PASSWORD|ACCESS_TOKEN)\s*=\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function redact(value: unknown, key = "", allowPromptContent = false): unknown {
  if (isCredentialKey(key)) return "[REDACTED]";
  if (!allowPromptContent && isContentKey(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, "", allowPromptContent));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, allowPromptContent)]));
  }
  if (typeof value === "string") return scrubCredentialPatterns(value);
  return value;
}

export function redactLogFields(fields: Fields, promptTracingEnabled: boolean): Fields {
  return redact(fields, "", promptTracingEnabled) as Fields;
}

export class LocalLogger {
  readonly #logDir: string;
  readonly #maximumFileBytes: number;
  #tracePrompts: boolean;
  #promptTracingResolver: (() => boolean) | undefined;
  #pending: Promise<void> = Promise.resolve();
  #date = "";
  #fileIndex = 0;

  constructor(logDir: string, tracePrompts = false, maximumFileBytes = 20 * 1024 * 1024) {
    this.#logDir = logDir;
    this.#tracePrompts = tracePrompts;
    this.#maximumFileBytes = Math.max(1_024, maximumFileBytes);
  }

  setPromptTracing(enabled: boolean): void {
    this.#tracePrompts = enabled;
  }

  setPromptTracingResolver(resolver: (() => boolean) | undefined): void {
    this.#promptTracingResolver = resolver;
  }

  get promptTracingEnabled(): boolean {
    return this.#promptTracingEnabledNow();
  }

  debug(message: string, fields: Fields = {}) { this.#enqueue("debug", message, fields); }
  info(message: string, fields: Fields = {}) { this.#enqueue("info", message, fields); }
  warn(message: string, fields: Fields = {}) { this.#enqueue("warn", message, fields); }
  error(message: string, fields: Fields = {}) { this.#enqueue("error", message, fields); }

  async flush(): Promise<void> {
    await this.#pending;
  }

  async prune(retentionDays = 7, maximumBytes = 20 * 1024 * 1024): Promise<void> {
    await mkdir(this.#logDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#logDir);
    const cutoff = Date.now() - retentionDays * 86_400_000;
    await Promise.all(entries.filter((entry) => entry.endsWith(".jsonl")).map(async (entry) => {
      const path = join(this.#logDir, entry);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff || info.size > maximumBytes) await unlink(path);
      } catch (error) {
        // API and worker prune the shared directory concurrently at startup.
        // Losing the race to remove the same file is success; other I/O errors
        // remain visible so permission/corruption problems cannot be hidden.
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }));
  }

  #enqueue(level: LogLevel, message: string, fields: Fields): void {
    // Serialize local writes so line ordering and size rotation remain stable
    // even when streaming/tool callbacks log concurrently.
    this.#pending = this.#pending.then(() => this.#write(level, message, fields), () => this.#write(level, message, fields));
  }

  async #write(level: LogLevel, message: string, fields: Fields): Promise<void> {
    try {
      await mkdir(this.#logDir, { recursive: true, mode: 0o700 });
      const date = new Date();
      const day = date.toISOString().slice(0, 10);
      if (this.#date !== day) { this.#date = day; this.#fileIndex = 0; }
      let file = join(this.#logDir, `${day}-${process.pid}-${this.#fileIndex}.jsonl`);
      const info = await stat(file).catch(() => null);
      // A response may finish long after the request started. Resolve durable
      // consent after the asynchronous filesystem preparation and immediately
      // before append, so another process can revoke prompt tracing while that
      // response is still in flight.
      const safeFields = redactLogFields(fields, this.#promptTracingEnabledNow());
      const line = JSON.stringify({ timestamp: date.toISOString(), level, message, ...safeFields }) + "\n";
      if (info && info.size + Buffer.byteLength(line) > this.#maximumFileBytes) {
        this.#fileIndex += 1;
        file = join(this.#logDir, `${day}-${process.pid}-${this.#fileIndex}.jsonl`);
      }
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Logging must never take down the local application.
    }
  }

  #promptTracingEnabledNow(): boolean {
    if (!this.#promptTracingResolver) return this.#tracePrompts;
    try {
      return this.#promptTracingResolver() === true;
    } catch {
      // A consent lookup failure is a privacy-sensitive failure. Keep the log,
      // but redact prompt content until durable consent can be read again.
      return false;
    }
  }
}

export function userSafeError(error: unknown): { message: string; kind: string } {
  if (error instanceof Error) return { message: error.message, kind: error.name };
  return { message: "An unexpected error occurred.", kind: "UnknownError" };
}
