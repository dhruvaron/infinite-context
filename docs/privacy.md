# Privacy and data boundary

Continuum is **local-first, not local-only**. Durable application state stays on the Mac, but selected content leaves the machine when cloud inference is used.

## What stays local

- Complete retained transcript and inactive assistant revisions.
- SQLite claims, entities, topic revisions, graph edges, FTS, and vector metadata.
- Original attachments and extracted chunks.
- Authorized workspace absolute paths and authorization records. When a turn explicitly concerns a workspace, only an opaque root ID and the user-chosen display label are included in the model's tool catalog; the host path remains local.
- Local logs, model-call accounting, retrieval traces, backups, and exports. Context-packet audit rows retain reference IDs, hashes, selection metadata, and token budgets; they do not duplicate retrieved source bodies. The debug view reconstructs packet text from the authoritative sources on demand and refuses to show it if a source is missing or its hash changed.
- The OpenAI key in macOS Keychain.

The browser holds transient event, evidence, revision, retrieval, and provenance caches for the current view. Core bootstrap reads are all-or-nothing and are fenced by a server-owned monotonic generation, maintenance state, and vault ID read before and after assembly. An incomplete first load remains an explicitly unavailable read-only shell instead of presenting a healthy empty vault. A failed later refresh preserves the last complete verified view in read-only form rather than replacing real content with partial or empty fallbacks. Search and Graph close and their read scope advances while the vault is offline or scrubbed, so a late request cannot repopulate content from a deleted or replaced vault.

Demo preview is an isolated browser fixture. Entry captures the exact trusted personal browser state and its server boundary. Exit restores that state only after a canonical read proves the generation and vault ID did not change while preview was open; otherwise the retained snapshot is scrubbed, composer work receives fresh identities, and reconnection is required.

## What OpenAI may receive

- The current request.
- Recent complete turns selected for conversational continuity.
- Retrieved evidence excerpts and compiled memory selected for the turn.
- System/tool definitions and tool results used during a model call.
- For workspace-intent turns, opaque IDs and user-chosen display labels for authorized roots. Absolute host paths are not included in provider requests.
- Attachment/image content when cloud analysis is explicitly part of the request.

Responses API requests set `store: false`, but that flag does not make a network request local and does not replace the provider's applicable policies. Review OpenAI terms and organizational settings before sending sensitive material.

## Data not intentionally collected

Continuum has no product analytics, advertising identifier, remote crash reporter, or Continuum-hosted telemetry. Ordinary logs are local and redact message bodies, prompts, keys, cookies, authorization headers, attachment bodies, and tool output by default. Developer prompt tracing is a separate warned mode. The independent worker resolves durable tracing consent immediately before each filesystem append; a revoked setting or failed consent lookup redacts rather than retaining a stale in-memory permission.

## Local threat boundary

Loopback authentication protects the API from unrelated browser pages and network peers. It does not protect against malware or another process running as the same macOS user. Such a process may be able to access the unencrypted SQLite vault, attachment store, runtime descriptor, environment variables, or process arguments. Use FileVault, a protected OS account, and normal endpoint security.

## Workspaces, tools, and prompt injection

Workspace reads require explicit roots and should reject traversal, escaping symlinks, secrets, ignored/build directories, and unbounded files. Sandboxes must have no network or package installation and must enforce time, memory, output, and filesystem limits.

File, web, memory, and tool content is untrusted data. It can contain instructions that attempt to override system policy. Model output is not an authorization decision: local code must enforce every path, tool, network, and deletion boundary independently.

## Deletion and portability

Hard deletion is only complete when raw content, answers derived from that content, run/tool/model traces, context references, FTS entries, vectors, projections, WAL state, managed backups, and solely supported compiled memory are removed or rebuilt. After the server commits deletion, the browser invalidates active streams and in-flight vault work; clears event, provenance, evidence, revision, retrieval, Search, and Graph state; advances its read scope; and only then requests a generation-stable canonical snapshot. Ordinary last-verified-view preservation does not apply across this boundary, so a failed refetch cannot resurrect deleted content in the UI. Deletion is crash-resumable and produces only a content-free receipt. The installation-wide USD hard-cap total survives content deletion, vault deletion or replacement, and import, but all provider/model/token/call/reservation/category/timestamp metadata is scrubbed; zero-cost rows are removed. There is no budget-reset or renewable-cycle operation. Until the release deletion suite and final clean-install smoke pass, do not interpret a successful UI confirmation as a forensic secure-erasure guarantee.

Developer prompt tracing is machine-local and explicitly warned because it may record prompt bodies. Import and full-vault reset disable tracing, revoke one-use workspace secret approvals, flush pending writes, remove local prompt-trace files, and fsync that removal before an imported database can commit, so replaced data cannot survive as a log shadow. A verified-import capability is journal-owned and one-use: its staged archive and marker are durably removed before success is published, and another idempotency identity cannot reuse a token that is in progress or consumed. Precommit rollback-cleanup and post-commit recovery failures both retain the maintenance lock for startup recovery. A lost import response also causes the browser to clear the prior vault view and local settings/draft caches before it waits for canonical recovery.

Exports are external copies. Continuum cannot recall a bundle after it has been copied elsewhere. Imports are hostile input and must never inherit workspace authorization, queued/running work, provider state, machine-local storage paths, or executable state.

See [SECURITY.md](../SECURITY.md) for reporting and the full threat model.
