import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { z } from "zod";
import { createToolEvidence, ToolError, ToolEvidenceSchema, type ToolEvidence, type ToolExecutionContext, type TypedTool } from "./core.js";

export const DEFAULT_MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_WORKSPACE_READ_BYTES = 2 * 1024 * 1024;
export const MAX_WORKSPACE_SEARCH_FILES = 5_000;

function providerSafeWorkspaceUri(rootId: string, relativePath = "."): string {
  const path = normalizeRelativePath(relativePath);
  const encoded = path === "." ? "" : path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `continuum-workspace://${rootId}/${encoded}`;
}

export const WorkspaceAuthorizationSchema = z.object({
  id: z.string().uuid(),
  requestedRoot: z.string().min(1),
  canonicalRoot: z.string().min(1),
  authorizedAt: z.string().datetime(),
  status: z.enum(["authorized", "missing", "reauthorization_required"])
});
export type WorkspaceAuthorization = z.infer<typeof WorkspaceAuthorizationSchema>;

export interface WorkspaceAuthorizationRegistry {
  get(id: string): Promise<WorkspaceAuthorization | undefined>;
}

export class InMemoryWorkspaceAuthorizationRegistry implements WorkspaceAuthorizationRegistry {
  readonly #roots = new Map<string, WorkspaceAuthorization>();

  constructor(records: readonly WorkspaceAuthorization[] = []) {
    for (const record of records) this.#roots.set(record.id, WorkspaceAuthorizationSchema.parse(record));
  }

  async authorize(root: string): Promise<WorkspaceAuthorization> {
    const requestedRoot = resolve(root);
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(requestedRoot);
      const info = await stat(canonicalRoot);
      if (!info.isDirectory()) throw new ToolError("INVALID_ARGUMENT", "Authorized workspace root is not a directory.");
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("NOT_FOUND", "Workspace root does not exist.");
    }
    const record = WorkspaceAuthorizationSchema.parse({
      id: randomUUID(),
      requestedRoot,
      canonicalRoot,
      authorizedAt: new Date().toISOString(),
      status: "authorized"
    });
    this.#roots.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<WorkspaceAuthorization | undefined> {
    return this.#roots.get(id);
  }

  records(): WorkspaceAuthorization[] {
    return [...this.#roots.values()];
  }
}

export interface SensitiveWorkspaceApproval {
  approve(input: {
    rootId: string;
    relativePath: string;
    reason: "likely_secret";
    context: ToolExecutionContext;
  }): Promise<boolean>;
}

const RelativePathSchema = z.string().max(4_096).default(".");
const CommonInput = {
  rootId: z.string().uuid(),
  path: RelativePathSchema,
  includeHidden: z.boolean().default(false),
  includeIgnored: z.boolean().default(false),
  includeDependencies: z.boolean().default(false)
};

export const WorkspaceListInputSchema = z.object({
  ...CommonInput,
  recursive: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(10).default(2),
  limit: z.number().int().min(1).max(5_000).default(500)
});
export const WorkspaceReadInputSchema = z.object({
  ...CommonInput,
  allowLikelySecret: z.boolean().default(false),
  allowLargeFile: z.boolean().default(false),
  byteOffset: z.number().int().nonnegative().default(0),
  byteLength: z.number().int().positive().max(MAX_WORKSPACE_READ_BYTES).default(256 * 1024)
});
export const WorkspaceSearchInputSchema = z.object({
  ...CommonInput,
  query: z.string().min(1).max(10_000),
  caseSensitive: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(20).default(8),
  maxFiles: z.number().int().min(1).max(MAX_WORKSPACE_SEARCH_FILES).default(1_000),
  limit: z.number().int().min(1).max(1_000).default(100)
});

const ALWAYS_BLOCKED_SEGMENTS = new Set([".git"]);
const DEPENDENCY_SEGMENTS = new Set([
  "node_modules", "vendor", "bower_components", ".pnpm", ".yarn", ".next", ".nuxt",
  "dist", "build", "coverage", "target", "out", ".cache", "__pycache__", ".venv", "venv"
]);
const LIKELY_SECRET_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials(?:\..+)?$/i,
  /^secrets?(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|p12|pfx|key|keystore|jks)$/i,
  /^credentials$/i,
  /(?:^|[-_.])(?:secret|token|credential|api[-_]?key)(?:[-_.]|$)/i
];

function normalizeRelativePath(path: string): string {
  if (path.includes("\0") || isAbsolute(path) || path.includes("\\")) {
    throw new ToolError("BOUNDARY_VIOLATION", "Workspace paths must be relative and portable.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) throw new ToolError("BOUNDARY_VIOLATION", "Workspace path traversal is not allowed.");
  return segments.filter((segment) => segment && segment !== ".").join("/") || ".";
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") && segment !== ".");
}

function hasBlockedSegment(path: string): boolean {
  return path.split("/").some((segment) => ALWAYS_BLOCKED_SEGMENTS.has(segment));
}

function hasDependencySegment(path: string): boolean {
  return path.split("/").some((segment) => DEPENDENCY_SEGMENTS.has(segment));
}

export function isLikelySecretPath(path: string): boolean {
  const name = basename(path);
  return LIKELY_SECRET_PATTERNS.some((pattern) => pattern.test(name)) || /(?:^|\/)\.aws(?:\/|$)/i.test(path) || /(?:^|\/)\.ssh(?:\/|$)/i.test(path);
}

type IgnoreMatcher = ReturnType<typeof ignore>;

interface DirectoryIgnoreRules {
  directory: string;
  matcher: IgnoreMatcher;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Resolves Git ignore policy in the same order Git discovers it while walking a
 * worktree. A nested .gitignore is considered only after its directory has
 * survived every ancestor rule, so it cannot re-include a file whose parent is
 * excluded. Instances are scoped to one tool operation so ignore files are
 * cached during large walks without making their contents stale across calls.
 */
class WorkspaceIgnorePolicy {
  readonly #root: string;
  readonly #directoryRules = new Map<string, Promise<DirectoryIgnoreRules | undefined>>();

  constructor(root: string) {
    this.#root = root;
  }

  async isIgnored(relativePath: string, targetIsDirectory: boolean): Promise<boolean> {
    if (relativePath === ".") return false;
    const segments = relativePath.split("/");
    const activeRules: DirectoryIgnoreRules[] = [];
    const rootRules = await this.#rulesForDirectory("");
    if (rootRules) activeRules.push(rootRules);

    for (let index = 0; index < segments.length; index += 1) {
      const rootRelativePath = segments.slice(0, index + 1).join("/");
      const isDirectory = index < segments.length - 1 || targetIsDirectory;
      let ignored = false;

      for (const rules of activeRules) {
        const matcherRelativePath = rules.directory
          ? rootRelativePath.slice(rules.directory.length + 1)
          : rootRelativePath;
        const result = rules.matcher.test(`${matcherRelativePath}${isDirectory ? "/" : ""}`);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }

      if (ignored) return true;

      // Rules inside a directory affect only its descendants, never the
      // directory entry itself. More importantly, this file is never opened
      // when an ancestor excluded the directory above.
      if (isDirectory && index < segments.length - 1) {
        const nestedRules = await this.#rulesForDirectory(rootRelativePath);
        if (nestedRules) activeRules.push(nestedRules);
      }
    }

    return false;
  }

  #rulesForDirectory(directory: string): Promise<DirectoryIgnoreRules | undefined> {
    const cached = this.#directoryRules.get(directory);
    if (cached) return cached;
    const loading = this.#loadRules(directory);
    this.#directoryRules.set(directory, loading);
    return loading;
  }

  async #loadRules(directory: string): Promise<DirectoryIgnoreRules | undefined> {
    const ignorePath = join(this.#root, directory, ".gitignore");
    let expected: Stats;
    try {
      expected = await lstat(ignorePath);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw new ToolError("NOT_AUTHORIZED", "Workspace ignore policy could not be verified.");
    }

    if (expected.isSymbolicLink() || !expected.isFile()) {
      throw new ToolError("NOT_AUTHORIZED", "Workspace ignore policy must be a regular file.");
    }

    let handle: FileHandle;
    try {
      handle = await open(ignorePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new ToolError("NOT_AUTHORIZED", "Workspace ignore policy could not be opened safely.");
    }

    let contents: string;
    try {
      const actual = await handle.stat({ bigint: false });
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new ToolError("NOT_AUTHORIZED", "Workspace ignore policy changed while it was being read.");
      }
      contents = new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("NOT_AUTHORIZED", "Workspace ignore policy could not be read safely.");
    } finally {
      await handle.close();
    }

    return { directory, matcher: ignore({ ignorecase: false }).add(contents) };
  }
}

interface ResolvedWorkspacePath {
  root: WorkspaceAuthorization;
  relativePath: string;
  absolutePath: string;
}

export class WorkspaceReader {
  readonly #registry: WorkspaceAuthorizationRegistry;
  readonly #sensitiveApproval: SensitiveWorkspaceApproval | undefined;

  constructor(registry: WorkspaceAuthorizationRegistry, sensitiveApproval?: SensitiveWorkspaceApproval) {
    this.#registry = registry;
    this.#sensitiveApproval = sensitiveApproval;
  }

  tools(): readonly TypedTool<unknown, ToolEvidence>[] {
    return [
      {
        name: "workspace_list",
        description: "List files beneath an explicitly authorized read-only workspace root.",
        inputSchema: WorkspaceListInputSchema as z.ZodType<unknown>,
        outputSchema: ToolEvidenceSchema,
        execute: (input, context) => this.list(WorkspaceListInputSchema.parse(input), context)
      },
      {
        name: "workspace_read",
        description: "Read a bounded UTF-8 range from an explicitly authorized workspace file.",
        inputSchema: WorkspaceReadInputSchema as z.ZodType<unknown>,
        outputSchema: ToolEvidenceSchema,
        execute: (input, context) => this.read(WorkspaceReadInputSchema.parse(input), context)
      },
      {
        name: "workspace_search",
        description: "Search bounded UTF-8 files under an explicitly authorized workspace root.",
        inputSchema: WorkspaceSearchInputSchema as z.ZodType<unknown>,
        outputSchema: ToolEvidenceSchema,
        execute: (input, context) => this.search(WorkspaceSearchInputSchema.parse(input), context)
      }
    ];
  }

  async list(input: z.infer<typeof WorkspaceListInputSchema>, context: ToolExecutionContext): Promise<ToolEvidence> {
    void context;
    const resolved = await this.#resolve(input.rootId, input.path);
    const info = await stat(resolved.absolutePath);
    if (!info.isDirectory()) throw new ToolError("INVALID_ARGUMENT", "Workspace list target is not a directory.");
    const ignorePolicy = input.includeIgnored ? undefined : new WorkspaceIgnorePolicy(resolved.root.canonicalRoot);
    const output: Array<{ path: string; type: "file" | "directory" | "symlink"; size?: number }> = [];
    let truncated = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (output.length >= input.limit) {
          truncated = true;
          return;
        }
        const absolute = join(directory, entry.name);
        const rel = relative(resolved.root.canonicalRoot, absolute).split(sep).join("/");
        if (!(await this.#allowed(resolved.root.canonicalRoot, rel, input, entry.isDirectory(), ignorePolicy))) continue;
        if (entry.isSymbolicLink()) {
          try {
            const real = await realpath(absolute);
            if (!isInside(resolved.root.canonicalRoot, real)) continue;
          } catch { continue; }
        }
        const type = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
        const entryStat = entry.isFile() ? await stat(absolute) : undefined;
        output.push({ path: rel, type, ...(entryStat ? { size: entryStat.size } : {}) });
        if (input.recursive && depth < input.maxDepth && entry.isDirectory()) await visit(absolute, depth + 1);
      }
    };
    await visit(resolved.absolutePath, 0);
    return createToolEvidence({
      content: JSON.stringify(output),
      provenance: [{ sourceId: input.rootId, sourceType: "workspace", title: "Authorized workspace", uri: providerSafeWorkspaceUri(input.rootId, resolved.relativePath) }],
      truncated,
      metadata: { entryCount: output.length, readOnly: true }
    });
  }

  async read(input: z.infer<typeof WorkspaceReadInputSchema>, context: ToolExecutionContext): Promise<ToolEvidence> {
    const resolved = await this.#resolve(input.rootId, input.path);
    const ignorePolicy = input.includeIgnored ? undefined : new WorkspaceIgnorePolicy(resolved.root.canonicalRoot);
    if (!(await this.#allowed(resolved.root.canonicalRoot, resolved.relativePath, input, false, ignorePolicy))) throw new ToolError("NOT_AUTHORIZED", "Workspace path is excluded by policy.");
    const sensitiveContent = isLikelySecretPath(resolved.relativePath);
    if (sensitiveContent) {
      const approved = input.allowLikelySecret && this.#sensitiveApproval
        ? await this.#sensitiveApproval.approve({ rootId: input.rootId, relativePath: resolved.relativePath, reason: "likely_secret", context })
        : false;
      if (!approved) throw new ToolError("SECRET_BLOCKED", "Likely-secret files require explicit user approval.");
    }
    const verified = await this.#openVerified(resolved.root.canonicalRoot, resolved.absolutePath);
    const info = verified.info;
    if (info.size > DEFAULT_MAX_WORKSPACE_FILE_BYTES && !input.allowLargeFile) {
      await verified.handle.close();
      throw new ToolError("LIMIT_EXCEEDED", "Files over 2 MB require an explicit bounded large-file read.", false, { size: info.size });
    }
    const byteLength = Math.min(input.byteLength, Math.max(0, info.size - input.byteOffset));
    const buffer = Buffer.alloc(byteLength);
    try {
      await verified.handle.read(buffer, 0, byteLength, input.byteOffset);
    } finally {
      await verified.handle.close();
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ToolError("UNSUPPORTED", "Workspace reads support UTF-8 text only.");
    }
    const nextOffset = input.byteOffset + byteLength;
    const truncated = nextOffset < info.size;
    return createToolEvidence({
      content,
      provenance: [{
        sourceId: input.rootId,
        sourceType: "workspace",
        title: resolved.relativePath,
        uri: providerSafeWorkspaceUri(input.rootId, resolved.relativePath),
        location: { byteStart: input.byteOffset, byteEnd: nextOffset }
      }],
      truncated,
      nextCursor: truncated ? String(nextOffset) : null,
      metadata: { size: info.size, byteStart: input.byteOffset, byteEnd: nextOffset, readOnly: true, sensitiveContent }
    });
  }

  async search(input: z.infer<typeof WorkspaceSearchInputSchema>, context: ToolExecutionContext): Promise<ToolEvidence> {
    void context;
    const resolved = await this.#resolve(input.rootId, input.path);
    const rootInfo = await stat(resolved.absolutePath);
    if (!rootInfo.isDirectory()) throw new ToolError("INVALID_ARGUMENT", "Workspace search target is not a directory.");
    const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
    const ignorePolicy = input.includeIgnored ? undefined : new WorkspaceIgnorePolicy(resolved.root.canonicalRoot);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scannedFiles = 0;
    let truncated = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (matches.length >= input.limit || scannedFiles >= input.maxFiles) { truncated = true; return; }
        const absolute = join(directory, entry.name);
        const rel = relative(resolved.root.canonicalRoot, absolute).split(sep).join("/");
        if (!(await this.#allowed(resolved.root.canonicalRoot, rel, input, entry.isDirectory(), ignorePolicy)) || isLikelySecretPath(rel)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth < input.maxDepth) await visit(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        scannedFiles += 1;
        let verified: { handle: FileHandle; info: Stats };
        try { verified = await this.#openVerified(resolved.root.canonicalRoot, absolute); } catch { continue; }
        const info = verified.info;
        if (info.size > DEFAULT_MAX_WORKSPACE_FILE_BYTES) {
          await verified.handle.close();
          continue;
        }
        let text: string;
        try {
          const buffer = await verified.handle.readFile();
          text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        } catch { continue; }
        finally { await verified.handle.close(); }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const haystack = input.caseSensitive ? line : line.toLocaleLowerCase();
          if (haystack.includes(needle)) matches.push({ path: rel, line: index + 1, text: line.slice(0, 2_000) });
          if (matches.length >= input.limit) { truncated = true; return; }
        }
      }
    };
    await visit(resolved.absolutePath, 0);
    return createToolEvidence({
      content: JSON.stringify(matches),
      provenance: matches.map((match) => ({ sourceId: input.rootId, sourceType: "workspace", title: match.path, uri: providerSafeWorkspaceUri(input.rootId, match.path), location: { line: match.line } })),
      truncated,
      metadata: { matchCount: matches.length, scannedFiles, readOnly: true }
    });
  }

  async #resolve(rootId: string, rawPath: string): Promise<ResolvedWorkspacePath> {
    const root = await this.#registry.get(rootId);
    if (!root || root.status !== "authorized") throw new ToolError("NOT_AUTHORIZED", "Workspace root is not authorized.");
    let currentCanonical: string;
    try { currentCanonical = await realpath(root.requestedRoot); } catch { throw new ToolError("NOT_AUTHORIZED", "Workspace moved or disappeared and must be reauthorized."); }
    if (currentCanonical !== root.canonicalRoot) throw new ToolError("NOT_AUTHORIZED", "Workspace target changed and must be reauthorized.");
    const relativePath = normalizeRelativePath(rawPath);
    if (hasBlockedSegment(relativePath)) throw new ToolError("BOUNDARY_VIOLATION", ".git is never exposed to workspace tools.");
    const lexical = resolve(root.canonicalRoot, relativePath);
    if (!isInside(root.canonicalRoot, lexical)) throw new ToolError("BOUNDARY_VIOLATION", "Workspace path escaped its authorized root.");
    let absolutePath: string;
    try { absolutePath = await realpath(lexical); } catch { throw new ToolError("NOT_FOUND", "Workspace path does not exist."); }
    if (!isInside(root.canonicalRoot, absolutePath)) throw new ToolError("BOUNDARY_VIOLATION", "Workspace symlink escaped its authorized root.");
    return { root, relativePath, absolutePath };
  }

  async #openVerified(root: string, absolutePath: string): Promise<{
    handle: FileHandle;
    info: Stats;
  }> {
    const canonical = await realpath(absolutePath);
    if (!isInside(root, canonical)) throw new ToolError("BOUNDARY_VIOLATION", "Workspace file escaped its authorized root.");
    const expected = await lstat(canonical);
    if (!expected.isFile() || expected.isSymbolicLink()) throw new ToolError("INVALID_ARGUMENT", "Workspace target is not a regular file.");
    let handle: FileHandle;
    try {
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new ToolError("BOUNDARY_VIOLATION", "Workspace file changed during authorization.");
    }
    const actual = await handle.stat({ bigint: false });
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      await handle.close();
      throw new ToolError("BOUNDARY_VIOLATION", "Workspace file changed during authorization.");
    }
    return { handle, info: actual };
  }

  async #allowed(root: string, path: string, options: {
    includeHidden: boolean;
    includeIgnored: boolean;
    includeDependencies: boolean;
    allowLikelySecret?: boolean;
  }, targetIsDirectory: boolean, ignorePolicy: WorkspaceIgnorePolicy | undefined): Promise<boolean> {
    if (hasBlockedSegment(path)) return false;
    if (!options.includeHidden && hasHiddenSegment(path)) return false;
    if (!options.includeDependencies && hasDependencySegment(path)) return false;
    if (!options.allowLikelySecret && isLikelySecretPath(path)) return false;
    if (!options.includeIgnored && await (ignorePolicy ?? new WorkspaceIgnorePolicy(root)).isIgnored(path, targetIsDirectory)) return false;
    return true;
  }
}
