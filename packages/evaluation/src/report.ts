import { createHash } from "node:crypto";

import { relativeImprovement } from "./metrics.js";
import type {
  AggregateMetrics,
  ControlledBaselineMode,
  EvaluationRunRecord
} from "./types.js";

export interface CompetitorRecord {
  product: "ChatGPT" | "Codex" | string;
  date: string;
  visibleModelSetting: string;
  promptProtocol: string;
  transcriptHandling: string;
  score: number;
  notes: string;
}

export interface ReleaseGateResult {
  name: string;
  target: string;
  actual: number;
  passed: boolean;
}

export interface EvaluationReportInput {
  title: string;
  generatedAt: string;
  config: Record<string, unknown>;
  metrics: AggregateMetrics[];
  runs: EvaluationRunRecord[];
  competitors: CompetitorRecord[];
  budgetTotalUsd: number;
  fullHistoryPromptTokensAt10k: number | null;
  representativeSuccesses: string[];
  representativeFailures: string[];
  evidenceClass?: "live-controlled" | "no-cost-fixture";
  resultHash?: string;
  ablations?: Array<{
    name: string;
    disabledFeature: string | null;
    answerAccuracy: number;
    retrievalRecallAt10: number;
    temporalAccuracy: number;
    cumulativeInputTokens: number;
    runs: number;
  }>;
  performance?: {
    searchP95Ms: number | null;
    firstTokenMedianMs: number | null;
    memorySearchableP95Ms: number | null;
    firstTokenReleaseEligible: boolean;
    memorySearchableReleaseEligible: boolean;
    eligibilityNotes: string[];
    source: string;
  };
  diagnostics?: Array<{
    title: string;
    status: "pass" | "warning" | "blocked";
    summary: string;
    details: Record<string, unknown>;
  }>;
  limitations?: string[];
  provenance?: {
    revision: string;
    environment: string;
  };
}

export interface EvaluationReportArtifacts {
  markdown: string;
  html: string;
  rawJsonl: string;
  configHash: string;
  gates: ReleaseGateResult[];
}

function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function metric(
  metrics: readonly AggregateMetrics[],
  mode: ControlledBaselineMode
): AggregateMetrics {
  const value = metrics.find((item) => item.mode === mode);
  if (!value) throw new Error(`Report is missing ${mode} metrics`);
  return value;
}

export function evaluateReleaseGates(input: EvaluationReportInput): ReleaseGateResult[] {
  const continuum = metric(input.metrics, "continuum");
  const rolling = metric(input.metrics, "rolling_summary");
  const flat = metric(input.metrics, "flat_hybrid");
  const accuracyImprovement = relativeImprovement(
    continuum.answerAccuracy,
    rolling.answerAccuracy
  );
  const tokenSavings =
    input.fullHistoryPromptTokensAt10k === null || input.fullHistoryPromptTokensAt10k === 0
      ? 0
      : 1 - continuum.cumulativeInputTokens / input.fullHistoryPromptTokensAt10k;
  const searchP95Ms = input.performance?.searchP95Ms ?? Number.NaN;
  const firstTokenMedianMs = input.performance?.firstTokenReleaseEligible
    ? input.performance.firstTokenMedianMs ?? Number.NaN
    : Number.NaN;
  const memorySearchableP95Ms = input.performance?.memorySearchableReleaseEligible
    ? input.performance.memorySearchableP95Ms ?? Number.NaN
    : Number.NaN;
  const latencyMeasured = flat.medianResponseLatencyMs > 0 && continuum.medianResponseLatencyMs > 0;
  const latencyOverhead = latencyMeasured
    ? continuum.medianResponseLatencyMs / flat.medianResponseLatencyMs - 1
    : Number.NaN;
  return [
    { name: "Accuracy over rolling summary", target: ">= 15% relative", actual: accuracyImprovement, passed: accuracyImprovement >= 0.15 },
    { name: "Retrieval Recall@10", target: ">= 90%", actual: continuum.retrievalRecallAt10, passed: continuum.retrievalRecallAt10 >= 0.9 },
    { name: "Current/superseded accuracy", target: ">= 90%", actual: continuum.temporalAccuracy, passed: continuum.temporalAccuracy >= 0.9 },
    { name: "Unsupported personal memory", target: "< 2%", actual: continuum.unsupportedMemoryRate, passed: continuum.unsupportedMemoryRate < 0.02 },
    { name: "Prompt-token savings at 10k", target: ">= 60%", actual: tokenSavings, passed: tokenSavings >= 0.6 },
    { name: "Median latency overhead", target: "<= 25% vs flat hybrid", actual: latencyOverhead, passed: latencyMeasured && latencyOverhead <= 0.25 },
    { name: "Local search p95", target: "< 500 ms at 100k messages", actual: searchP95Ms, passed: Number.isFinite(searchP95Ms) && searchP95Ms < 500 },
    { name: "First streamed token", target: "<= 3,000 ms under normal provider conditions", actual: firstTokenMedianMs, passed: Number.isFinite(firstTokenMedianMs) && firstTokenMedianMs <= 3_000 },
    { name: "Memory searchable after turn", target: "<= 10,000 ms", actual: memorySearchableP95Ms, passed: Number.isFinite(memorySearchableP95Ms) && memorySearchableP95Ms <= 10_000 }
  ];
}

function escapeHtml(value: string): string {
  return value
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

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function gateActual(gate: ReleaseGateResult): string {
  if (!Number.isFinite(gate.actual)) return "not measured";
  if (/search p95|first streamed token|memory searchable/i.test(gate.name)) return `${gate.actual.toFixed(1)} ms`;
  return percent(gate.actual);
}

function gateStatus(gate: ReleaseGateResult): "PASS" | "MISS" | "NOT MEASURED" {
  if (!Number.isFinite(gate.actual)) return "NOT MEASURED";
  return gate.passed ? "PASS" : "MISS";
}

function gateClass(gate: ReleaseGateResult): "pass" | "miss" | "unknown" {
  if (!Number.isFinite(gate.actual)) return "unknown";
  return gate.passed ? "pass" : "miss";
}

function markdownTable(metrics: readonly AggregateMetrics[]): string {
  const rows = metrics.map(
    (item) =>
      `| ${item.mode} | ${percent(item.answerAccuracy)} | ${percent(item.accuracyConfidence95[0])}–${percent(item.accuracyConfidence95[1])} | ${percent(item.retrievalRecallAt10)} | ${percent(item.temporalAccuracy)} | ${item.cumulativeInputTokens} | $${item.cumulativeCostUsd.toFixed(2)} | ${item.medianResponseLatencyMs.toFixed(0)} ms |`
  );
  return [
    "| Mode | Accuracy | Accuracy 95% CI | Recall@10 | Temporal | Input tokens | Cost | Median latency |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows
  ].join("\n");
}

function chartSvg(metrics: readonly AggregateMetrics[]): string {
  const width = 640;
  const barWidth = 90;
  const gap = 55;
  const bars = metrics.map((item, index) => {
    const height = Math.round(item.answerAccuracy * 180);
    const x = 45 + index * (barWidth + gap);
    const y = 215 - height;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="#4f7cff"/><text x="${x + barWidth / 2}" y="235" text-anchor="middle" font-size="12">${escapeHtml(item.mode)}</text><text x="${x + barWidth / 2}" y="${Math.max(15, y - 6)}" text-anchor="middle" font-size="12">${percent(item.answerAccuracy)}</text>`;
  });
  return `<svg role="img" aria-label="Answer accuracy by mode" viewBox="0 0 ${width} 250" xmlns="http://www.w3.org/2000/svg"><line x1="30" y1="215" x2="620" y2="215" stroke="#777"/>${bars.join("")}</svg>`;
}

export function generateEvaluationReport(
  input: EvaluationReportInput
): EvaluationReportArtifacts {
  const configHash = createHash("sha256").update(stable(input.config)).digest("hex");
  const gates = evaluateReleaseGates(input);
  const evidenceClass = input.evidenceClass ?? "live-controlled";
  const evidenceNotice = evidenceClass === "no-cost-fixture"
    ? "**Evidence status: deterministic no-cost fixture.** These results verify evaluator wiring, reproducibility, baseline isolation, and report generation. They are not live-model benchmark evidence and cannot establish the product's accuracy, latency, or token-savings claims."
    : "**Evidence status: live controlled evaluation.** Interpret results using the recorded model, provider, configuration, and limitations below.";
  const gateMarkdown = gates
    .map((gate) => `- ${gateStatus(gate)}: ${gate.name} (${gate.target}; actual ${gateActual(gate)})`)
    .join("\n");
  const competitorMarkdown = input.competitors.length === 0
    ? "_No black-box competitor runs recorded._"
    : input.competitors.map((record) => `- ${escapeMarkdown(record.product)} (${escapeMarkdown(record.date)}, ${escapeMarkdown(record.visibleModelSetting)}): ${percent(record.score)} — ${escapeMarkdown(record.notes)}\n  - Prompt protocol: ${escapeMarkdown(record.promptProtocol)}\n  - Transcript handling: ${escapeMarkdown(record.transcriptHandling)}`).join("\n");
  const ablationMarkdown = input.ablations?.length
    ? [
        "| Configuration | Disabled | Accuracy | Recall@10 | Temporal | Input tokens | Runs |",
        "|---|---|---:|---:|---:|---:|---:|",
        ...input.ablations.map((entry) => `| ${escapeMarkdown(entry.name)} | ${escapeMarkdown(entry.disabledFeature ?? "none")} | ${percent(entry.answerAccuracy)} | ${percent(entry.retrievalRecallAt10)} | ${percent(entry.temporalAccuracy)} | ${entry.cumulativeInputTokens} | ${entry.runs} |`)
      ].join("\n")
    : "_No ablation runs recorded._";
  const performanceMarkdown = input.performance
    ? `- Search p95: ${input.performance.searchP95Ms === null ? "not measured" : `${input.performance.searchP95Ms.toFixed(2)} ms`}\n- First-token median: ${input.performance.firstTokenMedianMs === null ? "not measured" : `${input.performance.firstTokenMedianMs.toFixed(2)} ms${input.performance.firstTokenReleaseEligible ? " (release-eligible)" : " (diagnostic only)"}`}\n- Memory-searchable p95: ${input.performance.memorySearchableP95Ms === null ? "not measured" : `${input.performance.memorySearchableP95Ms.toFixed(2)} ms${input.performance.memorySearchableReleaseEligible ? " (release-eligible)" : " (diagnostic only)"}`}\n- Eligibility notes: ${escapeMarkdown(input.performance.eligibilityNotes.length ? input.performance.eligibilityNotes.join("; ") : "none")}\n- Source: ${escapeMarkdown(input.performance.source)}`
    : "_No release performance measurement attached._";
  const limitationsMarkdown = input.limitations?.length
    ? input.limitations.map((item) => `- ${escapeMarkdown(item)}`).join("\n")
    : "_No additional limitations recorded._";
  const diagnosticsMarkdown = input.diagnostics?.length
    ? input.diagnostics.map((diagnostic) => `### ${escapeMarkdown(diagnostic.title)}\n\nStatus: ${diagnostic.status.toUpperCase()}\n\n${escapeMarkdown(diagnostic.summary)}\n\n\`\`\`json\n${JSON.stringify(diagnostic.details, null, 2)}\n\`\`\``).join("\n\n")
    : "_No additional diagnostics recorded._";
  const configurationJson = JSON.stringify(input.config, null, 2);
  const htmlPerformance = input.performance
    ? `<ul><li>Search p95: ${input.performance.searchP95Ms === null ? "not measured" : `${input.performance.searchP95Ms.toFixed(2)} ms`}</li><li>First-token median: ${input.performance.firstTokenMedianMs === null ? "not measured" : `${input.performance.firstTokenMedianMs.toFixed(2)} ms (${input.performance.firstTokenReleaseEligible ? "release-eligible" : "diagnostic only"})`}</li><li>Memory-searchable p95: ${input.performance.memorySearchableP95Ms === null ? "not measured" : `${input.performance.memorySearchableP95Ms.toFixed(2)} ms (${input.performance.memorySearchableReleaseEligible ? "release-eligible" : "diagnostic only"})`}</li><li>Eligibility notes: ${escapeHtml(input.performance.eligibilityNotes.length ? input.performance.eligibilityNotes.join("; ") : "none")}</li><li>Source: ${escapeHtml(input.performance.source)}</li></ul>`
    : "<p>No release performance measurement attached.</p>";
  const htmlList = (items: readonly string[], empty: string): string => items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(empty)}</p>`;
  const htmlCompetitors = input.competitors.length
    ? `<ul>${input.competitors.map((record) => `<li><strong>${escapeHtml(record.product)}</strong> (${escapeHtml(record.date)}, ${escapeHtml(record.visibleModelSetting)}): ${percent(record.score)} — ${escapeHtml(record.notes)}<ul><li>Prompt protocol: ${escapeHtml(record.promptProtocol)}</li><li>Transcript handling: ${escapeHtml(record.transcriptHandling)}</li></ul></li>`).join("")}</ul>`
    : "<p>No black-box competitor runs recorded.</p>";
  const htmlDiagnostics = input.diagnostics?.length
    ? input.diagnostics.map((diagnostic) => `<section><h3>${escapeHtml(diagnostic.title)}</h3><p><strong>Status: ${escapeHtml(diagnostic.status.toUpperCase())}</strong></p><p>${escapeHtml(diagnostic.summary)}</p><pre><code>${escapeHtml(JSON.stringify(diagnostic.details, null, 2))}</code></pre></section>`).join("")
    : "<p>No additional diagnostics recorded.</p>";
  const markdown = `# ${escapeMarkdown(input.title)}

Generated: ${escapeMarkdown(input.generatedAt)}<br>
Revision: ${escapeMarkdown(input.provenance?.revision ?? "not recorded")}<br>
Environment: ${escapeMarkdown(input.provenance?.environment ?? "not recorded")}<br>
Configuration hash: \`${configHash}\`<br>
Result hash: \`${escapeMarkdown(input.resultHash ?? "not supplied")}\`<br>
Recorded API cost: $${input.budgetTotalUsd.toFixed(2)}

${evidenceNotice}

## Configuration

\`\`\`json
${configurationJson}
\`\`\`

## Controlled results

${markdownTable(input.metrics)}

## ${evidenceClass === "no-cost-fixture" ? "Diagnostic gate-shaped checks (not release evidence)" : "Release gates"}

${gateMarkdown}

## Component ablations

${ablationMarkdown}

## Performance measurements

${performanceMarkdown}

## Diagnostic interpretation

${diagnosticsMarkdown}

## Black-box product comparison

These results describe visible product behavior. Internal prompts, compaction, retrieval, model versions, and token accounting are not controlled and must not be interpreted as causal evidence.

${competitorMarkdown}

## Representative successes

${input.representativeSuccesses.map((item) => `- ${escapeMarkdown(item)}`).join("\n") || "_None selected._"}

## Representative failures

${input.representativeFailures.map((item) => `- ${escapeMarkdown(item)}`).join("\n") || "_None selected._"}

## Limitations

${limitationsMarkdown}
`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>${escapeHtml(input.title)}</title>
  <style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#182033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd2df;padding:8px;text-align:right}th:first-child,td:first-child{text-align:left}.pass{color:#087443}.miss{color:#b42318}.unknown{color:#6b7280}.notice{padding:14px;border:1px solid #d6a100;background:#fff8d8;border-radius:8px}code{overflow-wrap:anywhere}pre{overflow:auto;padding:12px;background:#f4f6fa;border-radius:8px}</style>
</head>
<body>
  <h1>${escapeHtml(input.title)}</h1>
  <p>Generated ${escapeHtml(input.generatedAt)} · Revision ${escapeHtml(input.provenance?.revision ?? "not recorded")} · Environment ${escapeHtml(input.provenance?.environment ?? "not recorded")} · Config <code>${configHash}</code> · Result <code>${escapeHtml(input.resultHash ?? "not supplied")}</code> · Cost $${input.budgetTotalUsd.toFixed(2)}</p>
  <p class="notice">${escapeHtml(evidenceNotice.replaceAll("**", ""))}</p>
  <h2>Configuration</h2>
  <pre><code>${escapeHtml(configurationJson)}</code></pre>
  <h2>Answer accuracy</h2>
  ${chartSvg(input.metrics)}
  <h2>Controlled results</h2>
  <table><thead><tr><th>Mode</th><th>Accuracy</th><th>Accuracy 95% CI</th><th>Recall@10</th><th>Temporal</th><th>Tokens</th><th>Cost</th><th>Median latency</th></tr></thead><tbody>${input.metrics.map((item) => `<tr><td>${escapeHtml(item.mode)}</td><td>${percent(item.answerAccuracy)}</td><td>${percent(item.accuracyConfidence95[0])}–${percent(item.accuracyConfidence95[1])}</td><td>${percent(item.retrievalRecallAt10)}</td><td>${percent(item.temporalAccuracy)}</td><td>${item.cumulativeInputTokens}</td><td>$${item.cumulativeCostUsd.toFixed(2)}</td><td>${item.medianResponseLatencyMs.toFixed(0)} ms</td></tr>`).join("")}</tbody></table>
  <h2>${evidenceClass === "no-cost-fixture" ? "Diagnostic checks (not release evidence)" : "Release gates"}</h2>
  <ul>${gates.map((gate) => `<li class="${gateClass(gate)}">${gateStatus(gate)}: ${escapeHtml(gate.name)} — ${escapeHtml(gate.target)}; actual ${escapeHtml(gateActual(gate))}</li>`).join("")}</ul>
  <h2>Component ablations</h2>
  <table><thead><tr><th>Configuration</th><th>Disabled</th><th>Accuracy</th><th>Recall@10</th><th>Temporal</th><th>Tokens</th></tr></thead><tbody>${(input.ablations ?? []).map((entry) => `<tr><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(entry.disabledFeature ?? "none")}</td><td>${percent(entry.answerAccuracy)}</td><td>${percent(entry.retrievalRecallAt10)}</td><td>${percent(entry.temporalAccuracy)}</td><td>${entry.cumulativeInputTokens}</td></tr>`).join("")}</tbody></table>
  <h2>Performance measurements</h2>
  ${htmlPerformance}
  <h2>Diagnostic interpretation</h2>
  ${htmlDiagnostics}
  <h2>Black-box comparison</h2>
  <p>Visible behavior only; internal systems are uncontrolled.</p>
  ${htmlCompetitors}
  <h2>Representative successes</h2>
  ${htmlList(input.representativeSuccesses, "None selected.")}
  <h2>Representative failures</h2>
  ${htmlList(input.representativeFailures, "None selected.")}
  <h2>Limitations</h2>
  ${htmlList(input.limitations ?? [], "No additional limitations recorded.")}
</body>
</html>`;
  return {
    markdown,
    html,
    rawJsonl: input.runs.map((run) => JSON.stringify(run)).join("\n"),
    configHash,
    gates
  };
}
