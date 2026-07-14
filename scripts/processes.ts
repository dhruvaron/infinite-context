import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; quiet?: boolean; cwd?: string } = {}): ChildProcess {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    shell: false
  });
  return child;
}

export function waitForExit(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
    });
  });
}

export async function availablePort(preferred: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: preferred }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : preferred;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  }).catch(async () => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Could not allocate a local port.")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  }));
}

export async function waitForHealth(
  origin: string,
  token: string,
  timeoutMs = 30_000,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    try {
      const response = await fetch(`${origin}/api/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
        ...(signal ? { signal } : {})
      });
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}.`);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError instanceof Error ? lastError : new Error("Continuum did not become ready in time.");
}

export function terminate(children: ChildProcess[]): void {
  for (const child of children) signalRunningChild(child, "SIGTERM");
}

/** Give graceful signal handlers time to flush and remove private runtime state. */
export async function terminateAndWait(
  children: ChildProcess[],
  graceMs = 5_000,
  childrenAlreadySignaled = false
): Promise<void> {
  const running = children.filter((child) => !hasExited(child));
  if (running.length === 0) return;
  const exits = Promise.all(running.map(waitForAnyExit));
  // Terminal Ctrl-C reaches the entire foreground process group. Give those
  // existing SIGINT handlers their full grace period before sending a second
  // signal; watch supervisors commonly interpret a second signal as "force".
  if (childrenAlreadySignaled && await exitsWithin(exits, graceMs)) return;
  for (const child of running) signalRunningChild(child, "SIGTERM");
  if (await exitsWithin(exits, graceMs)) return;

  for (const child of running) signalRunningChild(child, "SIGKILL");
  await exits;
}

async function exitsWithin(exits: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    exits.then(() => true),
    new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), graceMs); })
  ]);
  if (timeout) clearTimeout(timeout);
  return graceful;
}

function waitForAnyExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const settled = () => {
      child.off("error", settled);
      child.off("exit", settled);
      resolve();
    };
    child.once("error", settled);
    child.once("exit", settled);
  });
}

function signalRunningChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (hasExited(child)) return;
  try { child.kill(signal); } catch { /* The process exited between the status check and signal. */ }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
