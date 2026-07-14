import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MacKeychain,
  createKeychainCommandRunner,
  type KeychainCommandRunner
} from "./keychain.js";

describe("macOS Keychain transport", () => {
  it("sends an API key only over stdin and never in process arguments", async () => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const run: KeychainCommandRunner = vi.fn(async (executable, args, stdin) => {
      calls.push({ executable, args, ...(stdin === undefined ? {} : { stdin }) });
      return { stdout: "", stderr: "", code: 0 };
    });
    const keychain = new MacKeychain(run);
    const key = "sk-this_is_a_fake_key_123456789";

    await keychain.setOpenAiApiKey(key);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe("/usr/bin/expect");
    expect(calls[0]!.args.join(" ")).not.toContain(key);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["-N", "-n"]);
    expect(calls[0]!.args.at(-2)).toBe("dev.continuum.local");
    expect(calls[0]!.args.at(-1)).toBe("openai-api-key");
    expect(calls[0]!.stdin).toBe(`${key}\n`);
  });

  it("keeps lookup and deletion secrets out of arguments and normalizes absence", async () => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const run: KeychainCommandRunner = vi.fn(async (executable, args, stdin) => {
      calls.push({ executable, args, ...(stdin === undefined ? {} : { stdin }) });
      if (args[0] === "find-generic-password") return { stdout: "", stderr: "not found", code: 44 };
      return { stdout: "", stderr: "security: item could not be found", code: 44 };
    });
    const keychain = new MacKeychain(run);

    expect(await keychain.getOpenAiApiKey()).toBeNull();
    await expect(keychain.deleteOpenAiApiKey()).resolves.toBeUndefined();
    expect(calls.every((call) => call.executable === "/usr/bin/security" && call.stdin === undefined)).toBe(true);
    expect(calls.flatMap((call) => call.args)).not.toContain(expect.stringMatching(/^sk-/));
  });

  it("rejects malformed keys before starting a child process", async () => {
    const run = vi.fn<KeychainCommandRunner>();
    const keychain = new MacKeychain(run);
    for (const key of [
      "not-a-key",
      `sk-${"x".repeat(298)}`,
      "sk-valid_length_but_[unsafe]",
      "sk-valid_length_but_newline\n"
    ]) await expect(keychain.setOpenAiApiKey(key)).rejects.toThrow("format is not recognized");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed value already present in Keychain", async () => {
    const run: KeychainCommandRunner = vi.fn(async () => ({ stdout: "not-a-key\n", stderr: "", code: 0 }));
    await expect(new MacKeychain(run).getOpenAiApiKey()).rejects.toThrow("stored in macOS Keychain has an unrecognized format");
  });

  it("removes only security's single terminal LF and rejects all other output normalization", async () => {
    const key = "sk-keychain_read_fake_key_123456789";
    const output = async (stdout: string) => new MacKeychain(async () => ({ stdout, stderr: "", code: 0 })).getOpenAiApiKey();
    await expect(output(`${key}\n`)).resolves.toBe(key);
    await expect(output("")).resolves.toBeNull();
    await expect(output("\n")).resolves.toBeNull();
    for (const stdout of [
      key,
      ` ${key}\n`,
      `${key} \n`,
      `${key}\r\n`,
      `${key}\n\n`,
      `${key}\nignored\n`
    ]) await expect(output(stdout)).rejects.toThrow("stored in macOS Keychain has an unrecognized format");
  });

  it("bounds subprocess output, environment, and timeout handling", async () => {
    const secret = "sk-environment_only_fake_key_123456789";
    const previous = process.env.CONTINUUM_EVALUATION_OPENAI_API_KEY;
    process.env.CONTINUUM_EVALUATION_OPENAI_API_KEY = secret;
    try {
      const runner = createKeychainCommandRunner(2_000);
      const result = await runner(process.execPath, ["-e", `
        if (process.env.CONTINUUM_EVALUATION_OPENAI_API_KEY) process.stdout.write(process.env.CONTINUUM_EVALUATION_OPENAI_API_KEY);
        process.stdout.write("x".repeat(10_000));
        process.stderr.write("y".repeat(10_000));
      `]);
      expect(result.code).toBe(0);
      expect(Buffer.byteLength(result.stdout)).toBe(4_096);
      expect(Buffer.byteLength(result.stderr)).toBe(4_096);
      expect(result.stdout).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.CONTINUUM_EVALUATION_OPENAI_API_KEY;
      else process.env.CONTINUUM_EVALUATION_OPENAI_API_KEY = previous;
    }

    const timedOut = await createKeychainCommandRunner(25)(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"]);
    expect(timedOut.code).toBe(124);
    expect(() => createKeychainCommandRunner(0)).toThrow(RangeError);
  });

  it("keeps the committed Expect helper bounded and free of transcript output", async () => {
    const helper = await readFile(new URL("./keychain-set.exp", import.meta.url), "utf8");
    expect(helper).toContain("log_user 0");
    expect(helper).toContain("set payload [read stdin 302]");
    expect(helper).toContain("[string length $secret] > 300");
    expect(helper).toContain("regexp {^sk-[A-Za-z0-9_-]+$}");
    expect(helper).toContain("spawn -noecho /usr/bin/security");
    expect(helper).not.toMatch(/(?:send_user|log_file|puts)[ ]/);
    expect(helper).not.toContain("gets stdin");
  });

  it.runIf(process.platform === "darwin")("rejects malformed stdin in the real helper before touching Keychain", async () => {
    const helper = fileURLToPath(new URL("./keychain-set.exp", import.meta.url));
    const result = await createKeychainCommandRunner(2_000)(
      "/usr/bin/expect",
      ["-N", "-n", helper, "dev.continuum.local.qa-invalid", "invalid-input-test"],
      "not-a-key\n"
    );
    expect(result).toEqual({ stdout: "", stderr: "", code: 2 });
  });
});
