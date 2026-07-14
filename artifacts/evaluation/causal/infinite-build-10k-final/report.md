# Continuum production causal benchmark

**INELIGIBLE NO-COST PRODUCTION-PATH DIAGNOSTIC.**

Generated: 2026-07-13T23:42:26.591Z<br>
Evidence class: production-path-no-cost-diagnostic<br>
Artifact result hash: `e19270b5a86b2913cd532eb1f5f9bab48fca884587a98cd6bd01a09b2765d2a8`

This report is derived only from the validated causal artifact. Product-superiority and live-latency claims are fixed to **false**; no ChatGPT, Codex, or live-interaction evidence is inferred from these runs.

## Protocol and budget

- Controlled modes: recent\_window, rolling\_summary, flat\_hybrid, continuum
- Production ablations: full, no\_lexical, no\_vector, no\_reranking, no\_temporal, no\_topic\_pages, no\_graph
- Repetitions: 1
- Answer calls: 473 (172 controlled + 301 ablation)
- Independent judge calls: 0
- Planned combined ceiling: $0.0000
- Durable plan charge: $0.0000; recorded production spend: $0.0000; hard cap: $100.00; safe: yes

## Dataset evidence

| Source | Kind | License | Datasets | Messages | Probes | Complete | Registry verified | Reproducible | Redistributable adaptation | Dataset hash |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| infinite-build:8fe1510bdd60342ee90f8d8f56da1d831e186b290bb45dca41d040f5e56f2422 | infinite-build-10k | MIT | 1 | 10000 | 43 | yes | no | yes | yes | `f66cd208fa74fedc7ae2d53babeb04f932a82960c8fec111d2d51a08aeedb042` |

## Controlled comparison

| Mode | Runs | Accuracy | 95% CI | Recall@10 | Temporal | Unsupported | Input tokens | Cost | Median response |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| recent\_window | 43 | 23.2% | 13.8%–32.7% | 14.0% | 16.7% | 0.0% | 171913 | $0.0000 | 0.0 ms |
| rolling\_summary | 43 | 23.1% | 13.6%–32.6% | 14.0% | 16.7% | 0.0% | 169547 | $0.0000 | 0.0 ms |
| flat\_hybrid | 43 | 65.8% | 53.0%–78.6% | 86.0% | 73.3% | 0.0% | 153555 | $0.0000 | 47.1 ms |
| continuum | 43 | 65.6% | 52.7%–78.5% | 88.4% | 73.3% | 0.0% | 170177 | $0.0000 | 52.2 ms |

## Production feature-removal ablations

Every row was produced through the same production worker, SQLite candidate index, and retrieval engine. A positive “drop” means the full configuration performed better. A zero is reported as zero, not interpreted as evidence of benefit.

| Configuration | Disabled | Runs | Accuracy | Δ accuracy drop | Recall@10 | Δ recall drop | Temporal | Δ temporal drop | Input-token Δ |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| full | none | 43 | 65.6% | +0.0 pp | 88.4% | +0.0 pp | 73.3% | +0.0 pp | +0 |
| no_lexical | lexical | 43 | 45.7% | +19.9 pp | 59.3% | +29.1 pp | 43.3% | +30.0 pp | -10155 |
| no_vector | vector | 43 | 65.7% | -0.1 pp | 90.7% | -2.3 pp | 73.3% | +0.0 pp | -840 |
| no_reranking | reranking | 43 | 65.6% | +0.0 pp | 83.7% | +4.7 pp | 73.3% | +0.0 pp | +44 |
| no_temporal | temporal | 43 | 65.8% | -0.1 pp | 84.9% | +3.5 pp | 73.3% | +0.0 pp | -297 |
| no_topic_pages | topic_pages | 43 | 65.7% | -0.1 pp | 90.7% | -2.3 pp | 73.3% | +0.0 pp | -16930 |
| no_graph | graph | 43 | 65.6% | +0.0 pp | 89.5% | -1.2 pp | 73.3% | +0.0 pp | -1700 |

## Strict eligibility gates

- MISS: paid-live-execution — No-cost and dry-run artifacts are diagnostic only.
- MISS: registry-verified-complete-dataset — Requires registry pins, complete import, and every normalized record/probe.
- MISS: registry-public-source-evidence — At least one complete registry-verified public source must be represented in the exact run set.
- PASS: reproducible-infinite-build-10k — The exact seeded 10,000-message InfiniteBuild protocol must run alongside public evidence.
- PASS: all-controlled-modes — Recent, learned rolling, raw flat hybrid, and Continuum modes must all run.
- MISS: three-repetitions — Requires at least three complete repetitions of every planned run.
- MISS: actual-production-memory-path — Requires live JobProcessor compilation plus SqliteCandidateIndex/RetrievalEngine metadata on every memory run.
- PASS: knowledge-graph-built-and-used — Every Continuum repetition must build claims and a wiki page, and each dataset must select compiled rather than only raw memory at least once.
- MISS: learned-rolling-summary — The rolling baseline must use paid recursive model summaries, never expected answers or an oracle fixture.
- PASS: vector-retrieval-exercised — Both memory modes require indexed vectors and query embeddings in addition to lexical retrieval.
- MISS: independent-grounding-judge — Every non-deterministic run must be judged by a separately configured model.
- PASS: production-feature-removal-ablations — Full plus lexical, vector, reranker, temporal, topic-page, and graph removals must exercise exact production RetrievalEngine flags.
- MISS: graph-or-wiki-ablation-effect — Full retrieval must outperform no-graph or no-topic-pages on accuracy, Recall@10, or temporal accuracy; unchanged results remain an honest miss.
- MISS: human-audit-complete — The deterministic context-configuration-stratified human sample must be complete with at least 80% judge agreement.
- PASS: no-run-errors — Every controlled and ablation run must finish without an error.
- PASS: shared-budget-safe — Worker, retrieval, summarization, answer, and judge calls must fit the atomic shared USD 100 plan.
- PASS: accuracy-lift-over-rolling — Continuum answer accuracy must improve by at least 15% relative to learned rolling summary.
- MISS: retrieval-recall-at-10 — Continuum Retrieval Recall@10 must be at least 90%.
- MISS: current-state-temporal-accuracy — At least one temporal probe is required and current/superseded accuracy must be at least 90%.
- PASS: unsupported-memory-rate — Unsupported personal-memory assertions must remain below 2%.
- PASS: prompt-reduction-at-10k — At least one 10,000-message Continuum checkpoint is required and average selected context must be at least 60% smaller than full replay.
- PASS: response-overhead — Median end-to-end controlled response latency must be no more than 25% above the highest-accuracy non-graph baseline \(fastest wins ties\).

Overall causal-architecture eligibility: **INELIGIBLE**.

## Independent manual audit

Incomplete: 0/20. Until a bound independent review is attached, the human-audit gate remains a miss.

## Implementation identity

- Worker/compiler: JobProcessor.process\(memory.compile\)
- Candidate index: SqliteCandidateIndex
- Retrieval engine: RetrievalEngine
- Rolling summary: no-cost-nonlearned-diagnostic
- Answer provider: NoCostContextAnswerProvider
- Grounding judge: none
- Reranker control: LexicalFixtureReranker held constant across controlled modes and explicitly disabled only for no\_reranking

## Representative successes

- infinite-build-8fe1510bdd60 · ib-10000-db-original · continuum / no\_topic\_pages — answer: “We decided the production database will be MongoDB.”; expected: MongoDB; score: 100.0%
- infinite-build-8fe1510bdd60 · ib-1000-db-original · flat\_hybrid — answer: “We decided the production database will be MongoDB.”; expected: MongoDB; score: 100.0%
- infinite-build-8fe1510bdd60 · ib-10000-codename · continuum / no\_topic\_pages — answer: “Remember this: the application codename is Northstar.”; expected: Northstar; score: 100.0%

## Representative failures

- infinite-build-8fe1510bdd60 · ib-5000-launch · continuum / no\_graph — answer: “A separate stakeholder says the launch window is October; do not resolve this yet.”; expected: unresolved / September or October / not established; score: 21.3%
- infinite-build-8fe1510bdd60 · ib-1000-alice-language · continuum / no\_lexical — answer: “The immediate ui work is isolated and leaves the existing architecture unchanged.”; expected: Rust; score: 3.7%
- infinite-build-8fe1510bdd60 · ib-10000-bounded-graph · continuum / no\_reranking — answer: “Analyze our evidence and retain your conclusion about why graph expansion must be bounded.”; expected: prevent semantic drift and uncontrolled token growth / semantic drift; score: 21.3%

## Claim boundaries

- This artifact compares controlled context strategies; it does not establish superiority to ChatGPT or Codex without separate frozen manual black-box captures.
- Interactive first-token and post-turn-searchability claims require a separately validated live latency artifact and are never inferred from this offline runner.
- Controlled-mode comparisons hold the lexical fixture reranker constant; the no-reranking ablation isolates only that fixture's removal and is not evidence for the production provider reranker itself.

## Limitations

- A completed independent human audit is attached only after the run; the initial artifact remains ineligible until finalized without new API calls.
- Controlled response latency includes synchronous retrieval before answering; learned-summary and memory-compilation maintenance is reported separately and cannot replace the interactive live-latency harness.
- Public dataset licenses and registry pins remain separate from Continuum's MIT license.
- Provider and model behavior can change even when visible model names are pinned; preserve raw runs and dates.
