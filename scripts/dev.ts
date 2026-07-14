import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { availablePort, run, terminateAndWait, waitForExit, waitForHealth } from "./processes.js";

const root = process.cwd();
const webRoot = resolve(root, "apps", "web");
const tsx = resolve(root, "node_modules", ".bin", "tsx");
const vite = resolve(webRoot, "node_modules", ".bin", "vite");
const apiPort = await availablePort(4317);
const webPort = await availablePort(4173);
const token = randomBytes(32).toString("base64url");
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const env = {
  ...process.env,
  CONTINUUM_PORT: String(apiPort),
  CONTINUUM_SESSION_TOKEN: token,
  CONTINUUM_WEB_ORIGIN: webOrigin,
  VITE_CONTINUUM_API_ORIGIN: apiOrigin,
  NODE_ENV: "development"
};
const children = [
  run(tsx, ["watch", resolve(root, "apps/api/src/server.ts")], { env, cwd: root }),
  run(tsx, ["watch", resolve(root, "apps/worker/src/worker.ts")], { env, cwd: root }),
  run(vite, ["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { env, cwd: webRoot })
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
    await waitForHealth(apiOrigin, token, 30_000, startup.signal);
  } catch (error) {
    if (!stopping) throw error;
  }
  if (!stopping) {
    process.stdout.write(`Continuum development mode is ready at ${webOrigin}.\n`);
    const bootstrapUrl = `${apiOrigin}/bootstrap?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(webOrigin)}`;
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
      Promise.race(children.map((child, index) => waitForExit(child, ["API", "Worker", "Web"][index] ?? "Development process"))),
      stopRequested
    ]);
  }
} finally {
  startup.abort();
  await terminateAndWait(children, 5_000, childrenAlreadySignaled);
}
