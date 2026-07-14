import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig } from "@continuum/config";
import { availablePort, run, terminateAndWait, waitForExit, waitForHealth } from "./processes.js";

const major = Number(process.versions.node.split(".")[0]);
if (major !== 22) throw new Error("Continuum v1 requires Node.js 22 LTS. Run `nvm use` and try again.");

const base = loadConfig();
const root = process.cwd();
const webRoot = resolve(root, "apps", "web");
const vite = resolve(webRoot, "node_modules", ".bin", "vite");
const port = await availablePort(base.port);
const token = randomBytes(32).toString("base64url");
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  CONTINUUM_HOST: "127.0.0.1",
  CONTINUUM_PORT: String(port),
  CONTINUUM_SESSION_TOKEN: token,
  CONTINUUM_WEB_ORIGIN: origin,
  NODE_ENV: "production"
};

process.stdout.write("Building the local Continuum interface…\n");
const build = run(vite, ["build"], { env, cwd: webRoot });
await waitForExit(build, "Web build");

const children = [
  run(process.execPath, ["--import", "tsx", resolve(root, "apps/api/src/server.ts")], { env, cwd: root }),
  run(process.execPath, ["--import", "tsx", resolve(root, "apps/worker/src/worker.ts")], { env, cwd: root })
];
let stopping = false;
let childrenAlreadySignaled = false;
let requestStop: (() => void) | undefined;
const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });
const startup = new AbortController();
const stop = (signalReachedProcessGroup: boolean) => {
  if (stopping) return;
  stopping = true;
  childrenAlreadySignaled = signalReachedProcessGroup;
  requestStop?.();
  startup.abort();
};
process.once("SIGINT", () => stop(true));
process.once("SIGTERM", () => stop(false));

try {
  try {
    await waitForHealth(origin, token, 30_000, startup.signal);
  } catch (error) {
    if (!stopping) throw error;
  }
  if (!stopping) {
    const returnTo = encodeURIComponent(origin);
    const bootstrapUrl = `${origin}/bootstrap?token=${encodeURIComponent(token)}&returnTo=${returnTo}`;
    process.stdout.write(`Continuum is ready at ${origin}. Press Ctrl+C to stop it.\n`);
    if (process.argv.includes("--no-open")) {
      process.stdout.write(`Authenticated launch URL (keep private): ${bootstrapUrl}\n`);
    } else {
      const opener = run("/usr/bin/open", [bootstrapUrl], { env, quiet: true });
      try {
        await waitForExit(opener, "Browser opener");
      } catch {
        process.stdout.write(`The browser could not be opened automatically. Authenticated launch URL (keep private): ${bootstrapUrl}\n`);
      }
    }
    await Promise.race([
      Promise.race(children.map((child, index) => waitForExit(child, index === 0 ? "API" : "Worker"))),
      stopRequested
    ]);
  }
} finally {
  startup.abort();
  await terminateAndWait(children, 5_000, childrenAlreadySignaled);
}
