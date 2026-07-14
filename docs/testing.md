# Testing and release evidence

Release verdict: **NOT ACCEPTED**.

The current source schema is 17. The installed dependency state was unusable during the 2026-07-14 hardening audit, and dependency restoration was not authorized, so no package-level typecheck, lint, contract, unit/integration, build, native-ingestion, macOS-sandbox, Playwright, load, or evaluation command ran on this revision. Source-only syntax/hygiene checks, artifact-hash verification, and raw SQLite migration smoke may be reported separately when completed, but they are not substitutes for the gates below. Recorded provider/API spend remains **USD 0.00**; no paid or normal-provider call was made.

## Local release gates

Run from a Node 22 source checkout:

```bash
pnpm typecheck
pnpm lint
pnpm contracts:check
pnpm test
pnpm build
pnpm audit:security
pnpm test:native-ingestion
pnpm test:macos-sandbox
pnpm test:e2e
pnpm load:full
pnpm eval:no-cost
```

`test:macos-sandbox` is intentionally non-skippable and is a macOS release gate. Tests require no API key. Provider behavior uses recorded or deterministic fixtures unless a suite is explicitly opt-in, live-enabled, paid-acknowledged, and guarded by the durable USD 100 budget fence.

The root Vitest configuration separates Node tests from jsdom web tests. Shared API drift is checked independently: `contracts:check` inventories every public route, requires every section-11 resource group, verifies mutation idempotency and list pagination declarations, and rejects unversioned SSE frames.

## Historical pre-schema-17 local evidence

The exact results and hashes below are retained as historical evidence from an earlier uncommitted/pre-hardening tree. They are not current-revision passes and must be regenerated from a frozen schema-17 revision.

### Browser and process journeys

The historically observed no-cost Playwright command result was **26 passed, 10 intentionally skipped, 0 failed** across Chromium, Firefox, and WebKit. This is predecessor-tree automated output; generated Playwright reports were removed after that pass, so this document does not present it as a durable manual/in-app browser-QA artifact or a schema-17 result.

| Coverage class | Chromium | Firefox | WebKit | Total |
|---|---:|---:|---:|---:|
| Six polished UI journeys plus persisted-response cancellation | 7 passed | 7 passed | 7 passed | 21 passed |
| Browser-independent workspace, sandbox, memory mutation, API crash, and worker crash boundaries | 5 passed | 5 intentional skips | 5 intentional skips | 5 passed, 10 skipped |
| Overall | 12 passed | 7 passed, 5 skipped | 7 passed, 5 skipped | **26 passed, 10 skipped, 0 failed** |

In that historical run, the skipped cases were browser-independent backend scenarios deliberately executed once in Chromium to avoid mutating the shared serial fixture three times. The cancellation path and every user-facing journey ran in all three engines. Current browser behavior remains unverified until Playwright is rerun.

`tests/e2e/mock-smoke.spec.ts` covers:

- onboarding, streaming, a grounded follow-up, local search, exact timeline jump, pinning, reload continuity;
- attachment processing, persisted source state, current deletion impact, and hard deletion;
- response regeneration/revisions and answer-specific provenance debug;
- backup, workspace authorization/revocation, export, verified import, and exact replacement;
- editable draft recovery through service outage, mobile layout, graph access, and keyboard search;
- current-impact plus exact-phrase full-vault destruction.

`tests/e2e/reliability-and-boundaries.spec.ts` covers:

- durable cancellation from the real composer, cancellation acknowledgement, and idempotent retry;
- a real read-only workspace root, lexical and symlink escape denial, exact one-use secret approval/consumption, and revocation;
- useful JavaScript execution plus disposable filesystem, host-file denial, and loopback-network denial through the real tool path;
- claim correction, temporal supersession, exact evidence traversal, entity merge, graph migration, and exact reversal;
- hard API crash/restart reconciliation without duplicate events/runs/stream records, including a second restart;
- worker crash, expired-lease reclamation, exactly-once derived vector state, idempotent reseeding, and a second restart.

The E2E supervisor is configured to use `.continuum/playwright`, a mock provider, fixed loopback ports, a dedicated session token, and test-only process controls that are not product routes. The reliability journeys assert the application budget remains at USD 0; those assertions were not rerun on schema 17.

### Safety, security, and contracts

- Historical `pnpm audit:security`: **0 findings**. The audit checks provider storage, browser secret persistence, raw HTML, shell execution, wildcard CORS, and API-key literals; dependency, VCS, build, and coverage paths are excluded. It was not rerun on schema 17.
- Historical `pnpm test:macos-sandbox`: the real macOS `sandbox-exec` backend passed JavaScript and Python environment, filesystem, network, wall-time, output, and memory boundaries. The script fails rather than skips when the required backend is unavailable; the current tree has no result.
- Historical `pnpm contracts:check`: **77 public routes across all 26 section-11 groups**. Shared Zod request/response contracts, generated types, server response enforcement, web runtime parsing, stable error envelopes, and versioned SSE have test source in `packages/contracts/src/api.test.ts` and `apps/api/src/product-closure.test.ts`. Migration 16 introduced normalized topic-shard proposal contracts; current schema-17 drift must be rerun.
- Context packet privacy/integrity test source in `apps/api/src/context-packets.test.ts` checks reference-only composition, exact reconstruction, and stale/missing-body refusal. Its predecessor-tree result is historical.
- Deletion test source covers claim, attachment, event, topic, downstream answer, run derivative, graph/page-link, vector, search, and shared-evidence cases. Current maintenance tests additionally target closed mutation admission, fail-closed post-commit cleanup, durable recovery metadata, projection/CAS cleanup, backup scrubbing, secure purge, and whole-vault marker replay. None ran on the schema-17 tree.
- Embedding test source targets exact-model search isolation, exact source-generation jobs, no-cost reuse of a current vector, stale completion races, inactive-source cleanup, and refusal to change the configured embedding model after any embeddable corpus or embedding work exists. Projection tests target generation-plus-repair-token CAS, including a newer concurrent dirty pair surviving an older repair and a deleted/reinserted generation-1 marker receiving a nonreused leaseable rebuild-job identity. Proposal tests target normalized guarded acceptance, one-time protected inline-to-sharded conversion, and refusal to accept unguarded legacy proposals. None of these package tests ran on the schema-17 tree.
- Observability test source in `packages/observability/src/observability.test.ts` checks default content redaction, credential stripping even in trace mode, runtime consent changes, serialized writes, flush, and size rotation. It was not rerun on schema 17.

### Long-session and evaluation evidence

- `artifacts/evaluation/no-cost/summary.json`: exact seeded InfiniteBuild fixture with 10,000 messages, USD 0 recorded cost, configuration hash `f4d5ebbb21ea84ac9072dce3d3be5d2af3c059ee2ea4fa511138e49a92f6622f`, and result hash `58ec69f914138da8a5b8775d261c612b6891f0d1cfa7fc6255bcdd383464af65`. It still misses the frozen relative-accuracy gate: 8.7% versus 15%.
- `artifacts/evaluation/load-full.json`: schema 11, native `sqlite-vec` v0.1.9 exact cosine mode, 100,000 events, 10,000 topics, integrity `ok`, 4.029 ms recorded local search p95, and 0.171 ms timeline-page p95. File SHA-256: `fc869b23bc2d55723a91d273414c98aae560dc0239c081a2360f8256e2ba8e4d`. Current source is schema 17, so this is historical storage/search evidence only: it proves neither current migration compatibility nor current integrity/performance, model recall, or interactive ingestion latency.
- Local ignored LongMemEval import (`.continuum/evaluation-imports/longmemeval-oracle/import-manifest.json`): all 500 oracle records, 10,960 messages, and 500 probes normalized from registry-verified MIT source bytes. Normalized SHA-256: `b75be49d51d2cd67901c80b687e66dfc863c759e83e0ef6a831f3c9fff32aab1`.
- Local ignored bounded LongMemEval diagnostic (`.continuum/evaluation-diagnostics/longmemeval-oracle-bounded-no-cost/report.md`): one record/probe/repetition, four controlled modes, full plus six real production feature removals, zero live calls, USD 0. It is explicitly ineligible and is only production-path wiring evidence.
- `artifacts/evaluation/causal/infinite-build-10k-diagnostic/causal-result.json`: complete exact InfiniteBuild 10k production-path diagnostic with 43 probes, four modes, full plus six real production feature-removal configurations, 172 controlled runs, 301 ablation runs, zero errors, and USD 0. Internal hashes: result `d6864864cdc6ce42ef884dc20fdd1527f9255b9f04e9fad6aa5a9fa156033026`, controlled runs `d822fc0fc09c32d0b5e9aa030fbc6cda66985a800171ade7c63597639f25f590`, ablation runs `d07b0c79b0381c9fa947c168e5dc9c822c892e6fe802ebe770be0cb55ded6803`, dataset `f66cd208fa74fedc7ae2d53babeb04f932a82960c8fec111d2d51a08aeedb042`, and generator `8fe1510bdd60342ee90f8d8f56da1d831e186b290bb45dca41d040f5e56f2422`.
- Raw file SHA-256 values for that diagnostic are `0270073f832cdac05c376583dc07a3aba1e1dff6c1c174862711052d866df24c` (`causal-result.json`), `74df00f18527ba17f66f2dd0411461f632d791e1327a49561729c9a01b20c660` (`runs.jsonl`), and `e1a87e094bc7e45e961955c7186b38032a28a811a83c42965619a37d0d43e96b` (`ablation-runs.jsonl`). Its recorded evaluated-run timestamps span 91.503 seconds from the first run record to the last, and 91.530 seconds from the first run record to artifact finalization. This excludes unrecorded process startup/preparation and is not an interactive latency metric.
- The production-path diagnostic records Continuum at 65.7% accuracy, 91.9% Recall@10, 73.3% temporal accuracy, 0% unsupported memory, 173,128 cumulative input tokens, and 52.7 ms median offline response preparation. Flat hybrid records 65.8%, 86.0%, 73.3%, 153,555 tokens, and 47.9 ms. The average 10k selected-context reduction is 98.6% versus full transcript replay, but Continuum does **not** use fewer cumulative input tokens than flat hybrid in this run.
- Temporal forensics preserve the failed gate: 22/30 expected-current-value probes passed (73.3%), and the explicit temporal/supersession subset passed 10/13 (76.9%). All eight expected-current-value misses had the correct source in retrieved evidence and failed identically under flat hybrid and every ablation; the exact-token-overlap no-cost answerer selected generic or obsolete codename/authentication/retention lines. This is evidence of a coarse mock responder limit, not proof that production temporal retrieval succeeds. The fixture and gate were not tuned after inspection.
- Feature removal is mixed: no lexical retrieval loses 11.7 accuracy points and 26.7 recall points; no topic pages loses 3.5 recall points; no graph loses 1.2 recall points. No vector reaches 100% Recall@10 with essentially unchanged accuracy, so this fixture does not demonstrate positive vector value. The artifact passes some gate-shaped checks but fails paid/public/three-repetition/live-worker/learned-summary/separate-judge/human-audit eligibility and the 90% temporal target. `artifacts/evaluation/causal/infinite-build-10k-diagnostic/report.md` labels the overall result **INELIGIBLE** and keeps product-superiority/live-latency claims false.
- `artifacts/evaluation/no-cost/report.md` separately discloses the saturated deterministic fixture's 8.7% relative-accuracy lift versus the frozen 15% target, flat-hybrid/Continuum parity, unchanged ablations, and unmeasured live gates. Do not blend it with the production-path diagnostic.
HaluMem is not project test evidence. The project records its registry metadata but does not download, normalize, execute, commit, or redistribute it because the publisher labels it `CC-BY-NC-ND-4.0`.

### Historical compiler performance red-team

Current source scopes each `memory.compile` job to its explicit `sourceEventIds` instead of repeatedly treating accumulated history as new evidence. The following focused deterministic results were recorded on predecessor-tree stages with batch size 32 and embeddings off; they were not rerun on schema 17:

| Profile | Time | Claims | Topics | Compiler invocations | Interpretation |
|---|---:|---:|---:|---:|---|
| 1,000 messages before source-event scoping | 89,515 ms | 500 | 141 | 32 | Accidental repeat processing inflated work and outputs. |
| Same 1,000 messages after the fix | 583 ms | 23 | 6 | 32 | About 153.5× (~154×) faster in this observed profile, with duplicate reprocessing removed. |
| Standard InfiniteBuild 10,000, later compiler-only smoke | 4,393 ms | 15 | 6 | 313 | Fast sparse-durable fixture after mock-attribution tightening; this is not a dense-fact or current-revision result. |

These values are focused test/profile output, not a durable hashed performance artifact, cross-machine benchmark, or universal speedup claim. A distinct earlier 10,000-message compiler-only profile recorded 5,130 ms, 28 claims, and 6 topics. Because the revision and attribution configuration differ, neither 10k observation is a canonical result. `apps/worker/src/processor.test.ts` contains structural regression source, but that test has not run on schema 17.

An earlier intermediate full-path profile, before the later attribution and page-local changes, took 29,941 ms and produced 10,034 mock vectors/jobs at USD 0. It is retained only as diagnostic history and is not comparable to either compiler-only observation.

The historical red-team found severe write amplification on adversarial-but-valid all-durable streams. Stable section-local page shards, exact provenance comparison, and changed-page-only projection writes materially reduced it in that predecessor-tree profile, with embeddings off and batch size 32:

| Explicit durable turns | Before | After | Claims | Topics after | Compiles |
|---:|---:|---:|---:|---:|---:|
| 256 | 1,434 ms | 513 ms | 256 | 38 | 8 |
| 512 | 12,751 ms | 1,264 ms | 512 | 74 | 16 |

Before the historical page-local fix, doubling the input produced about 8.9× wall time; after it, the observed increase was about 2.46× and the 512-turn case was about 10× faster. A historical 256-plus-32 locality probe retained all 38 existing topic IDs, revised only 6 existing pages, added 5 pages and 11 revisions, kept all 288 source IDs in active provenance, and passed SQLite integrity checking.

Those results show reduced historical persistent-I/O amplification, not a true O(delta) compiler. Current source has normalized, fingerprint-guarded `topic_shard_patch` proposals whose planner is bounded to changed-claim memberships and touched shards for confirmation-only sharded topics, plus a normalized one-time conversion for a protected inline topic. Those source paths remain current-validation-pending and do not make the automatic, conversion, rebuild, proposal-resolution, or end-to-end compiler O(delta). The exact historical 10k fixture shows a long sparse-durable session path, not scalability to thousands of genuine facts. Dense-durable compilation remains an acceptance risk until frozen 1k/5k/10k profiles establish practical bounds and invariant output semantics.

## CI

`.github/workflows/ci.yml` defines:

- Linux lint, typecheck, contract drift, unit/integration tests, native-ingestion smoke, production build, and security audit.
- macOS Chromium, Firefox, and WebKit mock-mode E2E, with failure traces/screenshots/videos retained as CI artifacts.
- Deterministic evaluation and quick-load evidence, uploaded separately.
- macOS Node 22 typecheck, contract drift, unit tests, native ingestion, non-skippable OS sandbox smoke, and build.

These are workflow definitions, not a current CI outcome. No schema-17 CI run is claimed in this reconciliation.

Live OpenAI evaluation and manual black-box competitor operation never run automatically on pull requests. They require explicit reviewed invocation, protected credentials, all live/paid acknowledgement flags, and the shared durable budget ledger.

## Evidence still required before release acceptance

The available suite source and historical results do not substitute for these current-revision, external, or release-bound records:

- One complete single-revision run of all root gates after the schema-17 release revision is frozen, including regeneration of 10k/100k artifacts. The 100k artifact must identify schema 17 rather than reusing the historical schema-11 result.
- Focused current-revision proposal coverage for normalized persistence/replay, topicless claims, protected inline-to-sharded conversion, current-to-history atomic patches, split/archive behavior, disjoint acceptance order, exact claim/evidence/route/content guards, legacy accept refusal, stale-CAS zero mutation, candidate FTS/graph/file isolation, rejection, crash recovery, and projection/embedding follow-up jobs.
- Focused current-revision projection repair and embedding coverage for concurrent dirty generation-token pairs, exact-pair CAS clearing, delete/reinsert generation-1 job-identity uniqueness, lease/crash/retry progress, exact-model retrieval, exact-generation job preflight and completion, no-cost vector reuse, stale completion isolation, inactive-source cleanup, and embedding-model immutability once an embeddable corpus exists. A future model-change workflow must be separately specified and tested with a cost preview, resumable migration, and final corpus validation.
- Focused current-revision deletion and maintenance fault injection covering admission drain, every post-commit cleanup step, nested topic/run cascades, CAS and projection fsync, managed-backup scrubbing, secure purge, idempotent repeated restart recovery, and the external whole-vault marker.
- Focused current-revision source replay coverage proving exact re-extraction is idempotent and changed source bytes remove stale derived claims, indexes, vectors, projections, and topic content before rebuild.
- A genuinely fresh macOS checkout startup and authenticated onboarding record, including real Keychain save/read/delete and proof that the key never reaches browser state, logs, SQLite, or exports.
- A complete paid causal run that combines registry-verified LongMemEval and the exact InfiniteBuild 10k source, all four modes, all seven production configurations, three repetitions, a distinct judge, and a completed bound human audit.
- Matched validated ChatGPT and Codex manual captures under the frozen visible protocol.
- A normal-provider first-token and post-turn compiled-memory-searchability artifact with complete samples and application-ledger deltas.
- Resolution or explicit continued disclosure of the deterministic 15% relative-accuracy gate miss.
- A durable dense-durable compiler profile at 1k, 5k, and 10k genuine facts with bounded latency/memory and invariant output semantics. Include automatic, confirmation-only sharded planning, protected inline conversion, proposal resolution, and rebuild paths; the historical 256/512 profile and unrun schema-17 planner do not establish full-compiler O(delta) behavior.

Every report must identify its fixture, environment, date, revision, configuration hash, provider-call count, and cost. A skipped live suite is **not measured**, never passed. A mock, deterministic, bounded, or incomplete result must keep its evidence-class label and cannot support a product-superiority or live-latency claim.
