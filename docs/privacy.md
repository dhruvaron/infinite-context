# Privacy and data boundary

Continuum is **local-first, not local-only**. Durable application state stays on the Mac, but selected content leaves the machine when cloud inference is used.

## What stays local

- Complete retained transcript and inactive assistant revisions.
- SQLite claims, entities, topic revisions, graph edges, FTS, and vector metadata.
- Original attachments and extracted chunks.
- Authorized workspace absolute paths and authorization records. When a turn explicitly concerns a workspace, only an opaque root ID and the user-chosen display label are included in the model's tool catalog; the host path remains local.
- Local logs, model-call accounting, retrieval traces, backups, and exports. Context-packet audit rows retain reference IDs, hashes, selection metadata, and token budgets; they do not duplicate retrieved source bodies. The debug view reconstructs packet text from the authoritative sources on demand and refuses to show it if a source is missing or its hash changed.
- The OpenAI key in macOS Keychain.

## What OpenAI may receive

- The current request.
- Recent complete turns selected for conversational continuity.
- Retrieved evidence excerpts and compiled memory selected for the turn.
- System/tool definitions and tool results used during a model call.
- For workspace-intent turns, opaque IDs and user-chosen display labels for authorized roots. Absolute host paths are not included in provider requests.
- Attachment/image content when cloud analysis is explicitly part of the request.

Responses API requests set `store: false`, but that flag does not make a network request local and does not replace the provider's applicable policies. Review OpenAI terms and organizational settings before sending sensitive material.

## Data not intentionally collected

Continuum has no product analytics, advertising identifier, remote crash reporter, or Continuum-hosted telemetry. Ordinary logs are local and redact message bodies, prompts, keys, cookies, authorization headers, attachment bodies, and tool output by default. Developer prompt tracing is a separate warned mode.

## Local threat boundary

Loopback authentication protects the API from unrelated browser pages and network peers. It does not protect against malware or another process running as the same macOS user. Such a process may be able to access the unencrypted SQLite vault, attachment store, runtime descriptor, environment variables, or process arguments. Use FileVault, a protected OS account, and normal endpoint security.

## Workspaces, tools, and prompt injection

Workspace reads require explicit roots and should reject traversal, escaping symlinks, secrets, ignored/build directories, and unbounded files. Sandboxes must have no network or package installation and must enforce time, memory, output, and filesystem limits.

File, web, memory, and tool content is untrusted data. It can contain instructions that attempt to override system policy. Model output is not an authorization decision: local code must enforce every path, tool, network, and deletion boundary independently.

## Deletion and portability

Hard deletion is only complete when raw content, answers derived from that content, run/tool/model traces, context references, FTS entries, vectors, projections, WAL state, managed backups, and solely supported compiled memory are removed or rebuilt. Deletion is crash-resumable and produces only a content-free receipt. The installation-wide USD hard-cap total survives content deletion, vault deletion or replacement, and import, but all provider/model/token/call/reservation/category/timestamp metadata is scrubbed; zero-cost rows are removed. There is no budget-reset or renewable-cycle operation. Until the release deletion suite and final clean-install smoke pass, do not interpret a successful UI confirmation as a forensic secure-erasure guarantee.

Developer prompt tracing is machine-local and explicitly warned because it may record prompt bodies. Import and full-vault reset disable tracing, revoke one-use workspace secret approvals, flush pending writes, and remove local prompt-trace files so replaced data cannot survive as a log shadow.

Exports are external copies. Continuum cannot recall a bundle after it has been copied elsewhere. Imports are hostile input and must never inherit workspace authorization, queued/running work, provider state, machine-local storage paths, or executable state.

See [SECURITY.md](../SECURITY.md) for reporting and the full threat model.
