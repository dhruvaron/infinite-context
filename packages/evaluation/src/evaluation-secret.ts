import { isRecognizedOpenAiApiKey } from "@continuum/providers";

export const EVALUATION_API_KEY_ENVIRONMENT_VARIABLE = "CONTINUUM_EVALUATION_OPENAI_API_KEY";

/** Validate the paid-evaluation credential before creating a durable plan fence. */
export function assertEphemeralEvaluationApiKeyAvailable(environment: NodeJS.ProcessEnv = process.env): void {
  const key = environment[EVALUATION_API_KEY_ENVIRONMENT_VARIABLE];
  if (!key) throw new Error(`${EVALUATION_API_KEY_ENVIRONMENT_VARIABLE} is required for paid evaluation and is never persisted.`);
  if (!isRecognizedOpenAiApiKey(key)) throw new Error("The ephemeral evaluation API key format is not recognized.");
}

/**
 * Read the paid-evaluation credential once and remove it from process.env so
 * later helpers or subprocesses cannot inherit it accidentally.
 */
export function takeEphemeralEvaluationApiKey(environment: NodeJS.ProcessEnv = process.env): string | null {
  const key = environment[EVALUATION_API_KEY_ENVIRONMENT_VARIABLE];
  delete environment[EVALUATION_API_KEY_ENVIRONMENT_VARIABLE];
  if (!key) return null;
  if (!isRecognizedOpenAiApiKey(key)) throw new Error("The ephemeral evaluation API key format is not recognized.");
  return key;
}

/**
 * Keep the credential in the environment until a synchronous durable-budget
 * admission succeeds, then consume it before any provider is constructed.
 * Every failure path deletes the credential without including it in errors.
 */
export function takeEphemeralEvaluationApiKeyAfterAdmission<T>(
  admit: () => T,
  environment: NodeJS.ProcessEnv = process.env
): { admission: T; apiKey: string } {
  try {
    assertEphemeralEvaluationApiKeyAvailable(environment);
    const admission = admit();
    const apiKey = takeEphemeralEvaluationApiKey(environment);
    if (!apiKey) throw new Error(`${EVALUATION_API_KEY_ENVIRONMENT_VARIABLE} is required for paid evaluation and is never persisted.`);
    return { admission, apiKey };
  } catch (error) {
    delete environment[EVALUATION_API_KEY_ENVIRONMENT_VARIABLE];
    throw error;
  }
}
