import { stableHash } from "@continuum/config";
import type { ContinuumDatabase } from "@continuum/database";

export function enqueueIdleLintIfDue(database: ContinuumDatabase, current = Date.now()): boolean {
  const activeJobs = Number((database.connection.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running')").get() as { count: number }).count);
  if (activeJobs > 0) return false;
  const lastEvent = (database.connection.prepare("SELECT MAX(created_at) AS value FROM events").get() as { value: string | null }).value;
  if (!lastEvent || !Number.isFinite(Date.parse(lastEvent)) || current - Date.parse(lastEvent) < 5 * 60_000) return false;
  const today = new Date(current).toISOString().slice(0, 10);
  if (database.getSetting("memory.lastIdleLintDate", "") === today) return false;
  database.enqueueJob("memory.lint", stableHash(`memory.lint:idle:${today}`), { automatic: true, idleSince: lastEvent }, 1);
  database.setSetting("memory.lastIdleLintDate", today);
  return true;
}
