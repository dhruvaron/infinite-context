import { prepareMacNativeIngestion } from "../packages/ingestion/src/index.js";

const status = await prepareMacNativeIngestion();
if (process.platform === "darwin" && !status.available) {
  process.stderr.write(`Native macOS ingestion is unavailable: ${status.reason ?? "unknown reason"}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(status)}\n`);
}
