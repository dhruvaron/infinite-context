import assert from "node:assert/strict";

import { IsolatedSandbox } from "../packages/tools/src/index.js";

if (process.platform !== "darwin") {
  throw new Error("The release sandbox smoke must run on macOS; it is not a skippable cross-platform unit test.");
}

const sandbox = new IsolatedSandbox();

const filesystem = await sandbox.execute({
  language: "javascript",
  code: "import fs from 'node:fs'; try { fs.readFileSync('/etc/passwd'); console.log('FS_OPEN') } catch { console.log('FS_DENIED') }"
});
assert.equal(filesystem.backend, "macos-sandbox-exec");
assert.equal(filesystem.status, "completed");
assert.match(filesystem.stdout, /FS_DENIED/);
assert.doesNotMatch(filesystem.stdout, /FS_OPEN|root:/);

const network = await sandbox.execute({
  language: "javascript",
  code: "try { await fetch('https://example.com'); console.log('NETWORK_OPEN') } catch { console.log('NETWORK_DENIED') }"
});
assert.equal(network.status, "completed");
assert.match(network.stdout, /NETWORK_DENIED/);
assert.doesNotMatch(network.stdout, /NETWORK_OPEN/);

const pythonBoundaries = await sandbox.execute({
  language: "python",
  code: [
    "import os, socket",
    "print('SECRETS_CLEAN' if 'OPENAI_API_KEY' not in os.environ and 'SSH_AUTH_SOCK' not in os.environ else 'SECRETS_LEAKED')",
    "try:",
    "    open('/etc/passwd').read()",
    "    print('PY_FS_OPEN')",
    "except Exception:",
    "    print('PY_FS_DENIED')",
    "try:",
    "    socket.create_connection(('1.1.1.1', 80), timeout=0.2)",
    "    print('PY_NETWORK_OPEN')",
    "except Exception:",
    "    print('PY_NETWORK_DENIED')"
  ].join("\n")
});
assert.equal(pythonBoundaries.backend, "macos-sandbox-exec");
assert.equal(pythonBoundaries.status, "completed");
assert.match(pythonBoundaries.stdout, /SECRETS_CLEAN/);
assert.match(pythonBoundaries.stdout, /PY_FS_DENIED/);
assert.match(pythonBoundaries.stdout, /PY_NETWORK_DENIED/);
assert.doesNotMatch(pythonBoundaries.stdout, /SECRETS_LEAKED|PY_FS_OPEN|PY_NETWORK_OPEN|root:/);

const timeout = await sandbox.execute({ language: "javascript", code: "while (true) {}", wallTimeMs: 200 });
assert.equal(timeout.status, "timed_out");
assert.ok(timeout.durationMs < 5_000, `wall-time enforcement took ${timeout.durationMs}ms`);

const output = await sandbox.execute({ language: "javascript", code: "console.log('x'.repeat(2_000_000))", outputBytes: 1_024 });
assert.equal(output.status, "output_limit");
assert.equal(output.truncated, true);
assert.ok(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 1_024);

const memory = await sandbox.execute({
  language: "javascript",
  code: "const retained = []; while (true) retained.push(new Array(250_000).fill(Math.random()));",
  memoryBytes: 64 * 1024 * 1024,
  wallTimeMs: 5_000
});
assert.equal(memory.status, "memory_limit", `expected memory_limit, received ${memory.status}: ${memory.stderr.slice(0, 300)}`);

const pythonMemory = await sandbox.execute({
  language: "python",
  code: "retained = []\nwhile True:\n    retained.append(bytearray(4 * 1024 * 1024))",
  memoryBytes: 64 * 1024 * 1024,
  wallTimeMs: 5_000
});
assert.equal(pythonMemory.status, "memory_limit", `expected Python memory_limit, received ${pythonMemory.status}: ${pythonMemory.stderr.slice(0, 300)}`);

process.stdout.write("macOS sandbox smoke passed for JavaScript and Python: environment, filesystem, network, wall-time, output, and memory boundaries enforced.\n");
