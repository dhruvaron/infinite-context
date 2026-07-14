import { InstallationBudgetGuard } from "@continuum/config";

/**
 * Compatibility name for the evaluation surface. The implementation is the
 * same installation-wide authority used by normal application traffic.
 */
export class DurableEvaluationBudgetGuard extends InstallationBudgetGuard {}
