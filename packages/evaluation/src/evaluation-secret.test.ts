import { describe, expect, it } from "vitest";
import {
  EVALUATION_API_KEY_ENVIRONMENT_VARIABLE,
  assertEphemeralEvaluationApiKeyAvailable,
  takeEphemeralEvaluationApiKey,
  takeEphemeralEvaluationApiKeyAfterAdmission
} from "./evaluation-secret.js";

describe("ephemeral paid-evaluation credential", () => {
  it("consumes the dedicated evaluation-only variable without persistence", () => {
    const key = "sk-evaluation_fake_key_123456789";
    const environment: NodeJS.ProcessEnv = { [EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]: key };
    expect(takeEphemeralEvaluationApiKey(environment)).toBe(key);
    expect(environment).not.toHaveProperty(EVALUATION_API_KEY_ENVIRONMENT_VARIABLE);
  });

  it("deletes malformed values before failing closed", () => {
    const environment: NodeJS.ProcessEnv = { [EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]: "not-a-key" };
    expect(() => takeEphemeralEvaluationApiKey(environment)).toThrow("format is not recognized");
    expect(environment).not.toHaveProperty(EVALUATION_API_KEY_ENVIRONMENT_VARIABLE);
  });

  it("prechecks presence and format without consuming a valid credential", () => {
    const key = "sk-evaluation_precheck_fake_key_123456789";
    const environment: NodeJS.ProcessEnv = { [EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]: key };
    expect(() => assertEphemeralEvaluationApiKeyAvailable(environment)).not.toThrow();
    expect(environment[EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]).toBe(key);
    expect(() => assertEphemeralEvaluationApiKeyAvailable({})).toThrow(EVALUATION_API_KEY_ENVIRONMENT_VARIABLE);
    expect(() => assertEphemeralEvaluationApiKeyAvailable({
      [EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]: "not-a-key"
    })).toThrow("format is not recognized");
  });

  it("consumes only after admission and clears the environment on every failure", () => {
    const key = "sk-evaluation_admission_fake_key_123456789";
    const environment: NodeJS.ProcessEnv = { [EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]: key };
    const result = takeEphemeralEvaluationApiKeyAfterAdmission(() => {
      expect(environment[EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]).toBe(key);
      return "admitted";
    }, environment);
    expect(result).toEqual({ admission: "admitted", apiKey: key });
    expect(environment).not.toHaveProperty(EVALUATION_API_KEY_ENVIRONMENT_VARIABLE);

    const rejected: NodeJS.ProcessEnv = { [EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]: key };
    expect(() => takeEphemeralEvaluationApiKeyAfterAdmission(() => {
      throw new Error("budget rejected");
    }, rejected)).toThrow("budget rejected");
    expect(rejected).not.toHaveProperty(EVALUATION_API_KEY_ENVIRONMENT_VARIABLE);

    const malformed: NodeJS.ProcessEnv = { [EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]: "not-a-key" };
    expect(() => takeEphemeralEvaluationApiKeyAfterAdmission(() => "must not run", malformed)).toThrow("format is not recognized");
    expect(malformed).not.toHaveProperty(EVALUATION_API_KEY_ENVIRONMENT_VARIABLE);
  });
});
