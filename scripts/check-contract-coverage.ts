import { readFile } from "node:fs/promises";

import {
  PUBLIC_API_CONTRACTS,
  PUBLIC_API_RESOURCE_GROUPS,
  RunStreamWireEventSchema
} from "../packages/contracts/src/api.js";

const appSource = await readFile(new URL("../apps/api/src/app.ts", import.meta.url), "utf8");

const failures: string[] = [];
const identifiers = new Set<string>();
const routeKeys = new Set<string>();
for (const contract of PUBLIC_API_CONTRACTS) {
  const routeKey = `${contract.method} ${contract.path}`;
  if (identifiers.has(contract.id)) failures.push(`duplicate contract id: ${contract.id}`);
  if (routeKeys.has(routeKey)) failures.push(`duplicate route contract: ${routeKey}`);
  identifiers.add(contract.id);
  routeKeys.add(routeKey);
  if (contract.list) {
    const queryShape = contract.request?.query && "shape" in contract.request.query
      ? (contract.request.query as { shape: Record<string, unknown> }).shape
      : {};
    if (!("cursor" in queryShape)) failures.push(`list route does not declare cursor pagination: ${routeKey}`);
  }
  if (contract.mutation) {
    const key = "00000000-0000-4000-8000-000000000000";
    const bodyAcceptsKey = contract.request?.body?.safeParse({ idempotencyKey: key }).success === true;
    const headersAcceptKey = contract.request?.headers?.safeParse({ "idempotency-key": key }).success === true;
    // Mutation bodies often require additional fields. Inspect the shared
    // schema shape as a second, deterministic check without weakening it.
    const bodyShape = contract.request?.body && "shape" in contract.request.body
      ? (contract.request.body as { shape: Record<string, unknown> }).shape
      : {};
    const headerShape = contract.request?.headers && "shape" in contract.request.headers
      ? (contract.request.headers as { shape: Record<string, unknown> }).shape
      : {};
    if (!bodyAcceptsKey && !headersAcceptKey && !("idempotencyKey" in bodyShape) && !("idempotency-key" in headerShape)) {
      failures.push(`mutation has no shared idempotency-key contract: ${routeKey}`);
    }
  }
}

for (const group of PUBLIC_API_RESOURCE_GROUPS) {
  if (!PUBLIC_API_CONTRACTS.some((contract) => contract.group === group)) failures.push(`missing section-11 resource group: ${group}`);
}

const routePattern = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
for (const match of appSource.matchAll(routePattern)) {
  const path = match[2];
  if (!path?.startsWith("/api/v1")) continue;
  if (path.includes("${")) continue;
  const key = `${match[1]!.toUpperCase()} ${path}`;
  if (!routeKeys.has(key)) failures.push(`server route missing from shared inventory: ${key}`);
}

const wireProbe = RunStreamWireEventSchema.safeParse({
  version: "v1",
  type: "run.started",
  runId: "00000000-0000-4000-8000-000000000000"
});
if (!wireProbe.success) failures.push("versioned SSE discriminated union rejected its canonical v1 frame");
if (RunStreamWireEventSchema.safeParse({ type: "run.started", runId: "00000000-0000-4000-8000-000000000000" }).success) {
  failures.push("versioned SSE contract accepted an unversioned frame");
}

if (!appSource.includes("publicApiContractFor(request.method")) failures.push("API server is not enforcing shared response contracts");

if (failures.length) {
  for (const failure of failures) process.stderr.write(`contract coverage: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Contract coverage complete: ${PUBLIC_API_CONTRACTS.length} routes across ${PUBLIC_API_RESOURCE_GROUPS.length} resource groups.\n`);
}
