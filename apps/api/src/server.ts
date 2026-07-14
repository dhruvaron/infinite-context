import { buildApp } from "./app.js";
import {
  removeOwnedRuntimeDescriptor,
  removeOwnedRuntimeDescriptorAfterPublication,
  type RuntimeDescriptor,
  writeRuntimeDescriptor
} from "./runtime-descriptor.js";

const { app, services } = await buildApp();

let descriptor: RuntimeDescriptor | null = null;
let descriptorPublication: Promise<void> | null = null;
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    if (descriptor) {
      if (descriptorPublication) {
        await removeOwnedRuntimeDescriptorAfterPublication(
          services.config.runtimeDescriptorPath,
          descriptor,
          descriptorPublication
        );
      } else {
        await removeOwnedRuntimeDescriptor(services.config.runtimeDescriptorPath, descriptor);
      }
    }
    // Let Node exit only after Fastify hooks have drained cancellable backup
    // work and removed owned staging. A forced exit here would bypass async
    // finally blocks and could strand multi-gigabyte partial snapshots.
    process.exitCode = 0;
  }
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

await app.listen({ host: services.config.host, port: services.config.port });
descriptor = {
  pid: process.pid,
  origin: services.config.apiOrigin,
  bootstrapUrl: `${services.config.apiOrigin}/bootstrap?token=${encodeURIComponent(services.config.sessionToken)}`,
  startedAt: new Date().toISOString(),
  version: "0.1.0"
};
descriptorPublication = writeRuntimeDescriptor(services.config.runtimeDescriptorPath, descriptor);
await descriptorPublication;
services.logger.info("Continuum API started", { origin: services.config.apiOrigin, pid: process.pid });
