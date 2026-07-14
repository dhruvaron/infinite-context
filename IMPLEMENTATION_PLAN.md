# Continuum v1 — Decision-Complete Implementation Plan

## 1. Product definition

Continuum is a local-first browser chat that presents one continuous conversation while preserving an unbounded local history. The underlying model still has a finite context window; Continuum provides an unbounded product-memory layer by storing every event, compiling durable knowledge into a source-linked wiki and graph, retrieving the right evidence for each turn, and allowing exact historical lookup when automatic retrieval is insufficient.

The v1 product is a polished general-purpose personal chat. Its architecture must support later evolution into a coding agent comparable in interaction model to Codex or Claude Code, but v1 will not modify repositories, run commands in real workspaces, manage Git branches, or orchestrate multiple agents.

### Binding product decisions

- Local browser application, optimized and verified for macOS.
- One canonical, effectively endless timeline; no chat/thread creation in v1.
- Single user; no accounts, cloud sync, teams, or hosted backend.
- OpenAI cloud inference with all durable application state stored locally.
- OpenAI implemented first behind provider-neutral interfaces.
- Text, code, PDF, image, JSON, CSV, and Markdown attachments are persistent sources.
- Web search, read-only access to explicitly authorized local roots, and isolated JavaScript/TypeScript and Python execution are included.
- Normal UI is a centered chat. Memory and technical details live in a collapsible right drawer.
- Unified search covers transcript events, wiki pages, claims, sources, and attachments and can jump to original evidence.
- An interactive knowledge-graph view is required, not a stretch goal.
- Source checkout and one-command startup are sufficient; no packaged desktop installer is required.
- Open source under the MIT license.
- No design area may be silently cut for schedule reasons. Memory quality, evaluation quality, product polish, attachments, and basic agent tools are all required.
- No deadline-driven scope reduction is permitted without an explicit user decision.

### Honest meaning of “infinite context”

Product copy must describe the feature as an unbounded, locally stored conversational memory that pages relevant evidence into a finite model context. The onboarding and technical documentation must explicitly state that the model does not attend to the complete transcript simultaneously. The user-facing guarantee is:

1. Every non-deleted conversation event is stored verbatim and remains addressable.
2. Relevant historical evidence is retrieved automatically whenever possible.
3. The model can search and open exact older evidence during a response.
4. Summaries never replace or destroy raw history.
5. Changed facts remain historically queryable while the latest supported state is distinguished.

## 2. Success criteria and research claims

The primary claim is that Continuum maintains better long-term conversational continuity than ordinary recent-window or rolling-summary approaches. The secondary claims are that it can do so with materially fewer prompt tokens than replaying long histories and that its memory is local, inspectable, correctable, and provenance-linked.

The defining product demonstration is a single conversation spanning the work that would normally be fragmented across roughly ten planning, research, design, troubleshooting, and implementation chats. V1 must demonstrate this at 10,000 messages. A separate local load test must establish acceptable storage and search behavior at 100,000 messages, 10,000 topic pages, and 5 GB of attachment metadata/content, without requiring live model processing of the full load fixture.

### Required benchmark gates

- At least 15% relative improvement in long-term answer accuracy over the rolling-summary baseline.
- Retrieval Recall@10 of at least 90% when relevant historical evidence exists.
- At least 90% accuracy on current-versus-superseded knowledge questions.
- Unsupported personal-memory assertions below 2% of evaluated answers.
- At least 60% fewer cumulative prompt tokens than full-history replay at the 10,000-message checkpoint.
- Median response latency no more than 25% above the strongest non-graph controlled baseline, excluding provider outages.
- Search p95 below 500 ms at the 100,000-message local load fixture before optional model reranking.
- First streamed response token targeted within three seconds under normal provider conditions.
- Ordinary post-turn memory changes searchable within ten seconds.

These are release gates, not claims to assume in advance. If a gate is missed, the final report must show the result and failure analysis rather than manipulating the benchmark.

### API-credit budget

The total OpenAI spend for implementation-time live testing and the final benchmark is capped at USD 100.

- USD 25: development smoke tests and prompt iteration.
- USD 60: final controlled and product-competitor evaluation.
- USD 15: reruns and contingency.
- Every model call records provider usage and estimated cost in a local budget ledger.
- Warning thresholds occur at USD 20, 50, 75, and 90.
- New nonessential live runs stop automatically at USD 95, preserving USD 5 for diagnosis.
- No call may be made after the recorded total reaches USD 100 without an explicit reset authorized by the user.
- Unit and integration tests use fixtures by default. Live tests are opt-in and budget-aware.

## 3. Technical architecture

### Repository and runtime

Use a pnpm TypeScript monorepo on the current Node.js LTS:

```text
apps/
  web/                 React/Vite browser UI
  api/                 Fastify local HTTP/SSE API
  worker/              durable background-job worker
packages/
  contracts/           Zod request, response, event, and domain schemas
  database/            SQLite connection, migrations, repositories, FTS/vector setup
  memory/              extraction, evidence ledger, topic compiler, linting
  retrieval/           candidate generation, fusion, graph traversal, reranking
  providers/           chat, embedding, reranker, search, and future-provider adapters
  tools/               memory, web, workspace-read, and sandbox tool implementations
  ingestion/           attachments, parsing, OCR, chunking, hashing
  evaluation/          datasets, runners, graders, reports, budget enforcement
  observability/       local structured logs, traces, cost and latency accounting
  config/              versioned presets and prompt/template loaders
fixtures/
  demo-vault/          immutable no-cost sample data
docs/                  architecture, privacy, benchmark, interchange format
```

Use React, Vite, TanStack Query, an accessible component primitive library, and a small app-owned design-token layer. Use Fastify for the API, Zod for shared validation, native `fetch`/OpenAI SDK for provider calls, and explicit SQL migrations with a lightweight typed query layer rather than a large ORM.

### Local process topology

A supervisor command starts the API and worker, selects an available loopback port, writes a protected runtime descriptor, and opens the browser. Development commands may start processes separately. The API binds only to `127.0.0.1` and rejects non-loopback hosts and origins.

- REST under `/api/v1` handles commands and resource reads.
- Server-Sent Events stream run events and background status.
- WebSockets are deferred until a future interactive coding-agent protocol requires bidirectional transport.
- The API and worker share SQLite but never share in-memory correctness state.
- The SQLite-backed job queue is durable, retryable, idempotent, and resumable after crashes.
- Jobs use leases and heartbeats so abandoned work can be reclaimed safely.
- All timestamps are UTC; IDs are UUIDv7.
- Prompts, schemas, presets, and migrations are versioned and recorded with affected artifacts.

### Local security boundary

- Generate a new browser session token on every backend launch.
- Require the token on all API and SSE requests.
- Enforce strict origin checking, CSRF protection, Content Security Policy, and restrictive CORS.
- Store the OpenAI API key only in macOS Keychain. Never return it to the browser after submission.
- Store application data under the macOS application-support directory using restrictive filesystem permissions.
- Rely on operating-system disk encryption such as FileVault; do not add SQLCipher in v1.
- Collect no analytics, crash telemetry, or remote logs.
- Operational logs redact messages, prompts, API keys, attachment bodies, and tool output by default.
- An explicit developer trace mode may log prompts locally after a warning.
- Rotate ordinary logs after seven days and by file size.

## 4. Canonical data model

SQLite is the canonical structured store. Generated Markdown is a deterministic, human-readable projection. Original transcript events and attachment bytes are the ultimate evidence. Topic pages are the primary compiled memory and retrieval surface. An internal atomic evidence ledger supplies provenance, temporal semantics, conflict handling, and rebuildability.

Enable WAL mode, foreign keys, busy timeouts, transactional migrations, regular integrity checks, FTS5, and `sqlite-vec`. If the vector extension cannot load, enter a visible degraded mode using FTS plus bounded in-process cosine similarity; do not prevent the app from starting.

### Required tables and invariants

#### Vault and configuration

- `vaults`: one global v1 vault with a reserved `scope_id` for future project scopes.
- `settings`: nonsecret user settings, selected presets, theme, onboarding status, and feature flags.
- `prompt_versions`: prompt name, semantic version, content hash, schema version, and activation time.
- `provider_presets`: configurable model IDs and reasoning/tool parameters.
- `budget_ledger`: model call, usage, estimated cost, allocation category, and cumulative total.

#### Append-only evidence

- `events`: ordered user, assistant, tool-call, tool-result, attachment, cancellation, error, revision, and system events.
- `event_content`: normalized text/content parts and role-specific metadata.
- `assistant_revisions`: active response revision and excluded prior revisions.
- `context_refs`: typed references for future project, repository, branch, commit, file, symbol, task, and agent concepts without adding many nullable event columns.
- Events are append-only except for explicit hard deletion. A stopped partial assistant response is marked incomplete and excluded from promotion unless retained.

#### Sources and attachments

- `sources`: stable source identity, type, title, URI/path where applicable, hash, provenance, creation/retrieval time, and freshness class.
- `attachments`: content-addressed original file metadata and protected local storage path.
- `source_chunks`: extracted text, location metadata, page/line/row ranges, tokenizer counts, and content hash.
- `workspace_roots`: user-authorized read-only paths and authorization status.
- `tool_executions`: arguments, bounded output, citations, status, timings, and sandbox metadata.

#### Evidence ledger and graph

- `entities`: stable entity IDs, core type, display name, status, timestamps, and current canonical description.
- `entity_aliases`: normalized aliases, confidence, source, and merge history.
- `claims`: atomic statement, subject/predicate/object or freeform value, source role, confidence, observed time, valid-from/to, current status, and extraction version.
- `claim_sources`: many-to-many links to exact events, chunks, or tool results.
- `claim_relations`: supports, contradicts, refines, supersedes, derived-from, and duplicate-of relations.
- `edges`: typed entity/topic/source relationships with evidence and temporal validity.
- `merge_history`: reversible entity and topic merge operations.

#### Topic wiki

- `topic_pages`: stable ID, core type, slug, title, active revision, scope, tags, and lifecycle status.
- `topic_page_revisions`: immutable generated or user-edited Markdown, generation inputs, author type, prompt version, and creation time.
- `page_section_sources`: section/paragraph spans linked to supporting claims and source evidence.
- `page_links`: explicit wiki links with relationship type and evidence.
- Core page types are Person, Organization, Project, Concept, Preference, Decision, Goal, Event, Artifact, and Source.
- The model may create tags but may not create new core types.
- Stable filenames combine opaque IDs with readable slugs so renaming does not break identity.

Each topic page follows a standard structure: summary, current state, history, related pages, open questions, and evidence. Pages exceeding approximately 2,500 tokens split into linked subpages. User-edited revisions are trusted, visibly marked, and never overwritten; automatic changes create a proposal or a new non-destructive revision.

#### Search, retrieval, and operations

- FTS5 indexes events, chunks, claims, and current topic-page text.
- Vector rows store model ID, dimensions, content hash, source type, and embedding version. Retrieval and publication must match the exact configured model and authoritative source generation; stale jobs may neither remain searchable nor clobber a newer vector.
- `jobs` and `job_attempts` implement the durable queue.
- `model_calls` record provider, model, prompt version, response ID, token usage, latency, status, and redacted trace metadata.
- `retrieval_traces` record query classification, candidates, component scores, rank fusion, reranking, graph expansions, selected context, and exclusions.
- `context_packets` record token budgets and source IDs without duplicating sensitive source bodies.
- `deletion_receipts` retain only non-content hashes and counts needed to verify cascades.

## 5. Conversation request flow

1. The browser submits a user message and optional attachment references with an idempotency key.
2. The API commits the user event before contacting a provider.
3. The retrieval engine classifies the request and builds the initial context packet.
4. The response orchestrator calls OpenAI Responses API with provider storage disabled.
5. The response model receives memory tools for additional exact lookup and may make no more than three memory lookup rounds.
6. Web, workspace, and sandbox tools are available according to the request and authorization boundary.
7. All response and tool events stream to the browser and are durably appended.
8. Completion commits the active assistant revision and enqueues post-turn extraction.
9. The user sees the answer before background memory compilation finishes.
10. When memory updates commit, an SSE status event refreshes search and the inspector.

If retrieval fails, the assistant answers using recent evidence while clearly stating that relevant historical evidence was not found. Exact quotations must come from raw events or source chunks, never solely from topic summaries.

## 6. Model and provider design

Use OpenAI Responses API with `store: false`. The application owns and assembles every turn’s state. Provider response chaining is not a source of truth.

Initial configurable presets:

- Fast: GPT-5.6 Luna with low or no reasoning for interactive responses.
- Balanced: GPT-5.6 Terra with medium reasoning.
- Deep: GPT-5.6 Sol with high reasoning.
- Memory extraction, query classification, routine consolidation, and reranking: GPT-5.6 Luna with structured outputs.
- Embeddings: `text-embedding-3-small`, with model and dimensionality stored per row.

Model IDs and parameters live in versioned configuration because availability and pricing change. The UI shows Fast, Balanced, and Deep with speed/cost descriptions; raw identifiers appear only in advanced settings. An embedding model may change only while the vault has no embeddable corpus or embedding work. Any later change is deferred until the product can preview the full cost and perform a resumable, integrity-validated migration without mixing vector models or generations. The provider adapter interface must cover streaming response generation, structured generation, embeddings, usage accounting, built-in web search, and future custom tools. Anthropic and local providers are deferred, not structurally blocked.

## 7. Memory compilation pipeline

Post-turn work is asynchronous and idempotent. The job key combines source event IDs, prompt version, schema version, and model configuration.

### Incremental pipeline

1. Normalize and hash new event content.
2. Extract and chunk new attachments if present.
3. Create embeddings for raw evidence and chunks.
4. Run structured memory-delta extraction over the new exchange and a bounded set of relevant current pages/claims.
5. Extract significant durable facts, preferences, decisions, goals, events, reusable attributed assistant conclusions, entity mentions, and relationship changes.
6. Keep minor conversation only in raw history; explicit “remember this” instructions override the significance threshold.
7. Resolve entities using normalized aliases, lexical matching, vector similarity, and existing graph context.
8. Automatically merge only high-confidence obvious aliases. Queue uncertain merges for user confirmation. Every merge is reversible.
9. Add new claims and evidence links without deleting older claims.
10. Detect duplicates, refinements, contradictions, and supersession.
11. Treat explicit user corrections as the highest authority until a later user correction.
12. Treat assistant conclusions as attributed conclusions, never silent user facts.
13. Treat file, web, and execution findings as source-attributed and freshness-aware.
14. Compute affected topic pages and generate constrained section patches.
15. Validate that every generated factual paragraph has claim/source support.
16. Write a new immutable topic-page revision and update the active revision transactionally. Confirmation-only changes remain isolated normalized proposals; the first protected inline-to-sharded conversion also requires acceptance, and legacy unguarded proposals are reject-only.
17. Update graph edges, FTS, vectors, and Markdown projections. Projection-dirty state binds a generation and fresh durable repair token; the exact pair is both the clear compare-and-swap and the nonreused identity of its leaseable rebuild job. An older repair cannot consume newer work, and delete/reinsert at generation 1 cannot reuse an earlier completed job.
18. Record a redacted job/model trace and publish completion status.

All raw conversation content is retained by default. There is no private/incognito message mode in v1. Memory extraction can be paused globally; pausing does not stop raw transcript storage.

### Temporal and contradiction policy

- Store when a statement was recorded separately from when it claims to have been true.
- Prefer the newest explicit user statement for current state unless evidence says it refers to a historical interval.
- Preserve superseded values for “what did we previously decide?” questions.
- Do not force a current value when evidence remains genuinely unresolved.
- Pass unresolved conflicts to the response model so it can answer cautiously.
- Use freshness categories for external claims: 24 hours for rapidly changing values, seven days for news/product state, 30 days for ordinary web facts, and no expiry for explicitly timeless cited material.
- Expiration removes a claim from default current-fact retrieval; it never erases historical evidence.

### Idle linting

Run a deep lint after five idle minutes, no more than once per day, and on manual request. It may automatically repair broken links and merge exact duplicates. Low-confidence entity merges, substantive conflict resolutions, and destructive reorganizations require user approval. Reports cover contradictions, stale claims, unsupported paragraphs, orphan pages, missing links, duplicate entities, oversized pages, and extraction failures.

## 8. Retrieval and context assembly

Retrieval components must be independently switchable so the benchmark can perform ablations.

### Query understanding

Classify each request as one or more of conversational, factual recall, temporal recall, exact lookup, document question, web question, or tool task. Use deterministic cues first and a cheap structured classifier when ambiguous. Extract entities, time intent, requested source types, and whether current or historical truth is wanted.

### Candidate generation

Run in parallel:

- FTS over raw events, chunks, claims, and pages.
- Vector similarity over the same logical collections.
- Recency and active-topic candidates.
- Entity/alias resolution and direct page lookup.
- Pinned memories and sources.
- Temporal candidates for dates, earlier decisions, and superseded claims.

Fuse component rankings with reciprocal-rank fusion. Apply structured features for source authority, current/historical intent, confidence, freshness, evidence coverage, and scope. Rerank at most the top 30 candidates using the inexpensive structured model. Expand one graph hop normally; allow two hops only for explicit relationship or multi-hop questions. Re-score expanded nodes against the query to prevent semantic drift.

### Context packet

- Reserve 25% of the model context capacity for output.
- Include at least the last four complete conversational turns when possible.
- Reserve required system/tool instructions before allocating evidence.
- Allow retrieved evidence to consume up to 45% of remaining input capacity.
- Adapt remaining space among recent turns, topic pages, atomic claims, and raw source excerpts.
- Never recursively summarize and discard older raw events.
- Deduplicate overlapping evidence and prefer source excerpts over repeated summary prose.
- Include contradiction and missing-evidence notices.
- Stable reusable prompt prefixes are arranged for provider prompt caching, but caching never defines correctness.

### Memory tools

Expose provider-neutral tools:

- `search_memory(query, filters, limit)`
- `open_event(event_id, cursor, limit)`
- `open_source(source_id, location, limit)`
- `get_topic_page(topic_id, revision)`
- `trace_claim(claim_id)`
- `search_timeline(date_range, roles, text, limit)`

Tool results include stable IDs and provenance. The response model may make at most three additional memory-search rounds per answer. Tool exhaustion produces a cautious answer or a user clarification, not fabricated recall.

## 9. Attachments, workspace reads, web, and sandbox

### Attachments

- Maximum 25 MB per file and 100 MB per message.
- Copy originals into protected content-addressed app storage.
- Deduplicate identical bytes by cryptographic hash.
- Support UTF-8 text, code, Markdown, JSON, CSV, PDF, PNG, JPEG, and WebP.
- Extract PDF text with page coordinates; use OCR when normal extraction is insufficient.
- Preserve PDF page numbers for citations.
- Analyze images with the vision-capable response model and retain locally extracted metadata/OCR.
- Parse CSV structure and chunk by header-aware row groups.
- Chunk code by language-aware symbols when a parser is available and line windows otherwise.
- Store chunker/parser versions so sources can be reprocessed deterministically.

Deleting an attachment shows dependent messages, claims, and pages before confirmation. Confirmed deletion cascades through bytes, chunks, embeddings, unsupported claims, graph edges, and page revisions/projections that rely solely on it.

### Read-only workspaces

Users explicitly authorize local roots. Roots persist across restarts but missing/moved paths require reauthorization. Reads respect `.gitignore` by default and exclude hidden files, `.git`, dependency/build directories, likely-secret files, and files over 2 MB unless explicitly requested. Large files use bounded partial reads. Symlinks escaping an authorized root are rejected. No workspace file is modified in v1.

### Sandboxed execution

Support JavaScript/TypeScript and Python in disposable temporary directories with no network and no package installation. Default limits are ten seconds CPU/wall time, 256 MB memory, 20 MB combined output, and a strictly bounded filesystem. Sandbox results are attributed tool evidence and do not silently become user facts.

### Web search

Use OpenAI’s built-in web-search tool in v1. Preserve returned titles, URLs, citations, retrieval time, and freshness class. Do not build browser automation or arbitrary local page fetching. Treat all file, web, and tool content as untrusted data, clearly separated from system and tool policy to mitigate prompt injection.

## 10. User interface specification

### Main chat

- Centered, responsive conversation column with no thread sidebar.
- Compact top bar containing app status, unified search, graph/inspector toggle, memory status, quality preset, and settings.
- Rich Markdown, syntax-highlighted code, tables, math, image previews, file cards, citations, copy controls, stop, retry, delete, and regenerate.
- Streaming output remains smooth during tool and retrieval events.
- Historical user messages cannot be edited. Corrections are new events.
- Regeneration creates a new assistant revision; the active revision is shown and prior revisions are excluded from active memory but remain inspectable.
- Deletion is permanent and shows cascade impact before confirmation.
- A full “start over” action destroys the vault after typed confirmation; it does not create another timeline.

### Memory and debug drawer

User tab:

- Memories used for the active answer.
- Source chips that jump to transcript turns, pages, files, or URLs.
- Current topic-page summaries.
- Contradictions, stale external evidence, and pending user review.
- Controls to edit, delete, pin, unpin, merge, or inspect memory.

Debug tab:

- Query classification.
- All candidate sources and component scores.
- Rank fusion, reranking, and graph-expansion decisions.
- Exact context-packet composition and token allocation.
- Model/tool calls, latency, token usage, caching, and estimated cost.
- Prompt/schema/model version identifiers.
- Background job state and retry controls.

The normal chat remains simple; the debug view is explicitly technical.

### Unified search

Search raw messages, active and historical wiki revisions, claims, entities, files, and tool evidence. Provide filters for type, role, date, current/superseded state, source, and tag. Results show highlighted matches, provenance, and jump-to-source. Search works fully offline against local data.

### Knowledge graph

The required graph view supports:

- Entity, topic, claim, source, artifact, and event nodes with visually distinct types.
- Evidence-backed typed edges.
- Focused neighborhood exploration from the current answer or selected topic.
- One/two-hop expansion, filters, search, zoom, pan, selection, and timeline/current-state controls.
- Clicking a node opens its topic page; clicking an edge opens supporting evidence.
- Conflicting and superseded relations are visibly differentiated.
- Graph layout state is UI-only and never changes memory semantics.
- Large graphs initially render a focused subgraph rather than every node.

### Onboarding, themes, and accessibility

Onboarding configures the Keychain API key, explains local versus provider data, demonstrates memory provenance, and offers the immutable demo vault. Support light, dark, and system themes. Meet WCAG 2.2 AA for keyboard navigation, contrast, labels, focus, screen-reader semantics, and reduced motion. Support current Chrome, Safari, and Firefox on macOS.

## 11. Public API surface

Implement shared Zod contracts and generated TypeScript client types for these resource groups:

- `/api/v1/health`, `/runtime`, `/settings`, `/providers`, `/budget`
- `/events`, `/messages`, `/runs`, `/runs/:id/stream`, `/runs/:id/cancel`
- `/attachments`, `/sources`, `/workspaces`, `/tools`
- `/search`, `/topics`, `/claims`, `/entities`, `/graph`
- `/memories/pins`, `/memories/lint`, `/memory-jobs`
- `/retrieval-traces`, `/context-packets`, `/model-calls`
- `/export`, `/import`, `/backups`, `/vault`

All mutations accept idempotency keys. All list APIs use cursor pagination. All destructive endpoints return a dry-run impact summary and require a confirmation token derived from that summary. Errors use a stable envelope containing code, user-safe message, retryability, trace ID, and field details. SSE events use versioned discriminated unions.

## 12. Deletion, backups, export, and import

### Hard deletion

Deletion permanently removes selected content and derived artifacts. If other sources independently support a claim, remove only the deleted provenance and keep the supported claim. After every cascade, rebuild affected pages and indexes transactionally and store a content-free deletion receipt.

### Backups

Create automatic local daily backups, retaining seven daily and four weekly snapshots. Maintenance must remove hard-deleted content from managed backups. Warn that already exported or externally copied bundles cannot be recalled.

### Portable bundle

Export a versioned ZIP containing:

- Manifest and checksums.
- JSONL event transcript.
- Structured JSON entities, claims, relations, topics, revisions, and settings.
- Markdown wiki projections.
- Original attachments and source metadata unless excluded.
- Prompt/configuration version references without secrets.

Do not export vector indexes or embeddings; rebuild them on import. Allow optional exclusion of attachments and sensitive tool output. Import verifies schema compatibility and checksums before mutation and supports creating a fresh vault or replacing the current one. Merging independent vaults is deferred.

## 13. Failure handling and observability

- Commit the user event before remote generation so input is never lost.
- Preserve unsent drafts and local search/memory access when OpenAI is unavailable.
- Retrying generation creates a traceable run/revision, not duplicate events.
- Retry memory jobs with exponential backoff up to five attempts, then require visible manual retry.
- Recover abandoned jobs and incomplete streams after restart.
- Use transactional writes for claim/page/graph/index updates.
- Show degraded status for missing vector support, failed OCR, provider errors, stale memory compilation, and budget limits.
- Do not hide partial success: an answer can complete even when post-turn memory compilation fails.
- Track local latency, token usage, cost, retrieval quality signals, and failure codes without remote telemetry.

## 14. Evaluation system

### Controlled baselines

Run all controlled systems with the same response model, reasoning setting, output budget, test queries, and total input budget:

1. Recent-window only.
2. Recent window plus recursively maintained rolling summary.
3. Flat hybrid FTS/vector memory without graph expansion or topic wiki.
4. Full Continuum evidence ledger, wiki, temporal policy, hybrid retrieval, and graph expansion.

Additional ablations disable lexical retrieval, vector retrieval, model reranking, temporal features, topic pages, or graph expansion one at a time. This identifies whether the graph actually improves recall/token efficiency rather than assuming it does.

### Datasets

- Integrate public long-memory datasets including LongMemEval and HaluMem where licensing and format permit.
- Create a seeded reproducible `InfiniteBuild` dataset representing one application built across planning, research, requirements, architecture, UI, implementation discussion, debugging, changing decisions, and retrospective questions.
- Generate 10,000-message histories with checkpoints at 100, 1,000, 5,000, and 10,000.
- Include single-fact recall, user preference, assistant conclusion, exact quote, cross-session-style topic return, temporal ordering, decision supersession, contradiction, multi-hop relation, refusal when evidence is absent, and irrelevant-topic interference.
- Include one manually authored realistic long-form project scenario to catch synthetic-dataset artifacts.
- Use fixed seeds and store dataset generator version/hash.

### Product competitors

Treat ChatGPT and Codex as named black-box competitors in a separate product comparison. Run a representative, affordable subset of the same user-visible scenarios through their available product interfaces. Record date, visible product/model setting, prompts, transcript handling, and outputs. Score them with the same answer rubric where possible. Clearly label that their internal prompts, retrieval, compaction, model versions, and token usage are not controllable, so this comparison demonstrates user-visible behavior rather than isolating memory architecture.

The controlled same-model evaluation is the causal evidence for Continuum’s memory design; the black-box comparison supports the product claim.

### Metrics and reporting

- Exact/fuzzy answer accuracy.
- Evidence precision, Recall@k, NDCG, and source-selection failures.
- Current-state and temporal-reasoning accuracy.
- Unsupported-memory and contradiction rates.
- Input, cached, output, extraction, embedding, and reranking tokens.
- Estimated API cost per turn and cumulatively.
- First-token, total-response, retrieval, reranking, and compilation latency.
- Storage growth and local search performance.
- Three runs for stochastic cases.
- LLM-as-judge only for non-deterministic semantics, with hidden ground-truth evidence and manual audit of a sample.

Generate a reproducible HTML and Markdown report with configuration hashes, charts, tables, confidence intervals where appropriate, raw JSONL runs, representative successes, representative failures, and budget totals.

## 15. Testing strategy

### Unit tests

- Event ordering, idempotency, and revision activation.
- Temporal validity and supersession transitions.
- Claim support removal and deletion cascades.
- Entity resolution, reversible merges, aliases, and conflict states.
- Topic-page patch validation and provenance coverage.
- Token budgeting and context-packet invariants.
- FTS/vector result fusion and graph-expansion limits.
- Freshness filters and historical retrieval.
- Parser/chunker behavior and content hashing.
- Budget hard stop and model-cost accounting.
- Export manifests, checksums, and schema migration.

### Integration tests

- Use recorded provider fixtures for streaming, structured outputs, tool calls, errors, and usage accounting.
- Use a tiny opt-in live OpenAI suite guarded by budget configuration.
- Exercise API/worker crash recovery, job leases, SQLite concurrency, vector degraded mode, OCR failures, and reruns.
- Verify that generated factual page sections always trace to evidence.
- Verify that prompt-injection text in sources cannot alter system/tool policy.

### End-to-end tests

- Onboarding and Keychain setup.
- Streaming chat, cancellation, regeneration, and retry.
- Attachment upload, parsing, citation, and cascade deletion.
- Background memory update and inspector refresh.
- Search and jump-to-source.
- Memory edit, pin, merge review, contradiction display, and lint.
- Graph navigation and evidence inspection.
- Workspace read authorization and boundary enforcement.
- Sandbox limits and network denial.
- Export/import round trip.
- Full-vault deletion.
- Offline/provider-down behavior and restart recovery.

Prompt, extraction, retrieval, or ranking changes must run the benchmark regression suite before merge. CI uses GitHub Actions with Linux unit/integration jobs and a macOS smoke job.

## 16. Ordered implementation plan

No phase is a permission to drop later requirements. Each phase ends with tests and a working vertical slice.

### Phase A — Foundation

- Initialize MIT-licensed pnpm monorepo, strict TypeScript, linting, formatting, CI, shared contracts, and documentation skeleton.
- Implement supervisor, loopback API security, Keychain integration, settings, health checks, structured local logging, and budget ledger.
- Implement SQLite connection, migrations, WAL/foreign-key policy, repositories, FTS/vector startup checks, and job queue.

### Phase B — Durable streaming chat

- Implement event model, message/run APIs, OpenAI Responses adapter with `store: false`, SSE streaming, cancellation, retries, response revisions, quality presets, and usage accounting.
- Build onboarding and the centered accessible chat UI.
- Add offline drafts, provider error states, crash recovery, and initial end-to-end tests.

### Phase C — Sources and tools

- Implement content-addressed attachments, text/code/CSV/image/PDF ingestion, OCR, chunks, citations, and deletion impact analysis.
- Implement read-only authorized workspace tools and isolated JS/TS/Python sandbox.
- Integrate OpenAI web search and source-aware tool event storage.

### Phase D — Evidence ledger and wiki compiler

- Implement entity, alias, claim, evidence, temporal relation, and merge schemas.
- Implement structured extraction, significance promotion, contradiction/supersession, page compilation, provenance validation, Markdown projection, retries, and background status.
- Implement memory inspection, editing, deletion, pinning, user-authored revisions, and idle linting.

### Phase E — Hybrid retrieval

- Implement query classification, parallel lexical/vector/entity/temporal candidate generation, reciprocal-rank fusion, reranking, graph expansion, context budgeting, exact-source tools, and complete retrieval traces.
- Integrate source chips and memory citations into responses.
- Implement baseline modes and component feature flags for ablation.

### Phase F — Search and graph experience

- Implement unified indexed search, filters, pagination, snippets, and jump-to-source.
- Implement required focused interactive graph with node/edge evidence, temporal state, conflicts, expansion, and topic-page navigation.
- Complete user and debug inspector tabs with context, cost, latency, and job traces.

### Phase G — Portability and resilience

- Implement managed backups, hard-deletion propagation, integrity checks, portable export/import, schema compatibility checks, and full-vault destruction.
- Add large-fixture load tests and optimize indexes, pagination, virtualization, and focused graph queries.

### Phase H — Evaluation and release

- Implement public dataset adapters, InfiniteBuild generator, four controlled baselines, ablations, graders, product-competitor protocol, cost enforcement, and report generation.
- Run prompt/retrieval tuning within the USD 25 development allocation.
- Freeze prompt/model/config versions and execute the final benchmark within the remaining allocation.
- Audit failures, document limitations, finish demo vault and setup docs, and run the macOS clean-install smoke test.

## 17. Release acceptance checklist

V1 is complete only when:

- A fresh macOS checkout starts through the documented command and completes onboarding.
- One canonical chat streams correctly and survives restart/crash scenarios.
- Every retained event is locally searchable and exact historical evidence can be opened.
- Topic memory, temporal updates, contradictions, provenance, and hard deletion behave according to this specification.
- Attachments, web search, workspace reads, and sandbox execution meet their safety boundaries.
- The memory inspector, debug trace, unified search, and interactive graph are complete and accessible.
- Export/import round-trips the vault without secrets or embeddings.
- No known data-loss or hard-deletion defect remains.
- Automated unit, integration, E2E, load, and benchmark-regression suites pass.
- The 10,000-message demonstration and 100,000-message local load fixture complete.
- Controlled and black-box competitor reports are produced within the USD 100 hard cap.
- Benchmark gates are met or misses are clearly disclosed with reproducible evidence.
- The repository includes the MIT license, quickstart, architecture, privacy, memory-model, benchmark, interchange-format, troubleshooting, and future-coding-agent documentation.

## 18. Explicitly deferred capabilities

The following are intentionally outside v1 and must not be partially implemented in ways that weaken the core design:

- Repository writes, patch application, real workspace command execution, Git operations, branches, and worktrees.
- Multi-agent orchestration and concurrent autonomous memory writers.
- Hosted accounts, sync, collaboration, or remote vault storage.
- Packaged desktop/mobile applications.
- Voice conversation.
- Local-model inference.
- Anthropic or other provider implementations beyond the adapter contracts.
- Continuous repository indexing and file watching.
- Bidirectional editing of generated Markdown outside the app.
- Merging independently modified portable vaults.

Future coding projects will receive isolated memory scopes that inherit selected global preferences. Repository contents and Git history will outrank remembered code summaries. Tools will follow provider-neutral, MCP-compatible typed contracts. Shared-memory writes will use revision numbers and optimistic concurrency so later multi-agent execution can detect and reconcile conflicts rather than silently overwrite state.

## 19. Decision authority

This document is the binding v1 specification. All recommendations from the planning questionnaire are accepted unless this document records a user override. Implementation may make purely mechanical choices that do not change behavior, scope, interfaces, safety, evaluation, or user experience. Any proposed deviation that changes those properties requires explicit user approval and an update to this document before code changes proceed.
