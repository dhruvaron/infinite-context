# Testing and release evidence

Release verdict: **NOT ACCEPTED**.

The current source schema is 18. With locked dependencies restored under Node 22, this hardening tree passed all-workspace typecheck, root lint, contract drift, conflict hygiene, 50 Vitest files with 470 tests, the production build, the native-ingestion smoke, the real macOS sandbox smoke, the static security audit, and all 26 executable Chromium/Firefox/WebKit journeys with 10 intentional browser-independent skips. Load and evaluation artifacts have not been regenerated. These are local current-tree results, not a frozen CI, fresh-checkout, live-provider, or competitor result. Recorded provider/API spend remains **USD 0.00**; no paid or normal-provider call was made.

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

## Current schema-18 local evidence

- `pnpm typecheck`: passed across all workspaces under Node 22.
- `pnpm lint`: passed at the repository root.
- `pnpm contracts:check`: passed with **81 public routes across all 26 section-11 resource groups**.
- Conflict hygiene: passed.
- `pnpm test`: passed **50 files and 470 tests**.
- `pnpm build`: passed. Vite emitted a non-fatal warning for a generated browser chunk larger than 500 kB; this is a performance follow-up, not a build failure.
- `pnpm audit:security`: passed with **0 findings**.
- `pnpm test:native-ingestion`: passed with the real local Apple Vision/PDFKit helper available.
- `pnpm test:macos-sandbox`: passed against the real macOS `sandbox-exec` backend for JavaScript/Python environment, filesystem, network, wall-time, output, and memory boundaries.
- `pnpm test:e2e`: passed all **26 executable journeys** across Chromium, Firefox, and WebKit with **10 intentional skips** for five browser-independent backend scenarios repeated only in Chromium. The final WebKit product pass was rerun after stabilizing an engine-specific stale-paint assertion.
- `pnpm load:full` and `pnpm eval:no-cost`: not regenerated on schema 18.

The Vitest result includes current local regression coverage for context-packet reconstruction, deletion and maintenance recovery, import exact-once behavior, schema-18 migration repair, embeddings and projection generation-token CAS, normalized confirmation proposals, browser bootstrap/settings/demo boundaries, and observability redaction. It does not replace fresh-checkout, frozen load, or live-provider evidence.

## Historical predecessor-tree evidence

The exact results and hashes below are retained as historical evidence from an earlier uncommitted/pre-hardening tree. They are not schema-18 results and must be regenerated from a frozen schema-18 revision before they can represent the current implementation.

### Browser and process journeys

Current schema-18 browser validation reached **26 passed, 10 intentionally skipped, 0 failed** across Chromium, Firefox, and WebKit. Chromium and Firefox completed in the full matrix; WebKit's backend reliability journeys completed there and all six WebKit product journeys passed in the final rerun after the stale-paint stabilization. This is automated local evidence, not a manual accessibility audit or frozen CI artifact.

| Coverage class | Chromium | Firefox | WebKit | Total |
|---|---:|---:|---:|---:|
| Six polished UI journeys plus persisted-response cancellation | 7 passed | 7 passed | 7 passed | 21 passed |
| Browser-independent workspace, sandbox, memory mutation, API crash, and worker crash boundaries | 5 passed | 5 intentional skips | 5 intentional skips | 5 passed, 10 skipped |
| Overall | 12 passed | 7 passed, 5 skipped | 7 passed, 5 skipped | **26 passed, 10 skipped, 0 failed** |

The skipped cases are browser-independent backend scenarios deliberately executed once in Chromium to avoid mutating the shared serial fixture three times. The cancellation path and every user-facing journey ran in all three engines.

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

The E2E supervisor is configured to use `.continuum/playwright`, a mock provider, fixed loopback ports, a dedicated session token, and test-only process controls that are not product routes. The reliability journeys assert the application budget remains at USD 0.

### Safety, security, and contracts

- Current `pnpm audit:security`: **0 findings**. The audit checks provider storage, browser secret persistence, raw HTML, shell execution, wildcard CORS, and API-key literals; dependency, VCS, build, and coverage paths are excluded.
- Current `pnpm test:macos-sandbox`: passed on the real macOS `sandbox-exec` backend for JavaScript/Python environment, filesystem, network, wall-time, output, and memory boundaries. The script fails rather than skips when the required backend is unavailable.
- Current `pnpm contracts:check`: **81 public routes across all 26 section-11 groups**. Shared Zod request/response contracts, generated types, server response enforcement, web runtime parsing, stable error envelopes, and versioned SSE are exercised by the current contract and API tests. The predecessor tree's 77-route result remains historical only.
- Current Vitest coverage checks reference-only context-packet composition, exact reconstruction, and stale/missing-body refusal.
- Current deletion and maintenance tests cover transitive resource cascades, closed mutation admission, fail-closed precommit rollback cleanup and post-commit cleanup, durable recovery metadata, projection/CAS cleanup, backup scrubbing, secure purge, whole-vault marker replay, and import-token exact-once recovery. Passing local fault injection is not a forensic secure-erasure guarantee or a fresh-process E2E result.
- Current embedding/projection/proposal tests cover exact-model and exact-generation isolation, no-cost reuse, stale completion races, inactive-source cleanup, embedding-model immutability, generation-plus-repair-token CAS, nonreused rebuild-job identities, normalized guarded acceptance, protected inline-to-sharded conversion, and reject-only legacy proposals with queued recompilation.
- Current web/API tests and browser journeys cover all-or-nothing core bootstrap, before/after vault-generation fencing, read-only last-verified retention, offline Search/Graph closure, exact demo snapshot restoration, deletion/import stream-and-cache invalidation, newest-run retry recovery, atomic settings persistence, durable provider-preset seeding, and ambiguous-import recovery.
- Current observability tests cover default content redaction, credential stripping even in trace mode, write-time durable consent lookup for the independent worker, lookup-failure redaction, serialized writes, flush, and size rotation.

### Long-session and evaluation evidence

- `artifacts/evaluation/no-cost/summary.json`: exact seeded InfiniteBuild fixture with 10,000 messages, USD 0 recorded cost, configuration hash `f4d5ebbb21ea84ac9072dce3d3be5d2af3c059ee2ea4fa511138e49a92f6622f`, and result hash `58ec69f914138da8a5b8775d261c612b6891f0d1cfa7fc6255bcdd383464af65`. It still misses the frozen relative-accuracy gate: 8.7% versus 15%.
- `artifacts/evaluation/load-full.json`: schema 11, native `sqlite-vec` v0.1.9 exact cosine mode, 100,000 events, 10,000 topics, integrity `ok`, 4.029 ms recorded local search p95, and 0.171 ms timeline-page p95. File SHA-256: `fc869b23bc2d55723a91d273414c98aae560dc0239c081a2360f8256e2ba8e4d`. Current source is schema 18, so this is historical storage/search evidence only: it proves neither current migration compatibility nor current integrity/performance, model recall, or interactive ingestion latency.
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

Current source scopes each `memory.compile` job to its explicit `sourceEventIds` instead of repeatedly treating accumulated history as new evidence. The following focused deterministic results were recorded on predecessor-tree stages with batch size 32 and embeddings off; the performance profiles were not regenerated on schema 18:

| Profile | Time | Claims | Topics | Compiler invocations | Interpretation |
|---|---:|---:|---:|---:|---|
| 1,000 messages before source-event scoping | 89,515 ms | 500 | 141 | 32 | Accidental repeat processing inflated work and outputs. |
| Same 1,000 messages after the fix | 583 ms | 23 | 6 | 32 | About 153.5× (~154×) faster in this observed profile, with duplicate reprocessing removed. |
| Standard InfiniteBuild 10,000, later compiler-only smoke | 4,393 ms | 15 | 6 | 313 | Fast sparse-durable fixture after mock-attribution tightening; this is not a dense-fact or current-revision result. |

These values are focused test/profile output, not a durable hashed performance artifact, cross-machine benchmark, or universal speedup claim. A distinct earlier 10,000-message compiler-only profile recorded 5,130 ms, 28 claims, and 6 topics. Because the revision and attribution configuration differ, neither 10k observation is a canonical result. Current worker structural regressions passed within the 50-file/470-test Vitest run, but that does not regenerate either historical profile.

An earlier intermediate full-path profile, before the later attribution and page-local changes, took 29,941 ms and produced 10,034 mock vectors/jobs at USD 0. It is retained only as diagnostic history and is not comparable to either compiler-only observation.

The historical red-team found severe write amplification on adversarial-but-valid all-durable streams. Stable section-local page shards, exact provenance comparison, and changed-page-only projection writes materially reduced it in that predecessor-tree profile, with embeddings off and batch size 32:

| Explicit durable turns | Before | After | Claims | Topics after | Compiles |
|---:|---:|---:|---:|---:|---:|
| 256 | 1,434 ms | 513 ms | 256 | 38 | 8 |
| 512 | 12,751 ms | 1,264 ms | 512 | 74 | 16 |

Before the historical page-local fix, doubling the input produced about 8.9× wall time; after it, the observed increase was about 2.46× and the 512-turn case was about 10× faster. A historical 256-plus-32 locality probe retained all 38 existing topic IDs, revised only 6 existing pages, added 5 pages and 11 revisions, kept all 288 source IDs in active provenance, and passed SQLite integrity checking.

Those results show reduced historical persistent-I/O amplification, not a true O(delta) compiler. Current source has locally tested normalized, fingerprint-guarded `topic_shard_patch` proposals whose planner is bounded to changed-claim memberships and touched shards for confirmation-only sharded topics, plus a normalized one-time conversion for a protected inline topic. Local regression coverage does not make the automatic, conversion, rebuild, proposal-resolution, or end-to-end compiler O(delta). The exact historical 10k fixture shows a long sparse-durable session path, not scalability to thousands of genuine facts. Dense-durable compilation remains an acceptance risk until frozen 1k/5k/10k profiles establish practical bounds and invariant output semantics.

## CI

`.github/workflows/ci.yml` defines:

- Linux lint, typecheck, contract drift, unit/integration tests, native-ingestion smoke, production build, and security audit.
- macOS Chromium, Firefox, and WebKit mock-mode E2E, with failure traces/screenshots/videos retained as CI artifacts.
- Deterministic evaluation and quick-load evidence, uploaded separately.
- macOS Node 22 typecheck, contract drift, unit tests, native ingestion, non-skippable OS sandbox smoke, and build.

These are workflow definitions, not a current CI outcome. No schema-18 CI run is claimed in this reconciliation.

Live OpenAI evaluation and manual black-box competitor operation never run automatically on pull requests. They require explicit reviewed invocation, protected credentials, all live/paid acknowledgement flags, and the shared durable budget ledger.

## Evidence still required before release acceptance

The available suite source and historical results do not substitute for these current-revision, external, or release-bound records:

- One complete single-revision run of all root gates after the schema-18 release revision is frozen, including regenerated 10k/100k artifacts. The 100k artifact must identify schema 18 rather than reusing the historical schema-11 result.
- Fresh-process restart evidence for bootstrap generation changes, import rollback/post-commit recovery, deletion cache non-resurrection, worker lease recovery, and exact idempotent response replay. Current local unit/integration fault injection is necessary but not sufficient for this record.
- A future embedding-model transition workflow with a complete cost preview, resumable migration, and final corpus validation. Current schema 18 intentionally refuses the change once an embeddable corpus or embedding work exists.
- A genuinely fresh macOS checkout startup and authenticated onboarding record, including real Keychain save/read/delete and proof that the key never reaches browser state, logs, SQLite, or exports.
- A complete paid causal run that combines registry-verified LongMemEval and the exact InfiniteBuild 10k source, all four modes, all seven production configurations, three repetitions, a distinct judge, and a completed bound human audit.
- Matched validated ChatGPT and Codex manual captures under the frozen visible protocol.
- A normal-provider first-token and post-turn compiled-memory-searchability artifact with complete samples and application-ledger deltas.
- Resolution or explicit continued disclosure of the deterministic 15% relative-accuracy gate miss.
- A durable dense-durable compiler profile at 1k, 5k, and 10k genuine facts with bounded latency/memory and invariant output semantics. Include automatic, confirmation-only sharded planning, protected inline conversion, proposal resolution, and rebuild paths; the historical 256/512 profile and locally unit-covered but unprofiled schema-18 planner do not establish full-compiler O(delta) behavior.

Every report must identify its fixture, environment, date, revision, configuration hash, provider-call count, and cost. A skipped live suite is **not measured**, never passed. A mock, deterministic, bounded, or incomplete result must keep its evidence-class label and cannot support a product-superiority or live-latency claim.
