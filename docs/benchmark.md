# Benchmark and evidence protocol

Continuum keeps evidence classes separate. A deterministic fixture, a local performance measurement, a controlled paid model run, and a black-box product capture answer different questions and must not be merged into one headline score.

| Evidence class | What it can establish | What it cannot establish |
|---|---|---|
| Deterministic no-cost fixture | Reproducibility, evaluator wiring, baseline input ceilings, report/gate calculations, fixture sensitivity | General model quality, production retrieval advantage, live latency, ChatGPT/Codex superiority |
| Local load profile | SQLite scale, search/timeline latency, integrity, process and disk observations on the recorded machine | Interactive ingestion, extraction/OCR, provider, or cross-machine performance |
| Latency/searchability harness | First streamed token and post-turn derived-memory searchability through a running isolated Continuum instance | Release latency unless the provider is live, conditions are attested, and every sample completes |
| Controlled paid runner | Same model/reasoning/token ceilings/questions/repetitions across modes, provider usage, durable cost accounting | Final release claim while it uses the portable smoke retriever and lacks an independent semantic/grounding judge |
| Production causal runner | Actual worker/compiler, SQLite candidate index, vectors, retrieval engine, learned recursive summary, separately modeled grounding judge, and run-bound human audit | ChatGPT/Codex superiority or interactive latency; those remain separate evidence classes |
| Manual black-box capture | Visible ChatGPT or Codex behavior under a recorded protocol | Causal architectural conclusions or claims about hidden compaction, prompts, retrieval, routing, or token use |

## Deterministic no-cost fixture

```bash
pnpm eval:no-cost
pnpm evidence:no-cost
```

The first command generates a seeded 10,000-message InfiniteBuild history, one manually authored scenario, four controlled context modes, and six feature-removal ablations. The second first runs the full local-load profile and attaches its eligible 100,000-message search result. Neither command reads an API key or makes a provider, embedding, judge, ChatGPT, or Codex call.

Artifacts are written to `artifacts/evaluation/no-cost/`: `report.md`, `report.html`, `runs.jsonl`, and `summary.json`. The report records configuration/result hashes, revision, environment, confidence intervals, successes, failures, zero live calls, and zero cost.

### Honest 15% gate diagnosis

The checked-in full deterministic run does not meet the “15% relative accuracy over rolling summary” gate. Full Continuum reaches 100%, while rolling summary reaches about 92%, so the maximum possible relative lift is about 8.7%. Meeting 15% on those exact runs would require more than 105% accuracy. Flat/Continuum parity and five unchanged feature ablations further show that this small rule-backed fact set is saturated.

This is a precise fixture limitation, not a reason to weaken the target, change the grader, or intentionally damage the rolling baseline. `summary.json` records the formula, required accuracy, maximum reachable lift, unchanged ablations, and every rolling miss. Public and controlled-live evidence must decide the actual product claim.

## Local storage/load evidence

```bash
pnpm load:quick
pnpm load:full
```

Quick mode uses 10,000 events and 1,000 topics for CI. Full mode uses the migrated SQLite schema with 100,000 events, 10,000 topic pages, and five GiB of logical sparse attachment files plus source/attachment metadata. It measures insertion wall time, FTS search latency, timeline-page latency, database size, process RSS, integrity, and vector mode.

The sparse corpus is not extraction/OCR/hash-throughput evidence. Bulk transactional insertion is not interactive ingestion latency. Results are machine-specific. Only a full 100,000-message result can populate the report’s local-search gate.

## Public benchmark import

Continuum contains adapter code and synthetic format fixtures, not redistributed benchmark records. Download originals yourself from each publisher, retain their terms, and import them locally.

### Registry-pinned sources

LongMemEval’s [official repository and schema](https://github.com/xiaowu0162/LongMemEval) and [cleaned dataset card](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) identify the MIT license. The importer currently pins:

| Variant | Publisher file | SHA-256 |
|---|---|---|
| `s-cleaned` | `longmemeval_s_cleaned.json` | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| `oracle` | `longmemeval_oracle.json` | `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` |
| `m-cleaned` | `longmemeval_m_cleaned.json` | `9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f` |

HaluMem’s [official repository](https://github.com/MemTensor/HaluMem) and [dataset card/schema](https://huggingface.co/datasets/IAAR-Shanghai/HaluMem) identify CC-BY-NC-ND-4.0. The importer pins:

| Variant | Publisher file | SHA-256 |
|---|---|---|
| `medium` | `HaluMem-Medium.jsonl` | `486fbc130a5c8781a2af27ffa508a1d7855245137aa449c193ac4d29c45634e7` |
| `long` | `HaluMem-Long.jsonl` | `dfdbed570b402b7b8c17e0d7808fc6f3ae7a53b6144f18feb16bbdd3f55cb0c9` |

HaluMem is deliberately excluded from the project evidence bundle. Its publisher labels it `CC-BY-NC-ND-4.0`; accordingly, this project does not download, normalize, execute, commit, or redistribute HaluMem data or adapted output. The registry entries remain verification metadata only. Any operator considering separate local use must independently review the upstream terms first. Continuum’s MIT license does not replace a dataset’s separate license.

### Import commands

```bash
pnpm eval:import-dataset -- \
  --dataset longmemeval \
  --variant oracle \
  --input .continuum/public-datasets/longmemeval_oracle.json \
  --output .continuum/evaluation-imports/longmemeval-oracle \
  --acknowledge-license MIT
```

The command hashes the entire input before parsing and rejects bytes that differ from the registry. It then writes one isolated normalized evaluation timeline per LongMemEval question or HaluMem user to `datasets.jsonl`, plus `import-manifest.json` containing source revision, input hash, license, output hash, counts, completeness, and redistribution warning. The LongMemEval JSON-array reader streams one top-level record at a time, including the multi-gigabyte `m-cleaned` variant.

Parsing rehashes the exact byte stream it consumes and refuses finalization if the source changes after the initial registry check. Input/output aliases, symlinked or special output files, and implicit overwrites are rejected. To intentionally replace an existing import, rerun with `--overwrite`; the replacement is written to exclusive temporary files and renamed into place. A later paid runner independently checks the manifest fields against the built-in registry and rehashes `datasets.jsonl` before accepting it. These hashes detect accidental changes and ordinary path races; they are local integrity checks, not signatures from the upstream publisher or protection from an operator deliberately forging both a normalized file and its local manifest.

`--limit-records N` is useful for a local smoke conversion. The manifest marks such output incomplete. Synthetic field-layout fixtures live under `fixtures/public-datasets/`; their manifest explicitly says they contain no upstream records and cannot be scored as either public benchmark.

## Controlled paid response runner

Start with a no-call preflight. It validates normalized input, its import manifest/hash, the mode set, record/probe limits, and prints the maximum reservation:

```bash
pnpm eval:live -- \
  --input-datasets .continuum/evaluation-imports/longmemeval-s/datasets.jsonl \
  --import-manifest .continuum/evaluation-imports/longmemeval-s/import-manifest.json \
  --max-records 5 \
  --max-probes 5 \
  --repetitions 3
```

No API key is read and no call is made without all four paid-run controls below:

```bash
CONTINUUM_LIVE_TESTS=true \
CONTINUUM_EVALUATION_OPENAI_API_KEY='set-outside-shell-history-when-possible' \
pnpm eval:live -- \
  --execute \
  --allow-live \
  --acknowledge-paid-api \
  --input-datasets .continuum/evaluation-imports/longmemeval-s/datasets.jsonl \
  --max-records 5 \
  --max-probes 5 \
  --repetitions 3 \
  --model gpt-5.4-mini
```

The runner uses the OpenAI Responses API through the application provider, with provider storage disabled (`store: false` in the provider implementation), web search/tools disabled, and identical model/reasoning/input/output settings across selected modes. Credential presence and format are prechecked before a durable plan can be created; the dedicated evaluation key is consumed only after durable budget admission passes, then removed from `process.env`, passed as an explicit in-memory evaluation override, and never written to artifacts. Normal application configuration does not parse either this variable or the legacy `CONTINUUM_OPENAI_API_KEY` name and remains Keychain-only.

This runner is deliberately labeled preliminary: its public-data retriever is transparent portable lexical/current-state logic rather than the production wiki/vector/graph path, its rolling summary is deterministic for cost control, and it has no independent live semantic/grounding judge. It writes raw responses and usage but does not generate release gates. This keeps a useful, bounded paid smoke run from being misrepresented as the final causal benchmark.

## Production causal runner

The production causal runner closes the architectural limitations of the preliminary paid smoke runner. It imports the application’s real `JobProcessor.process(memory.compile)`, `SqliteCandidateIndex`, and `RetrievalEngine`; builds isolated SQLite state for every independent repetition; indexes raw and compiled vectors; preserves frozen benchmark timestamps; maps dataset IDs into production UUIDs and back into scored evidence IDs; and compares all four controlled context strategies under the same answer settings. The rolling baseline is a recursively learned model summary and never receives expected answers. A separately configured model judges only non-deterministic semantic and grounding cases from the visible context and acceptable-answer rubric; hidden evidence labels are not passed to it.

The same runner executes a full production control plus six causal feature-removal configurations: no lexical retrieval, no vector retrieval, no reranking, no temporal retrieval, no topic pages, and no graph expansion. These are actual `RetrievalEngine` feature flags, not post-hoc result filtering. The no-vector condition also suppresses the query-embedding call, so measured behavior and cost change together. All seven configurations share one independently compiled Continuum state per dataset repetition; state resets between repetitions.

Start with a preflight. It verifies the registry import and exact normalized bytes, validates the full normalized schema, and prints the maximum answer, summary, judge, and worker reservation. It creates neither a ledger nor an API call:

```bash
pnpm eval:causal -- \
  --input-datasets .continuum/evaluation-imports/longmemeval-oracle/datasets.jsonl \
  --import-manifest .continuum/evaluation-imports/longmemeval-oracle/import-manifest.json \
  --max-records 5 \
  --max-probes 5 \
  --repetitions 3 \
  --worker-reservation-usd 10
```

Use the no-cost production-path diagnostic to exercise the actual database, worker, vector/index, graph, and retrieval wiring with the mock provider. It can never become causal-claim eligible:

```bash
pnpm eval:causal -- \
  --execute-no-cost \
  --input-datasets .continuum/evaluation-imports/longmemeval-oracle/datasets.jsonl \
  --import-manifest .continuum/evaluation-imports/longmemeval-oracle/import-manifest.json \
  --max-records 1 \
  --max-probes 1 \
  --repetitions 1 \
  --output .continuum/evaluation-diagnostics/longmemeval-oracle-bounded-no-cost
```

This bounded command validates the complete import but deliberately runs only one of 500 records/probes. Its report must read **INELIGIBLE NO-COST PRODUCTION-PATH DIAGNOSTIC**; it is wiring evidence, not a live, complete, or product-superiority result.

Run the exact seeded custom 10,000-message InfiniteBuild corpus without preparing a file:

```bash
pnpm eval:causal -- \
  --execute-no-cost \
  --include-infinite-build \
  --repetitions 1 \
  --output artifacts/evaluation/causal/infinite-build-10k-diagnostic
```

`--include-infinite-build` always selects the complete built-in 10,000-message corpus and all frozen probes. Public/custom record limits do not truncate it. The artifact records the exact generator and dataset hashes. A causal-architecture release artifact must contain both complete registry-verified public evidence and this reproducible 10k custom source; either source alone remains ineligible.

A separately generated custom normalized JSONL stream is also supported:

```bash
pnpm eval:causal -- \
  --execute-no-cost \
  --custom-datasets /path/to/custom-datasets.jsonl \
  --custom-manifest /path/to/custom-manifest.json \
  --max-records 1 \
  --max-probes 12 \
  --output artifacts/evaluation/causal/custom-diagnostic
```

The custom manifest is mandatory and bounded: `schemaVersion: 1`, `evidenceClass: "custom-normalized-evaluation-dataset"`, an ISO `generatedAt`, nonempty `generator` and `protocol`, SHA-256 `normalizedSha256`, and exact positive `records`, `messages`, and `probes` counts. The runner rehashes the normalized file, validates every selected record/probe, and rejects partial selections whose counts differ from the manifest. This is reproducible local provenance, not a publisher signature or a public-benchmark substitute.

A paid run requires every explicit control, a pinned answer/summary model, a different pinned judge model, and a worker ceiling chosen from the dry-run plan:

```bash
CONTINUUM_LIVE_TESTS=true \
CONTINUUM_EVALUATION_OPENAI_API_KEY='set-outside-shell-history-when-possible' \
pnpm eval:causal -- \
  --execute \
  --allow-live \
  --acknowledge-paid-api \
  --input-datasets .continuum/evaluation-imports/longmemeval-oracle/datasets.jsonl \
  --import-manifest .continuum/evaluation-imports/longmemeval-oracle/import-manifest.json \
  --include-infinite-build \
  --max-records 5 \
  --max-probes 5 \
  --repetitions 3 \
  --model gpt-5.4-mini \
  --summary-model gpt-5.4-mini \
  --judge-model gpt-5.4-nano \
  --worker-reservation-usd 10 \
  --output artifacts/evaluation/causal/public-live-1
```

The selected record/probe limits must equal the complete manifest counts for the completeness gate; smoke subsets remain ineligible. All four modes and at least three repetitions are mandatory. Each repetition gets independently compiled state, while chronologically ordered probes inside that repetition reuse and increment the same state just as one real session would. Extraction stochasticity is therefore measured without recompiling the same history for every question. The learned rolling summary follows the same incremental lifecycle. Raw runs separately record product-operating usage (answer, rolling-summary, extraction, and embedding tokens) and judge usage as evaluation overhead. Synchronous retrieval is included in controlled response latency; background summary/compilation maintenance stays in its separate latency field. The artifact also breaks external budget charges into answers, summaries, and judge calls.

Before any paid call, the runner creates one atomic durable fence for the complete external plus production-worker plan, including every ablation answer and independent-judge call. Individual external calls are sub-reserved beneath that fence, and each fresh production database mirrors already allocated external/project spend. Success and uncertain failure conservatively charge the full planned fence; a known provider or worker overrun is durably recorded before execution fails. This intentionally spends reservation margin in the USD 60 final-evaluation allocation in exchange for never reusing uncertain credit. Output files are exclusive by default, atomically replaced only with `--overwrite`, and include `causal-result.json`, controlled `runs.jsonl`, `ablation-runs.jsonl`, `manual-audit.template.json`, and polished `report.md`/`report.html`.

Reports are generated only after strict artifact validation. They prominently label no-cost and missed-gate evidence ineligible, show every feature-removal delta (including unchanged results), preserve hard-false product-superiority/live-latency claims, and include budget, source provenance, eligibility gates, audit, representative successes/failures, implementation identity, limitations, and artifact hashes. Regenerate the report without an API call:

```bash
pnpm eval:causal -- \
  --report-artifact artifacts/evaluation/causal/public-live-1/causal-result.json \
  --output artifacts/evaluation/causal/public-live-1/report-regenerated
```

The initial result is ineligible until an independent human completes every sampled decision and rationale in the deterministic, context-configuration-stratified audit template. Its sample covers both controlled modes and feature-removal configurations. Attach it without rerunning or making any API call:

```bash
pnpm eval:causal -- \
  --finalize-artifact artifacts/evaluation/causal/public-live-1/causal-result.json \
  --manual-audit /path/to/completed-manual-audit.json \
  --output-artifact artifacts/evaluation/causal/public-live-1/causal-result.audited.json
```

Finalization binds the decisions to the exact raw-runs hash and deterministic sample, retains the reviewer decisions/rationales inside the artifact, recomputes the human-agreement gate, and rehashes the result. Artifact validation independently recomputes run coverage, metrics, budget arithmetic, audit summary, and every eligibility gate rather than trusting stored booleans.

Strict causal eligibility requires: paid live execution; complete registry-verified public input; the exact seeded InfiniteBuild 10k source; all controlled modes; all seven real production feature configurations; three complete repetitions; live worker/compiler use on every Continuum repetition; claims/wiki construction plus selection of compiled memory for each dataset; vectors and query embeddings wherever vector retrieval is enabled; learned rolling summaries; a distinct judge on every planned non-deterministic controlled and ablation run; a complete manual sample with at least 80% agreement; no run errors; and a safe shared budget. Full retrieval must measurably outperform no-graph or no-topic-pages on answer accuracy, Recall@10, or temporal accuracy—an unchanged ablation remains an honest gate miss. The runner also recomputes the frozen performance targets: at least 15% relative accuracy over rolling summary, Recall@10 of at least 90%, temporal accuracy of at least 90% on a nonempty temporal subset, unsupported-memory rate below 2%, at least 60% selected-context reduction at a 10,000-message checkpoint, and median end-to-end controlled latency no more than 25% above the highest-accuracy non-graph baseline. The lexical fixture reranker is the controlled reranker implementation, so removing it establishes the effect of that control but not production provider-reranker quality. Local hashes and reviewer identity are unsigned attestations, not publisher or human digital signatures.

`productSuperiorityClaim` and `liveLatencyClaim` are hard-coded false and recomputed as false by the validator. ChatGPT/Codex captures and the normal-provider interactive latency/searchability harness remain required, separate artifacts.

### Durable USD 100 controls

Application and evaluation traffic share the single canonical machine-local ledger at `~/Library/Application Support/Continuum/installation-budget-ledger.json`. Its USD 100 allowance is installation-lifetime and non-renewable: no UI, API, configuration, or CLI operation can reset it or authorize another cycle. `CONTINUUM_DATA_DIR` selects a vault but does not relocate or duplicate this credit authority, and paid CLIs reject `--ledger` overrides. The ledger is excluded from vault exports and backups by construction. Before the first evaluation call, the runner reserves the worst-case cost of the entire plan against the existing USD 25 development, USD 60 final-evaluation, and USD 15 contingency allocations and the one aggregate USD 100 cap. Normal application reservations draw from that same aggregate cap, so application spend reduces evaluation headroom and evaluation spend reduces application headroom.

The lock/atomic-rename ledger survives separate processes and crashes. Prices are pinned to the revision printed in the plan; unknown or embedding response models are rejected. Successful calls conservatively commit at least the full 1.5× pre-call reservation using locally priced token usage, so a smaller or missing provider estimate cannot release safety margin. A failed or interrupted call conservatively consumes its full reservation because billable status may be uncertain. Duplicate call IDs, malformed accounting state, unsafe schemas, allocation overflow, global overflow, and further calls after a recorded overrun are rejected. Ledger files are flushed before rename, the containing directory is flushed afterward, and only an old lock whose recorded process is no longer alive is recoverable. Nonessential work stops at USD 95.

## First-token and post-turn searchability measurement

Use an isolated data directory because the harness writes synthetic marker facts. It measures from immediately before the message POST to the first nonempty `response.delta`, then from `run.completed` until a derived `claim` or `topic` containing the marker is returned by search. A raw event match does not count.

```bash
pnpm eval:latency -- \
  --api-origin http://127.0.0.1:4317 \
  --session-token "$CONTINUUM_SESSION_TOKEN" \
  --samples 3 \
  --output artifacts/evaluation/latency/mock-diagnostic.json
```

Mock-provider runs populate measured diagnostic fields but are never release-eligible. A live instance additionally requires `CONTINUUM_LIVE_TESTS=true`, `--allow-live`, `--acknowledge-paid-api`, and `--normal-provider-conditions`. The harness sends the local session token only to an HTTP(S) loopback origin. It queries committed and reserved application budget before/after every sample, refuses a cap above USD 100, and checks the USD 95 reserve threshold immediately before every live message.

The artifact records every sample’s first-token, completion, post-turn searchability, total message-to-searchability, search attempts/server time, result object type, run/event IDs, and application-ledger delta. It includes a content hash. The report importer accepts `--latency-report path` only after checking that hash and recomputing provider class, sample completeness, budget safety, distributions, and release eligibility from the raw fields; it displays ineligible timings as “diagnostic only” and leaves the corresponding release gate “not measured.” The artifact is still an unsigned local measurement, so deliberate local fabrication remains outside the trust model.

## Manual ChatGPT/Codex black-box comparison

`fixtures/competitors/continuum-v1.protocol.json` defines the shared visible protocol. `capture.template.json` is intentionally blank and contains no result. Manually export/copy a transcript, freeze it, fill human scores/rationales and all accurate attestations, then run:

```bash
pnpm eval:competitors -- \
  --capture /path/to/chatgpt.capture.json \
  --capture /path/to/codex.capture.json \
  --output artifacts/evaluation/competitors/manual-run
```

The runner never signs in to or automates either product. It rejects templates, empty transcripts, missing attestations, transcript hash mismatches, unknown or duplicate scenarios, checkpoint drift, incomplete protocol coverage, duplicate capture IDs, duplicate transcript reuse, and protocol-hash drift. Every protocol scenario must be represented; use all-null metrics plus an evidence-based rationale when a checkpoint was not measurable. It hashes the exact transcript/protocol bytes it parsed and aggregates only explicitly supplied numeric scores; null stays “not scored.” Reports include no transcript text and escape capture metadata before Markdown rendering. They remain descriptive black-box evidence because internal behavior is unobserved.

## Required release gates

| Gate | Target |
|---|---:|
| Accuracy over rolling summary | at least 15% relative improvement |
| Retrieval Recall@10 | at least 90% |
| Current vs superseded accuracy | at least 90% |
| Unsupported personal-memory assertions | below 2% |
| Prompt-token reduction at 10k | at least 60% vs full replay |
| Median response overhead | no more than 25% vs strongest non-graph baseline |
| Search p95 | below 500 ms at 100k |
| First streamed token | targeted within 3 seconds |
| Post-turn memory searchable | within 10 seconds |

A missed gate remains a miss. An ineligible or absent measurement is “not measured,” never passed. Final evidence must include raw runs, config/result hashes, cost, confidence intervals, successes, failures, environment/revision, and analysis written without changing the dataset or grader after seeing results.

## Remaining release-evidence blockers

The production causal runner, real feature-removal ablations, exact InfiniteBuild/custom-source wiring, and causal Markdown/HTML reporting are implemented. Code is still not evidence that a paid experiment happened. The remaining work must not be inferred or fabricated:

- Execute complete registry-verified LongMemEval input together with InfiniteBuild 10k for three live repetitions under the shared durable ledger, then retain every ineligible/missed controlled or ablation gate as recorded. HaluMem remains outside the project evidence bundle because of its `CC-BY-NC-ND-4.0` boundary.
- Complete and attach the deterministic independent-human audit sample to that exact live run.
- Capture matched manual ChatGPT and Codex transcripts; none are checked in.
- Attach release-eligible live latency/searchability measurements from an isolated normal-provider run.
