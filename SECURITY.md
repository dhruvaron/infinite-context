# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately. If this repository is hosted on GitHub, use a private repository security advisory when available; otherwise contact the project owner through the private channel from which you received the code. Do not open a public issue containing an exploit, real user data, API keys, vault files, or sensitive logs.

Include:

- affected version or commit;
- minimal reproduction and prerequisites;
- security impact and data/action boundary crossed;
- whether the issue is local, browser-origin, import, tool, provider, or deletion related;
- a suggested fix or mitigation when practical.

Allow coordinated remediation and validation before public disclosure. This project does not promise a bug bounty unless a separate published program explicitly says otherwise.

## Supported security boundary

Continuum is a single-user local browser service. Its loopback session token, Host/Origin validation, CSRF header, CSP, restrictive CORS, and HttpOnly cookie protect against unrelated browser origins and network peers reaching the local API. The application OpenAI key is Keychain-only on the supported path; application configuration has no environment fallback. Paid evaluation has a separate explicitly gated environment credential that is consumed into an in-memory evaluation override and removed from `process.env` only after durable budget admission. Ordinary logs redact secrets and content by default.

Continuum is local-first, not local-only. Current requests, selected recent turns, retrieved evidence, and enabled tool instructions/results may go to OpenAI. Responses requests use `store: false`, but provider policy and the network boundary still apply.

## Out of scope for the local trust boundary

Continuum does not provide strong isolation from malware or another process running as the same macOS user. A compromised account may access the unencrypted SQLite vault, attachment store, runtime descriptor, an ephemeral paid-evaluation environment key, process arguments, local exports, or browser session. Use FileVault and a trusted OS account.

Denial of service that requires an already compromised same-user process is generally outside the v1 boundary, though robust parsing and bounded resource usage are still expected.

## Untrusted inputs

Treat imported vaults, attachments, workspace files, web results, memory text, tool output, and model output as hostile.

- Imported bundles must have bounded compressed/expanded sizes, safe normalized paths, checksums, schema validation, and atomic rollback.
- Imports must not inherit workspace authorization, queued/running jobs, provider work, machine-local storage paths, sessions, or executable state.
- File/web/tool text may contain prompt injection. It remains data and cannot alter system/tool policy.
- Model output is never proof of authorization. Local code enforces paths, network, resource, mutation, and deletion rules.
- Workspace reads must reject traversal and symlink escapes and exclude likely secrets by default.
- Sandboxes require no network/package install and strict time, memory, output, and filesystem limits.

## Deletion and backups

Do not claim secure hard deletion until automated tests prove removal or rebuild across raw rows, derived claims/pages, traces, FTS, vectors, projections, WAL state, attachment bytes, and managed backups. The operation must be crash-resumable. A content-free receipt may retain hashes/counts but no deleted content.

Externally copied exports cannot be recalled.

## API-credit cap

The USD 100 limit is security- and cost-sensitive. It is hard only when every provider operation—including response, extraction, embedding, reranking, judge, retry, and tool-mediated model call—atomically reserves a conservative worst-case amount in one durable ledger before network work. Read-then-call checks are insufficient under concurrency.

Application and evaluation processes enforce that boundary through one canonical file-locked authority at `~/Library/Application Support/Continuum/installation-budget-ledger.json`. Its lock spans read, admission, mutation, file flush, atomic replacement, and directory flush. Vault-local SQLite reservations remain an audit mirror and workflow journal; they do not authorize a separate cap. Admission, warning, and nonessential-work thresholds use all lifetime canonical committed spend plus active reserved spend. The authority is deliberately not portable, is unaffected by `CONTINUUM_DATA_DIR`, and survives in-app vault deletion, replacement, and import. Neither the UI, public API, configuration package, nor paid CLI exposes a reset or fresh-cycle operation. A legacy ledger that records a renewable cycle fails closed before paid admission. Before maintenance removes portable reservations, uncertain work is conservatively charged. Expired reservations are also charged rather than released; a later provider completion records only the larger of reserved or reported cost, so it cannot double-charge.

Provider model IDs and prices are an explicit role-aware allowlist. Unknown or incompatible models fail before network access. OpenAI SDK retries are disabled because a timeout can conceal an accepted billable request. Chat reserves the bounded four-call continuation sequence, low-detail images, at most two first-round web searches and their per-call fees, output limits, long-context tiers, cache-write premium, and bounded local-tool results. Provider-reported cached input is retained in trace metadata and receives the pinned cached-read price in cost estimates.

This is an application-side cap, not control over OpenAI's billing system. Prices can change under an existing model ID, provider usage can be delayed or corrected, and the machine owner can delete or modify local application data. Keep the pinned price table current and compare the provider invoice when running paid benchmarks. Paid evaluation CLIs cannot override the canonical ledger path. Same-user filesystem tampering is outside the local trust boundary described above.

## Security verification

Before release, run static checks, dependency review, unit/integration tests, prompt-injection fixtures, hostile archive tests, workspace/symlink boundary tests, sandbox network/resource tests, concurrent budget tests, crash-recovery tests, and hard-deletion forensic searches. Record failures and limitations; absence of a detected issue is not a formal security proof.
