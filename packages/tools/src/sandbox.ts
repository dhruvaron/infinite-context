import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { createToolEvidence, ToolError, ToolEvidenceSchema, type ToolEvidence, type ToolExecutionContext, type TypedTool } from "./core.js";

export const MAX_SANDBOX_WALL_MS = 10_000;
export const MAX_SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;
export const MAX_SANDBOX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MAX_SANDBOX_CODE_BYTES = 512 * 1024;
export const MAX_SANDBOX_STDIN_BYTES = 1024 * 1024;
const SANDBOX_READY_MARKER = "\u001eCONTINUUM_SANDBOX_READY_1\u001e";

export const SandboxInputSchema = z.object({
  language: z.enum(["javascript", "typescript", "python"]),
  code: z.string().refine((value) => Buffer.byteLength(value) <= MAX_SANDBOX_CODE_BYTES, "Code exceeds 512 KiB"),
  args: z.array(z.string().max(4_096).refine((value) => !value.includes("\0"))).max(32).default([]),
  stdin: z.string().refine((value) => Buffer.byteLength(value) <= MAX_SANDBOX_STDIN_BYTES, "stdin exceeds 1 MiB").default(""),
  wallTimeMs: z.number().int().min(100).max(MAX_SANDBOX_WALL_MS).default(MAX_SANDBOX_WALL_MS),
  memoryBytes: z.number().int().min(32 * 1024 * 1024).max(MAX_SANDBOX_MEMORY_BYTES).default(MAX_SANDBOX_MEMORY_BYTES),
  outputBytes: z.number().int().min(1_024).max(MAX_SANDBOX_OUTPUT_BYTES).default(MAX_SANDBOX_OUTPUT_BYTES)
});

export const SandboxExecutionResultSchema = z.object({
  status: z.enum(["completed", "failed", "timed_out", "output_limit", "memory_limit", "cancelled"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  peakMemoryBytes: z.number().int().nonnegative().nullable(),
  backend: z.enum(["macos-sandbox-exec", "linux-bubblewrap"])
});
export type SandboxExecutionResult = z.infer<typeof SandboxExecutionResultSchema>;

interface RuntimeCommand {
  executable: string;
  args: string[];
  scriptName: string;
  wrapperFiles: Array<{ name: string; content: string }>;
}

interface SandboxLaunch {
  backend: "macos-sandbox-exec" | "linux-bubblewrap";
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const PYTHON_EXECUTABLE_ALLOWLIST = [
  "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/Current/Resources/Python.app/Contents/MacOS/Python",
  "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/Current/Resources/Python.app/Contents/MacOS/Python",
  "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/Current/bin/python3",
  "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/Current/bin/python3",
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3"
] as const;

async function firstExecutable(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch { /* continue */ }
  }
  return undefined;
}

function escapeSandboxLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function ancestorMetadataRules(...paths: string[]): string {
  const ancestors = new Set<string>(["/"]);
  for (const path of paths) {
    // Callers pass trusted runtime/work directories. Include each directory
    // itself as well as its ancestors: SBPL `subpath` filters do not match the
    // root directory, and dyld must stat the framework version directory before
    // it can map a child library.
    ancestors.add(path);
    let current = dirname(path);
    while (current !== "/") {
      ancestors.add(current);
      current = dirname(current);
    }
  }
  return [...ancestors].sort((left, right) => left.length - right.length).map((path) => `(literal "${escapeSandboxLiteral(path)}")`).join("\n  ");
}

function ancestorDirectoryDataRules(...paths: string[]): string {
  // sandbox-exec does not consistently match the filesystem root with a
  // `literal` filter for directory enumeration, so use an anchored regex for
  // that one path. Every other permitted directory remains an exact literal.
  return ancestorMetadataRules(...paths).replace('(literal "/")', '(literal "/")\n  (regex #"^/$")');
}

async function runtimeFor(
  language: z.infer<typeof SandboxInputSchema>["language"],
  workDirectory: string,
  memoryBytes: number,
  wallTimeMs: number,
  userArgs: readonly string[]
): Promise<RuntimeCommand> {
  if (language === "javascript" || language === "typescript") {
    const executable = await realpath(process.execPath);
    if (basename(executable) !== "node") throw new ToolError("SANDBOX_UNAVAILABLE", "The active Node executable is not trusted.");
    const scriptName = language === "typescript" ? "main.ts" : "main.mjs";
    const runnerName = "runner.mjs";
    const runner = `process.stderr.write(${JSON.stringify(SANDBOX_READY_MARKER)});\nawait import(new URL(${JSON.stringify(`./${scriptName}`)}, import.meta.url).href);\n`;
    const args = [
      `--max-old-space-size=${Math.max(16, Math.floor(memoryBytes / 1024 / 1024) - 32)}`,
      "--disable-proto=throw",
      "--no-addons",
      "--permission",
      `--allow-fs-read=${workDirectory}`,
      `--allow-fs-write=${workDirectory}`,
      ...(language === "typescript" ? ["--experimental-strip-types"] : []),
      join(workDirectory, runnerName),
      "--",
      ...userArgs
    ];
    return { executable, args, scriptName, wrapperFiles: [{ name: runnerName, content: runner }] };
  }
  const executable = await firstExecutable(PYTHON_EXECUTABLE_ALLOWLIST);
  if (!executable) throw new ToolError("SANDBOX_UNAVAILABLE", "No allowlisted Python runtime is installed.");
  const wrapper = [
    "import os, resource, runpy, sys",
    `memory = ${memoryBytes}`,
    `cpu = ${Math.max(1, Math.ceil(wallTimeMs / 1000))}`,
    // macOS reports an unchangeable RLIMIT_AS sentinel to this system Python;
    // the parent process enforces the same hard RSS ceiling on every runtime.
    // Linux retains the additional in-process address-space boundary.
    "if sys.platform != 'darwin': resource.setrlimit(resource.RLIMIT_AS, (memory, memory))",
    "resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))",
    `resource.setrlimit(resource.RLIMIT_FSIZE, (${MAX_SANDBOX_OUTPUT_BYTES}, ${MAX_SANDBOX_OUTPUT_BYTES}))`,
    `work = ${JSON.stringify(workDirectory)}`,
    "runtime = os.path.abspath(sys.base_prefix)",
    "def audit(event, args):",
    "    if event == 'open' and args and isinstance(args[0], (str, bytes, os.PathLike)):",
    // The OS profile is the symlink-safe filesystem boundary. Keep the Python
    // audit hook as an independent lexical capability check without calling
    // realpath(), which makes Apple's Python enumerate `/` during startup and
    // would require an unsafe host-wide file-read-data grant.
    "        path = os.path.abspath(os.fsdecode(args[0]))",
    "        if path != work and not path.startswith(work + os.sep) and path != runtime and not path.startswith(runtime + os.sep):",
    "            raise PermissionError('sandbox filesystem boundary')",
    "    if event.startswith(('socket.', 'subprocess.', 'os.spawn', 'posix.spawn')) or event in ('os.system', 'ctypes.dlopen'):",
    "        raise PermissionError('sandbox capability denied')",
    "sys.addaudithook(audit)",
    `sys.stderr.write(${JSON.stringify(SANDBOX_READY_MARKER)})`,
    "sys.stderr.flush()",
    "sys.argv = ['main.py'] + sys.argv[1:]",
    "runpy.run_path('main.py', run_name='__main__')"
  ].join("\n");
  return {
    executable,
    args: ["-I", "-S", join(workDirectory, "runner.py"), ...userArgs],
    scriptName: "main.py",
    wrapperFiles: [{ name: "runner.py", content: wrapper }]
  };
}

async function macosLaunch(runtime: RuntimeCommand, workDirectory: string): Promise<SandboxLaunch> {
  const sandboxExecutable = "/usr/bin/sandbox-exec";
  await access(sandboxExecutable, constants.X_OK);
  const runtimeRoot = dirname(runtime.executable);
  // Apple's Command Line Tools ship Python in `Python3.framework`, while
  // python.org builds use `Python.framework`. In both cases the runtime needs
  // its whole version prefix (stdlib, encodings, and extension modules), not
  // merely the `bin` directory containing the executable.
  const pythonFramework = /\/Python3?\.framework\/Versions\/(\d+\.\d+)\//.exec(runtime.executable);
  const runtimeDistributionRoot = pythonFramework
    ? runtime.executable.slice(0, (pythonFramework.index ?? 0) + pythonFramework[0].length - 1)
    : runtimeRoot;
  const sitePackages = pythonFramework
    ? join(runtimeDistributionRoot, "lib", `python${pythonFramework[1]}`, "site-packages")
    : undefined;
  // Dynamic runtime loaders enumerate their exact ancestor directories while
  // resolving the executable/stdlib. Grant directory-data reads only on those
  // literal ancestors; this does not grant reads to sibling file contents.
  const runtimeAncestorDirectoryReads = basename(runtime.executable) === "node" || pythonFramework
    ? `(allow file-read-data\n  ${ancestorDirectoryDataRules(runtimeDistributionRoot, workDirectory)})`
    : "";
  const profile = `(version 1)
(deny default)
(deny network*)
(allow process-info* (target self))
(allow sysctl-read)
(allow signal (target self))
(allow process-exec (literal "${escapeSandboxLiteral(runtime.executable)}"))
(allow file-map-executable
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "${escapeSandboxLiteral(runtimeDistributionRoot)}")
  (subpath "${escapeSandboxLiteral(workDirectory)}"))
(allow file-read-metadata
  ${ancestorMetadataRules(runtimeDistributionRoot, workDirectory)})
${runtimeAncestorDirectoryReads}
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/private/var/db/dyld")
  (subpath "${escapeSandboxLiteral(runtimeDistributionRoot)}")
  (subpath "${escapeSandboxLiteral(workDirectory)}")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "/etc/localtime"))
(allow file-write* (subpath "${escapeSandboxLiteral(workDirectory)}"))
${sitePackages ? `(deny file-read* (subpath "${escapeSandboxLiteral(sitePackages)}"))` : ""}`;
  const profilePath = join(workDirectory, "sandbox.sb");
  await writeFile(profilePath, profile, { mode: 0o600, flag: "wx" });
  return {
    backend: "macos-sandbox-exec",
    executable: sandboxExecutable,
    args: ["-f", profilePath, runtime.executable, ...runtime.args],
    cwd: workDirectory,
    env: minimalEnvironment(workDirectory)
  };
}

async function linuxLaunch(runtime: RuntimeCommand, workDirectory: string): Promise<SandboxLaunch> {
  const bwrap = "/usr/bin/bwrap";
  await access(bwrap, constants.X_OK);
  const args = [
    "--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/work", "--bind", workDirectory, "/work",
    "--ro-bind", "/usr", "/usr"
  ];
  for (const root of ["/lib", "/lib64", "/bin", "/sbin", "/System", "/Library"]) {
    try { await access(root); args.push("--ro-bind", root, root); } catch { /* absent */ }
  }
  if (!runtime.executable.startsWith("/usr/") && !runtime.executable.startsWith("/bin/")) {
    args.push("--ro-bind", dirname(runtime.executable), dirname(runtime.executable));
  }
  const mappedArgs = runtime.args.map((argument) => argument.startsWith(`${workDirectory}/`) ? `/work/${argument.slice(workDirectory.length + 1)}` : argument);
  args.push("--chdir", "/work", "--", runtime.executable, ...mappedArgs);
  return {
    backend: "linux-bubblewrap",
    executable: bwrap,
    args,
    cwd: workDirectory,
    env: minimalEnvironment("/work")
  };
}

function minimalEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    TMPDIR: home,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_PROXY: "*",
    no_proxy: "*",
    PYTHONNOUSERSITE: "1",
    NODE_NO_WARNINGS: "1"
  };
}

async function rssBytes(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const kib = Number(/VmRSS:\s+(\d+)\s+kB/.exec(status)?.[1]);
      return Number.isFinite(kib) ? kib * 1024 : undefined;
    } catch { return undefined; }
  }
  if (process.platform !== "darwin") return undefined;
  return new Promise((resolveResult) => {
    const child = spawn("/bin/ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { if (output.length < 100) output += chunk.toString("ascii"); });
    child.on("error", () => resolveResult(undefined));
    child.on("close", () => {
      const kib = Number(output.trim());
      resolveResult(Number.isFinite(kib) ? kib * 1024 : undefined);
    });
  });
}

function killProcessGroup(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
}

export class IsolatedSandbox {
  readonly #temporaryRoot: string;

  constructor(temporaryRoot = tmpdir()) {
    this.#temporaryRoot = temporaryRoot;
  }

  async execute(raw: z.input<typeof SandboxInputSchema>, signal?: AbortSignal): Promise<SandboxExecutionResult> {
    const input = SandboxInputSchema.parse(raw);
    signal?.throwIfAborted();
    const createdDirectory = await mkdtemp(join(this.#temporaryRoot, "continuum-sandbox-"));
    const workDirectory = await realpath(createdDirectory);
    await chmod(workDirectory, 0o700);
    const started = performance.now();
    try {
      const runtime = await runtimeFor(input.language, workDirectory, input.memoryBytes, input.wallTimeMs, input.args);
      await writeFile(join(workDirectory, runtime.scriptName), input.code, { mode: 0o600, flag: "wx" });
      for (const file of runtime.wrapperFiles) await writeFile(join(workDirectory, file.name), file.content, { mode: 0o600, flag: "wx" });
      let launch: SandboxLaunch;
      try {
        launch = process.platform === "darwin"
          ? await macosLaunch(runtime, workDirectory)
          : process.platform === "linux"
            ? await linuxLaunch(runtime, workDirectory)
            : (() => { throw new ToolError("SANDBOX_UNAVAILABLE", "No secure sandbox backend exists for this platform."); })();
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("SANDBOX_UNAVAILABLE", "Required OS sandbox backend is unavailable.");
      }
      return await this.#run(launch, input, started, signal);
    } finally {
      await rm(workDirectory, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  async #run(
    launch: SandboxLaunch,
    input: z.infer<typeof SandboxInputSchema>,
    started: number,
    abortSignal?: AbortSignal
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolveResult, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(launch.executable, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false
        });
      } catch {
        reject(new ToolError("SANDBOX_FAILED", "Sandbox process failed to start."));
        return;
      }
      let status: SandboxExecutionResult["status"] | undefined;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let total = 0;
      let peakMemory = 0;
      let monitoring = false;
      const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        const remaining = Math.max(0, input.outputBytes - total);
        const retained = chunk.subarray(0, remaining);
        if (stream === "stdout") {
          stdoutChunks.push(retained);
          stdoutBytes += retained.length;
        } else {
          stderrChunks.push(retained);
          stderrBytes += retained.length;
        }
        total += chunk.length;
        if (total > input.outputBytes && !status) {
          status = "output_limit";
          killProcessGroup(child);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      // A short-lived program can exit successfully before Node finishes
      // flushing a large stdin payload. The resulting EPIPE belongs to the
      // already-closing input pipe; the child exit status below remains the
      // authoritative execution result. Always attach the listener before
      // `end` so this normal race can never become an unhandled process error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.stdin);
      const timer = setTimeout(() => {
        if (!status) status = "timed_out";
        killProcessGroup(child);
      }, input.wallTimeMs);
      timer.unref();
      const memoryTimer = setInterval(async () => {
        if (monitoring || !child.pid) return;
        monitoring = true;
        const current = await rssBytes(child.pid);
        monitoring = false;
        if (current !== undefined) {
          peakMemory = Math.max(peakMemory, current);
          if (current > input.memoryBytes && !status) {
            status = "memory_limit";
            killProcessGroup(child);
          }
        }
      }, 100);
      memoryTimer.unref();
      const onAbort = (): void => {
        if (!status) status = "cancelled";
        killProcessGroup(child);
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => {
        clearTimeout(timer);
        clearInterval(memoryTimer);
        abortSignal?.removeEventListener("abort", onAbort);
        reject(new ToolError("SANDBOX_FAILED", "Sandbox process failed."));
      });
      child.on("close", (exitCode, exitSignal) => {
        clearTimeout(timer);
        clearInterval(memoryTimer);
        abortSignal?.removeEventListener("abort", onAbort);
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
        const stderr = Buffer.concat(stderrChunks, stderrBytes);
        const stderrText = stderr.toString("utf8");
        const runtimeReady = stderrText.includes(SANDBOX_READY_MARKER);
        if (
          launch.backend === "macos-sandbox-exec" &&
          exitCode === 71 &&
          stderr.toString("utf8").includes("sandbox_apply")
        ) {
          reject(new ToolError("SANDBOX_UNAVAILABLE", "macOS refused to apply the sandbox profile; execution was not attempted."));
          return;
        }
        if (!runtimeReady) {
          reject(new ToolError(
            "SANDBOX_UNAVAILABLE",
            "The isolated runtime could not start under the OS sandbox; user code was not executed.",
            false,
            { exitCode, signal: exitSignal, runtimeDiagnostic: stderrText.slice(0, 1_024) }
          ));
          return;
        }
        const finalStatus = status ?? (exitCode === 0 ? "completed" : "failed");
        resolveResult(SandboxExecutionResultSchema.parse({
          status: finalStatus,
          exitCode,
          signal: exitSignal,
          stdout: stdout.toString("utf8"),
          stderr: stderrText.replace(SANDBOX_READY_MARKER, ""),
          truncated: finalStatus === "output_limit",
          durationMs: performance.now() - started,
          peakMemoryBytes: peakMemory || null,
          backend: launch.backend
        }));
      });
    });
  }
}

export class ExecuteCodeTool implements TypedTool<z.input<typeof SandboxInputSchema>, ToolEvidence> {
  readonly name = "execute_code";
  readonly description = "Execute JavaScript, TypeScript, or Python in a disposable, network-denied OS sandbox. No host workspace is mounted.";
  readonly inputSchema = SandboxInputSchema;
  readonly outputSchema = ToolEvidenceSchema;

  constructor(readonly sandbox: IsolatedSandbox) {}

  async execute(input: z.input<typeof SandboxInputSchema>, context: ToolExecutionContext): Promise<ToolEvidence> {
    const result = await this.sandbox.execute(input, context.signal);
    return createToolEvidence({
      content: JSON.stringify({ stdout: result.stdout, stderr: result.stderr }),
      provenance: [{ sourceId: context.toolCallId, sourceType: "sandbox", title: `${input.language} execution` }],
      truncated: result.truncated,
      metadata: {
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        peakMemoryBytes: result.peakMemoryBytes,
        backend: result.backend,
        network: "denied",
        packageInstallation: "denied",
        filesystem: "disposable"
      }
    });
  }
}
