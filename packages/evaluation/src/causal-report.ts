import { createHash } from "node:crypto";

import { validateCausalBenchmarkArtifact, type CausalBenchmarkArtifact } from "./causal-benchmark.js";
import type { AggregateMetrics, EvaluationRunRecord } from "./types.js";

export interface CausalReportArtifacts {
  markdown: string;
  html: string;
  controlledRunsJsonl: string;
  ablationRunsJsonl: string;
  reportHash: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeMarkdown(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/[|[\]()*_~#]/g, "\\$&")
    .replace(/`/g, "&#96;")
    .replace(/[\r\n]+/g, " ");
}

function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function signedPercent(value: number): string { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`; }

function metricsMarkdown(metrics: readonly AggregateMetrics[]): string {
  return [
    "| Mode | Runs | Accuracy | 95% CI | Recall@10 | Temporal | Unsupported | Input tokens | Cost | Median response |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...metrics.map((metric) => `| ${escapeMarkdown(metric.mode)} | ${metric.runs} | ${percent(metric.answerAccuracy)} | ${percent(metric.accuracyConfidence95[0])}–${percent(metric.accuracyConfidence95[1])} | ${percent(metric.retrievalRecallAt10)} | ${percent(metric.temporalAccuracy)} | ${percent(metric.unsupportedMemoryRate)} | ${metric.cumulativeInputTokens} | $${metric.cumulativeCostUsd.toFixed(4)} | ${metric.medianResponseLatencyMs.toFixed(1)} ms |`)
  ].join("\n");
}

function runScore(run: EvaluationRunRecord): number {
  return run.semanticAccuracy ?? Math.max(run.exactAccuracy, run.fuzzyAccuracy);
}

function representativeRuns(runs: readonly EvaluationRunRecord[], success: boolean): EvaluationRunRecord[] {
  return runs.filter((run) => run.error === null && (runScore(run) >= 0.5) === success)
    .sort((left, right) => createHash("sha256").update(left.runId).digest("hex")
      .localeCompare(createHash("sha256").update(right.runId).digest("hex")))
    .slice(0, 3);
}

function runMarkdown(run: EvaluationRunRecord): string {
  const configuration = typeof run.contextMetadata?.configurationId === "string"
    ? ` / ${run.contextMetadata.configurationId}` : "";
  return `- ${escapeMarkdown(run.datasetId)} · ${escapeMarkdown(run.probeId)} · ${escapeMarkdown(run.mode)}${escapeMarkdown(configuration)} — answer: “${escapeMarkdown(run.answer || "(empty)")}”; expected: ${escapeMarkdown(run.expectedAnswers.join(" / "))}; score: ${percent(runScore(run))}`;
}

function htmlTable(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function generateCausalBenchmarkReport(value: unknown): CausalReportArtifacts {
  const artifact: CausalBenchmarkArtifact = validateCausalBenchmarkArtifact(value);
  const combinedRuns = [...artifact.runs, ...artifact.ablations.runs];
  const successes = representativeRuns(combinedRuns, true);
  const failures = representativeRuns(combinedRuns, false);
  const eligible = artifact.eligibility.causalArchitectureClaim;
  const status = eligible
    ? "ELIGIBLE FOR THE FROZEN CAUSAL-ARCHITECTURE CLAIM"
    : artifact.evidenceClass === "production-path-no-cost-diagnostic"
      ? "INELIGIBLE NO-COST PRODUCTION-PATH DIAGNOSTIC"
      : "INELIGIBLE OR GATE-MISSING LIVE CAUSAL RESULT";
  const sourceMarkdown = [
    "| Source | Kind | License | Datasets | Messages | Probes | Complete | Registry verified | Reproducible | Redistributable adaptation | Dataset hash |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...artifact.datasetEvidence.sources.map((source) => `| ${escapeMarkdown(source.id)} | ${source.kind} | ${escapeMarkdown(source.licenses.join(", "))} | ${source.datasetIds.length} | ${source.messages} | ${source.probes} | ${source.completeSource && source.fullRecordAndProbeCoverage ? "yes" : "no"} | ${source.registryVerified ? "yes" : "no"} | ${source.reproducible ? "yes" : "no"} | ${source.adaptedRedistributionAllowed ? "yes" : "no"} | \`${source.datasetHash}\` |`)
  ].join("\n");
  const ablationMarkdown = [
    "| Configuration | Disabled | Runs | Accuracy | Δ accuracy drop | Recall@10 | Δ recall drop | Temporal | Δ temporal drop | Input-token Δ |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...artifact.ablations.metrics.map((entry) => `| ${entry.configuration} | ${entry.disabledFeature ?? "none"} | ${entry.metrics.runs} | ${percent(entry.metrics.answerAccuracy)} | ${signedPercent(entry.deltasVsFull.answerAccuracyDrop)} | ${percent(entry.metrics.retrievalRecallAt10)} | ${signedPercent(entry.deltasVsFull.retrievalRecallAt10Drop)} | ${percent(entry.metrics.temporalAccuracy)} | ${signedPercent(entry.deltasVsFull.temporalAccuracyDrop)} | ${entry.deltasVsFull.inputTokenDelta >= 0 ? "+" : ""}${entry.deltasVsFull.inputTokenDelta} |`)
  ].join("\n");
  const gateMarkdown = artifact.eligibility.gates.map((gate) =>
    `- ${gate.passed ? "PASS" : "MISS"}: ${escapeMarkdown(gate.id)} — ${escapeMarkdown(gate.detail)}`
  ).join("\n");
  const auditMarkdown = artifact.manualAudit.complete
    ? `Complete: ${artifact.manualAudit.reviewed}/${artifact.manualAudit.required}; agreement ${percent(artifact.manualAudit.agreementRate ?? 0)}; reviewer ${escapeMarkdown(artifact.manualAudit.reviewer ?? "not recorded")}; reviewed ${escapeMarkdown(artifact.manualAudit.reviewedAt ?? "not recorded")}.`
    : `Incomplete: ${artifact.manualAudit.reviewed}/${artifact.manualAudit.required}. Until a bound independent review is attached, the human-audit gate remains a miss.`;
  const markdown = `# Continuum production causal benchmark

**${status}.**

Generated: ${escapeMarkdown(artifact.generatedAt)}<br>
Evidence class: ${artifact.evidenceClass}<br>
Artifact result hash: \`${artifact.resultHash}\`

This report is derived only from the validated causal artifact. Product-superiority and live-latency claims are fixed to **false**; no ChatGPT, Codex, or live-interaction evidence is inferred from these runs.

## Protocol and budget

- Controlled modes: ${artifact.plan.modes.map(escapeMarkdown).join(", ")}
- Production ablations: ${artifact.plan.ablationConfigurations.map(escapeMarkdown).join(", ")}
- Repetitions: ${artifact.plan.repetitions}
- Answer calls: ${artifact.plan.answerCalls} (${artifact.plan.controlledAnswerCalls} controlled + ${artifact.plan.ablationAnswerCalls} ablation)
- Independent judge calls: ${artifact.plan.independentJudgeCalls}
- Planned combined ceiling: $${artifact.plan.combinedMaximumUsd.toFixed(4)}
- Durable plan charge: $${artifact.budget.durablePlanChargedUsd.toFixed(4)}; recorded production spend: $${artifact.budget.productionActualUsd.toFixed(4)}; hard cap: $${artifact.budget.hardCapUsd.toFixed(2)}; safe: ${artifact.budget.safe ? "yes" : "no"}

## Dataset evidence

${sourceMarkdown}

## Controlled comparison

${metricsMarkdown(artifact.metrics)}

## Production feature-removal ablations

Every row was produced through the same production worker, SQLite candidate index, and retrieval engine. A positive “drop” means the full configuration performed better. A zero is reported as zero, not interpreted as evidence of benefit.

${ablationMarkdown}

## Strict eligibility gates

${gateMarkdown}

Overall causal-architecture eligibility: **${eligible ? "PASS" : "INELIGIBLE"}**.

## Independent manual audit

${auditMarkdown}

## Implementation identity

- Worker/compiler: ${escapeMarkdown(artifact.implementation.workerCompiler)}
- Candidate index: ${escapeMarkdown(artifact.implementation.candidateIndex)}
- Retrieval engine: ${escapeMarkdown(artifact.implementation.retrievalEngine)}
- Rolling summary: ${escapeMarkdown(artifact.implementation.rollingSummary)}
- Answer provider: ${escapeMarkdown(artifact.implementation.answerProvider)}
- Grounding judge: ${escapeMarkdown(artifact.implementation.groundingJudge)}
- Reranker control: ${escapeMarkdown(artifact.implementation.rerankerControl)}

## Representative successes

${successes.length ? successes.map(runMarkdown).join("\n") : "_No successful run was available._"}

## Representative failures

${failures.length ? failures.map(runMarkdown).join("\n") : "_No failing run was available._"}

## Claim boundaries

${artifact.claimBoundaries.map((item) => `- ${escapeMarkdown(item)}`).join("\n")}

## Limitations

${artifact.limitations.map((item) => `- ${escapeMarkdown(item)}`).join("\n")}
`;

  const metricRows = artifact.metrics.map((metric) => [
    metric.mode, metric.runs, percent(metric.answerAccuracy), percent(metric.retrievalRecallAt10),
    percent(metric.temporalAccuracy), metric.cumulativeInputTokens, `$${metric.cumulativeCostUsd.toFixed(4)}`,
    `${metric.medianResponseLatencyMs.toFixed(1)} ms`
  ]);
  const ablationRows = artifact.ablations.metrics.map((entry) => [
    entry.configuration, entry.disabledFeature ?? "none", entry.metrics.runs, percent(entry.metrics.answerAccuracy),
    signedPercent(entry.deltasVsFull.answerAccuracyDrop), percent(entry.metrics.retrievalRecallAt10),
    signedPercent(entry.deltasVsFull.retrievalRecallAt10Drop), percent(entry.metrics.temporalAccuracy),
    signedPercent(entry.deltasVsFull.temporalAccuracyDrop), entry.deltasVsFull.inputTokenDelta
  ]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continuum causal benchmark</title><style>
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--ink:#172033;--muted:#5e687a;--line:#dce1e9;--good:#137a4b;--bad:#b42318;--accent:#3157d5} @media(prefers-color-scheme:dark){:root{--bg:#11141a;--card:#1b2029;--ink:#edf1f7;--muted:#aeb8c8;--line:#333c49;--good:#59d39b;--bad:#ff8a80;--accent:#89a3ff}} *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}.wrap{max-width:1180px;margin:auto;padding:40px 22px 80px}.hero,.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;margin:0 0 18px;box-shadow:0 8px 24px rgba(15,23,42,.05)}h1{font-size:34px;line-height:1.15;margin:0 0 12px}h2{font-size:21px;margin:0 0 14px}.status{display:inline-block;padding:7px 11px;border-radius:999px;font-weight:750;background:${eligible ? "var(--good)" : "var(--bad)"};color:#fff}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.stat{border:1px solid var(--line);padding:14px;border-radius:12px}.stat b{display:block;font-size:22px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}tr:last-child td{border-bottom:0}.pass{color:var(--good);font-weight:700}.miss{color:var(--bad);font-weight:700}code{overflow-wrap:anywhere}ul{padding-left:22px}
</style></head><body><main class="wrap"><section class="hero"><span class="status">${escapeHtml(status)}</span><h1>Continuum production causal benchmark</h1><p class="muted">Generated ${escapeHtml(artifact.generatedAt)} · ${escapeHtml(artifact.evidenceClass)}<br>Artifact hash <code>${artifact.resultHash}</code></p><p>This view is generated only after strict artifact validation. Product-superiority and live-latency claims remain false.</p></section>
<section class="card"><h2>Protocol and budget</h2><div class="grid"><div class="stat"><span class="muted">Answer calls</span><b>${artifact.plan.answerCalls}</b>${artifact.plan.controlledAnswerCalls} controlled + ${artifact.plan.ablationAnswerCalls} ablation</div><div class="stat"><span class="muted">Repetitions</span><b>${artifact.plan.repetitions}</b>per complete cell</div><div class="stat"><span class="muted">Durable charge</span><b>$${artifact.budget.durablePlanChargedUsd.toFixed(4)}</b>hard cap $100</div><div class="stat"><span class="muted">Manual audit</span><b>${artifact.manualAudit.reviewed}/${artifact.manualAudit.required}</b>${artifact.manualAudit.complete ? "complete" : "incomplete"}</div></div></section>
<section class="card"><h2>Dataset evidence</h2>${htmlTable(["Source","Kind","License","Datasets","Messages","Probes","Complete","Registry","Reproducible","Redistributable adaptation","Hash"],artifact.datasetEvidence.sources.map((source)=>[source.id,source.kind,source.licenses.join(", "),source.datasetIds.length,source.messages,source.probes,source.completeSource&&source.fullRecordAndProbeCoverage?"yes":"no",source.registryVerified?"yes":"no",source.reproducible?"yes":"no",source.adaptedRedistributionAllowed?"yes":"no",source.datasetHash]))}</section>
<section class="card"><h2>Controlled comparison</h2>${htmlTable(["Mode","Runs","Accuracy","Recall@10","Temporal","Input tokens","Cost","Median response"],metricRows)}</section>
<section class="card"><h2>Production feature-removal ablations</h2><p class="muted">Positive drops favor the full configuration. Unchanged rows remain unchanged evidence.</p>${htmlTable(["Configuration","Disabled","Runs","Accuracy","Accuracy drop","Recall@10","Recall drop","Temporal","Temporal drop","Token Δ"],ablationRows)}</section>
<section class="card"><h2>Strict eligibility gates</h2><ul>${artifact.eligibility.gates.map((gate)=>`<li><span class="${gate.passed?"pass":"miss"}">${gate.passed?"PASS":"MISS"}</span> <strong>${escapeHtml(gate.id)}</strong> — ${escapeHtml(gate.detail)}</li>`).join("")}</ul><p><strong>Overall: ${eligible ? "PASS" : "INELIGIBLE"}</strong></p></section>
<section class="card"><h2>Independent audit</h2><p>${escapeHtml(auditMarkdown)}</p></section>
<section class="card"><h2>Representative successes</h2>${successes.length?`<ul>${successes.map((run)=>`<li>${escapeHtml(`${run.datasetId} · ${run.probeId} · ${run.mode} — ${run.answer || "(empty)"}`)}</li>`).join("")}</ul>`:"<p>None available.</p>"}<h2>Representative failures</h2>${failures.length?`<ul>${failures.map((run)=>`<li>${escapeHtml(`${run.datasetId} · ${run.probeId} · ${run.mode} — ${run.answer || "(empty)"}`)}</li>`).join("")}</ul>`:"<p>None available.</p>"}</section>
<section class="card"><h2>Claim boundaries</h2><ul>${artifact.claimBoundaries.map((item)=>`<li>${escapeHtml(item)}</li>`).join("")}</ul><h2>Limitations</h2><ul>${artifact.limitations.map((item)=>`<li>${escapeHtml(item)}</li>`).join("")}</ul></section></main></body></html>`;
  const controlledRunsJsonl = `${artifact.runs.map((run) => JSON.stringify(run)).join("\n")}\n`;
  const ablationRunsJsonl = `${artifact.ablations.runs.map((run) => JSON.stringify(run)).join("\n")}\n`;
  return {
    markdown,
    html,
    controlledRunsJsonl,
    ablationRunsJsonl,
    reportHash: createHash("sha256").update(artifact.resultHash).update(markdown).update(html).digest("hex")
  };
}
