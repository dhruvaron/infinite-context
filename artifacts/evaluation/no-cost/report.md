# Continuum deterministic no-cost evaluation

Generated: 2026-07-13T22:56:24.583Z<br>
Revision: uncommitted workspace \(HEAD unresolved\)<br>
Environment: darwin/arm64; Node v22.22.3<br>
Configuration hash: `f4d5ebbb21ea84ac9072dce3d3be5d2af3c059ee2ea4fa511138e49a92f6622f`<br>
Result hash: `58ec69f914138da8a5b8775d261c612b6891f0d1cfa7fc6255bcdd383464af65`<br>
Recorded API cost: $0.00

**Evidence status: deterministic no-cost fixture.** These results verify evaluator wiring, reproducibility, baseline isolation, and report generation. They are not live-model benchmark evidence and cannot establish the product's accuracy, latency, or token-savings claims.

## Configuration

```json
{
  "evaluationClass": "deterministic-no-cost-fixture",
  "dataset": "InfiniteBuild",
  "datasetVersion": "1.0.0",
  "generatorHash": "8fe1510bdd60342ee90f8d8f56da1d831e186b290bb45dca41d040f5e56f2422",
  "seed": 20260713,
  "messages": 10000,
  "checkpoints": [
    100,
    1000,
    5000,
    10000
  ],
  "responseProvider": "deterministic rule fixture; no model",
  "repetitions": 1,
  "stochastic": false,
  "inputBudgetPerProbe": 4096,
  "outputBudgetPerProbe": 256
}
```

## Controlled results

| Mode | Accuracy | Accuracy 95% CI | Recall@10 | Temporal | Input tokens | Cost | Median latency |
|---|---:|---:|---:|---:|---:|---:|---:|
| recent_window | 46.6% | 33.9%–59.3% | 15.9% | 25.8% | 171563 | $0.00 | 0 ms |
| rolling_summary | 92.0% | 84.3%–99.6% | 15.9% | 90.3% | 140807 | $0.00 | 0 ms |
| flat_hybrid | 100.0% | 100.0%–100.0% | 100.0% | 100.0% | 109804 | $0.00 | 0 ms |
| continuum | 100.0% | 100.0%–100.0% | 100.0% | 100.0% | 110785 | $0.00 | 0 ms |

## Diagnostic gate-shaped checks (not release evidence)

- MISS: Accuracy over rolling summary (>= 15% relative; actual 8.7%)
- PASS: Retrieval Recall@10 (>= 90%; actual 100.0%)
- PASS: Current/superseded accuracy (>= 90%; actual 100.0%)
- PASS: Unsupported personal memory (< 2%; actual 0.0%)
- PASS: Prompt-token savings at 10k (>= 60%; actual 97.6%)
- NOT MEASURED: Median latency overhead (<= 25% vs flat hybrid; actual not measured)
- PASS: Local search p95 (< 500 ms at 100k messages; actual 4.0 ms)
- NOT MEASURED: First streamed token (<= 3,000 ms under normal provider conditions; actual not measured)
- NOT MEASURED: Memory searchable after turn (<= 10,000 ms; actual not measured)

## Component ablations

| Configuration | Disabled | Accuracy | Recall@10 | Temporal | Input tokens | Runs |
|---|---|---:|---:|---:|---:|---:|
| Full deterministic Continuum fixture | none | 100.0% | 100.0% | 100.0% | 110519 | 43 |
| Without lexical retrieval | lexical | 98.2% | 98.8% | 100.0% | 108631 | 43 |
| Without vector-like semantic concepts | vector | 100.0% | 100.0% | 100.0% | 110586 | 43 |
| Without deterministic reranking | reranking | 100.0% | 100.0% | 100.0% | 110519 | 43 |
| Without temporal policy | temporal | 100.0% | 100.0% | 100.0% | 110367 | 43 |
| Without durable topic-page signal | topicPages | 100.0% | 100.0% | 100.0% | 110519 | 43 |
| Without graph relation expansion | graph | 100.0% | 100.0% | 100.0% | 109690 | 43 |

## Performance measurements

- Search p95: 4.03 ms
- First-token median: not measured
- Memory-searchable p95: not measured
- Eligibility notes: No latency/searchability artifact attached.
- Source: load=artifacts/evaluation/load-full.json; latency=not attached

## Diagnostic interpretation

### 15% relative accuracy gate feasibility

Status: BLOCKED

The deterministic Continuum fixture is already at 100% while rolling summary is 92.0%. A 15% relative lift would require 105.8% accuracy, which is impossible. Flat/Continuum parity and 5 unchanged ablations show that this small rule-backed fact set is saturated; it cannot substantiate the release effect-size claim.

```json
{
  "targetRelativeImprovement": 0.15,
  "actualRelativeImprovement": 0.08745247148288973,
  "rollingAccuracy": 0.9195804195804196,
  "continuumAccuracy": 1,
  "requiredContinuumAccuracy": 1.0575174825174825,
  "maximumPossibleRelativeImprovement": 0.08745247148288973,
  "mathematicallyReachableOnThisRun": false,
  "continuumAtCeiling": true,
  "flatContinuumParity": true,
  "unchangedAblations": [
    "Without vector-like semantic concepts",
    "Without deterministic reranking",
    "Without temporal policy",
    "Without durable topic-page signal",
    "Without graph relation expansion"
  ],
  "rollingMisses": [
    {
      "datasetId": "infinite-build-8fe1510bdd60",
      "probeId": "ib-1000-alice-language",
      "checkpoint": 1000,
      "answer": "I don't know.",
      "score": 0.08333333333333337
    },
    {
      "datasetId": "infinite-build-8fe1510bdd60",
      "probeId": "ib-5000-alice-language",
      "checkpoint": 5000,
      "answer": "I don't know.",
      "score": 0.08333333333333337
    },
    {
      "datasetId": "infinite-build-8fe1510bdd60",
      "probeId": "ib-10000-alice-language",
      "checkpoint": 10000,
      "answer": "I don't know.",
      "score": 0.08333333333333337
    },
    {
      "datasetId": "infinite-build-8fe1510bdd60",
      "probeId": "ib-10000-bounded-graph",
      "checkpoint": 10000,
      "answer": "I don't know.",
      "score": 0.21153846153846156
    }
  ],
  "conclusion": "fixture-saturated",
  "explanation": "The deterministic Continuum fixture is already at 100% while rolling summary is 92.0%. A 15% relative lift would require 105.8% accuracy, which is impossible. Flat/Continuum parity and 5 unchanged ablations show that this small rule-backed fact set is saturated; it cannot substantiate the release effect-size claim."
}
```

## Black-box product comparison

These results describe visible product behavior. Internal prompts, compaction, retrieval, model versions, and token accounting are not controlled and must not be interpreted as causal evidence.

_No black-box competitor runs recorded._

## Representative successes

- ib-100-alice-language: selected 10 evidence item\(s\) and produced "Rust"
- ib-100-codename: selected 2 evidence item\(s\) and produced "Northstar"
- ib-100-codename-return: selected 10 evidence item\(s\) and produced "Northstar"
- ib-100-db-current: selected 4 evidence item\(s\) and produced "PostgreSQL replaced MongoDB."
- ib-100-db-original: selected 4 evidence item\(s\) and produced "MongoDB"
- ib-100-launch: selected 10 evidence item\(s\) and produced "The launch month is unresolved between September and October."
- ib-100-pet: selected 0 evidence item\(s\) and produced "I don't know; no retained evidence provides a pet's name."
- ib-100-quote: selected 3 evidence item\(s\) and produced "One timeline, no context tax."

## Representative failures

- recent\_window/ib-1000-alice-language: answer was "I don't know."
- recent\_window/ib-1000-codename: answer was "I don't know; no codename evidence was selected."
- recent\_window/ib-1000-codename-return: answer was "I don't know; no codename evidence was selected."
- recent\_window/ib-1000-db-current: answer was "I don't know."
- recent\_window/ib-1000-db-original: answer was "I don't know."
- recent\_window/ib-1000-quote: answer was "I don't know the exact wording."
- recent\_window/ib-1000-theme: answer was "I don't know."
- recent\_window/ib-5000-alice-language: answer was "I don't know."

## Limitations

- No OpenAI, ChatGPT, Codex, embedding, reranking, or judge call was made.
- Answers and semantic concepts come from deterministic rules. Accuracy values validate evaluation wiring and fixture sensitivity, not general model quality.
- Latency values in answer runs are fixture placeholders. Only an attached full local-load report may contribute a measured 100k SQLite search p95.
- Ablations disable deterministic fixture signals and do not prove the effect size of production lexical, vector, temporal, wiki, reranking, or graph components.
- Public LongMemEval/HaluMem inputs and black-box competitor runs are not included in this no-cost command.
- Live controlled evaluation, three stochastic repetitions, first-token latency, and post-turn memory-searchability remain required before release claims can be made.
