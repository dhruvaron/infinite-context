import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVICE = "dev.continuum.local";
const ACCOUNT = "openai-api-key";
const SECURITY = "/usr/bin/security";
const EXPECT = "/usr/bin/expect";
const SET_HELPER = fileURLToPath(new URL("./keychain-set.exp", import.meta.url));
const MAX_COMMAND_OUTPUT_BYTES = 4_096;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OPENAI_API_KEY_CHARACTERS = 300;
const OPENAI_API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,297}$/;

export interface KeychainCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type KeychainCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin?: string
) => Promise<KeychainCommandResult>;

function appendBounded(chunks: Buffer[], chunk: Buffer): void {
  const used = chunks.reduce((total, item) => total + item.byteLength, 0);
  if (used >= MAX_COMMAND_OUTPUT_BYTES) return;
  chunks.push(chunk.subarray(0, MAX_COMMAND_OUTPUT_BYTES - used));
}

export function isRecognizedOpenAiApiKey(key: string): boolean {
  return key.length <= MAX_OPENAI_API_KEY_CHARACTERS && OPENAI_API_KEY_PATTERN.test(key);
}

function parseKeychainPasswordOutput(stdout: string): string | null {
  if (stdout.length === 0) return null;
  // Apple's `security find-generic-password -w` prints the password followed
  // by exactly one LF. Remove only that command framing: `trim()` would turn a
  // corrupted value with leading/trailing whitespace into an accepted key.
  if (!stdout.endsWith("\n")) {
    throw new Error("The API key stored in macOS Keychain has an unrecognized format.");
  }
  const key = stdout.slice(0, -1);
  if (key.length === 0) return null;
  if (!isRecognizedOpenAiApiKey(key)) {
    throw new Error("The API key stored in macOS Keychain has an unrecognized format.");
  }
  return key;
}

function keychainCommandEnvironment(): NodeJS.ProcessEnv {
  // Do not copy provider keys or unrelated credentials into the helper's
  // environment. These are the small set of user-context values needed by
  // macOS Keychain/Expect plus deterministic locale and executable lookup.
  const environment: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" };
  for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function createKeychainCommandRunner(timeoutMs = COMMAND_TIMEOUT_MS): KeychainCommandRunner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Keychain command timeout must be a positive safe integer.");
  return (executable, args, stdin) => new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: keychainCommandEnvironment()
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      callback();
    };
    child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk));
    // A child that rejects input reports its own non-zero exit status. Avoid an
    // unhandled EPIPE while never copying stdin into an error or log message.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code: timedOut ? 124 : code ?? 1
    })));
    child.stdin.end(stdin);
  });
}

const runCommand = createKeychainCommandRunner();

export class MacKeychain {
  readonly #run: KeychainCommandRunner;

  constructor(run: KeychainCommandRunner = runCommand) {
    this.#run = run;
  }

  async setOpenAiApiKey(key: string): Promise<void> {
    if (!isRecognizedOpenAiApiKey(key)) throw new Error("The API key format is not recognized.");
    // Apple's `security add-generic-password -w <password>` help explicitly
    // labels an argv password insecure. The tiny Expect helper reads the key
    // from stdin, waits until the Keychain prompt has disabled terminal echo,
    // and only then writes it into the child PTY. The key is never an argument.
    // -N and -n prevent system and per-user Expect startup files from enabling
    // diagnostics, transcript logging, command traces, or other hooks before
    // the committed helper disables normal session output.
    const result = await this.#run(EXPECT, ["-N", "-n", SET_HELPER, SERVICE, ACCOUNT], `${key}\n`);
    if (result.code !== 0) throw new Error("The API key could not be saved to macOS Keychain.");
  }

  async getOpenAiApiKey(): Promise<string | null> {
    const result = await this.#run(SECURITY, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    if (result.code !== 0) return null;
    return parseKeychainPasswordOutput(result.stdout);
  }

  async deleteOpenAiApiKey(): Promise<void> {
    const result = await this.#run(SECURITY, ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    if (result.code !== 0 && !result.stderr.includes("could not be found")) {
      throw new Error("The API key could not be removed from macOS Keychain.");
    }
  }
}
