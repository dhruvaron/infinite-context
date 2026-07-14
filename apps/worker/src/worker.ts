import { loadConfig } from "@continuum/config";
import { ContinuumDatabase, uuidv7 } from "@continuum/database";
import { LocalLogger } from "@continuum/observability";
import { ProviderFactory } from "@continuum/providers";
import { JobProcessor, WORKER_JOB_TYPES } from "./processor.js";
import { enqueueIdleLintIfDue } from "./scheduler.js";

const config = loadConfig();
const database = ContinuumDatabase.open(config);
const logger = new LocalLogger(config.logsDir, database.getSetting("promptTracing.enabled", false));
const providers = new ProviderFactory(config);
const processor = new JobProcessor(database, config, providers, logger);
const workerId = `worker-${uuidv7()}`;
let stopping = false;
let timer: NodeJS.Timeout | null = null;
let lastIdleLintCheck = 0;

await processor.initialize();
await logger.prune();

function checkIdleLint(): boolean {
  const current = Date.now();
  if (current - lastIdleLintCheck < 60_000) return false;
  lastIdleLintCheck = current;
  return enqueueIdleLintIfDue(database, current);
}

async function tick(): Promise<void> {
  if (stopping) return;
  logger.setPromptTracing(database.getSetting("promptTracing.enabled", false));
  if (database.getSetting("maintenance.locked", false)) {
    timer = setTimeout(() => void tick(), 300);
    return;
  }
  const job = database.leaseJob(workerId, 30_000, [...WORKER_JOB_TYPES]);
  if (!job) {
    timer = setTimeout(() => void tick(), checkIdleLint() ? 0 : 300);
    return;
  }
  const heartbeat = setInterval(() => database.heartbeatJob(job.id, workerId, 30_000), 10_000);
  try {
    const result = await processor.process(job);
    logger.info("background job completed", { jobId: job.id, jobType: job.type });
    await logger.flush();
    database.completeJob(job.id, workerId, result);
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? (error instanceof Error ? error.name : "JOB_FAILED"));
    logger.error("background job failed", { jobId: job.id, jobType: job.type, errorCode: code });
    await logger.flush();
    database.failJob(job.id, workerId, code);
  } finally {
    clearInterval(heartbeat);
  }
  timer = setTimeout(() => void tick(), 0);
}

async function shutdown(): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  await logger.flush();
  database.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

logger.info("Continuum worker started", { workerId });
await tick();
