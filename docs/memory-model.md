# Memory model

Continuum separates immutable evidence from revisable interpretation. This is the core reason it can offer an effectively unbounded product memory without pretending that a model has an infinite attention window.

## Layers

1. **Raw events** — verbatim user, assistant, and tool records. These are the source of truth and remain searchable until hard-deleted.
2. **Sources and chunks** — attachments, web results, workspace reads, and tool evidence with location metadata such as page, line, row group, or URL.
3. **Atomic claims** — subject/predicate/value assertions linked to one or more exact sources, authority, confidence, observation time, validity interval, and freshness. A persisted extracted value remains exact; the compiler applies explicit presentation bounds when rendering wiki prose instead of truncating the canonical claim ledger.
4. **Entities and aliases** — canonical objects plus evidence-backed names. Obvious aliases may merge automatically; uncertain merges require review and must be reversible.
5. **Topic pages** — readable current state, history, open questions, and related evidence. Each update creates an immutable revision; automatic pages may activate it immediately, while confirmation-only pages retain it as an inactive candidate until explicit acceptance.
6. **Graph** — typed relationships among entities, topics, claims, sources, artifacts, and events. Edges carry evidence and temporal state.

## Post-turn compilation

The response is shown before memory work finishes. A durable job then normalizes new evidence, embeds eligible objects, runs schema-constrained extraction, resolves entities, adds claims, detects refinement/contradiction/supersession, patches affected pages, validates provenance, updates indexes/projections, and records a redacted trace. On confirmation-only pages, the patch is stored as isolated normalized candidate material and does not change the active page, claim routing, links, or search indexes. A protected inline page likewise requires one explicit normalized proposal acceptance for its initial conversion to stable shards.

Only durable facts, preferences, decisions, goals, significant events, and reusable attributed conclusions should be promoted. Minor conversation remains safely available in raw history. An explicit “remember this” instruction raises significance but does not remove the provenance requirement.

Assistant conclusions remain attributed to the assistant; file, web, and tool findings remain attributed to those sources. They do not silently become user facts.

## Time and contradiction

Recorded time and claimed validity time are different fields. A newer explicit user correction normally becomes current while the prior value becomes superseded, not erased. Historical questions can retrieve the prior claim; current questions prefer supported current claims. Conflicting evidence remains conflicted until sufficient authority or user review resolves it.

External facts have freshness classes. Expiration removes a claim from default current retrieval, active compiled projections, embeddings, and live page-link evidence, but retains the canonical row for explicit historical inspection. A rebuild cannot rehydrate that expired claim into current, history, or evidence prose merely because its old topic assignment still exists.

## Retrieval

Each turn classifies conversational, factual, temporal, exact, document, web, and tool intent. Candidate channels run independently over the same logical evidence collections. Reciprocal-rank fusion, authority, freshness, temporal intent, confidence, evidence coverage, and bounded graph expansion produce a ranked list.

Context assembly reserves system/tool instructions and output space first, includes recent complete turns, then fits deduplicated evidence. Source excerpts are preferred over duplicate summary prose. Contradiction and missing-evidence notices are explicit. Compiled topic pages split above an approximately 2,500-token threshold, enforced conservatively as a 10,000-rendered-character safety ceiling. Stable section shards let a confirmation-only page propose normalized patches for only the affected ranges; an inline confirmation-only page first proposes a one-time conversion to that sharded form. Related-page compilation may consult at most 20 live exact-subject claims in other topics and does not retain expired-only link evidence. This bounded planner does not imply that every automatic, conversion, or rebuild path is O(delta). The persisted context-packet audit record is reference-only: it records the selected turn/document/topic-revision/source IDs, hashes, metadata, and token allocation without copying source bodies. Answer diagnostics reconstruct the rendered memory from those immutable references and display it only after every content hash verifies.

The model may use exact-memory tools for stable event/source/page/claim lookup. Tool exhaustion should produce a cautious answer or clarification, never fabricated recall.

## User control

- Pause compilation without stopping raw transcript retention.
- Inspect evidence selected for an answer.
- Edit a topic to set sticky confirmation-only policy; automatic compiler work remains a proposal even if a later active revision is model- or system-authored.
- Accept or reject a normalized confirmation proposal. Legacy proposals that predate exact parent/claim/evidence/route/content guards are reject-only; rejecting one queues protected-parent recompilation so a fresh normalized proposal can replace it.
- Pin evidence for consideration within the context budget.
- Review/reverse uncertain merges.
- Permanently delete content after reviewing cascade impact. A post-commit cleanup failure keeps the vault locked, and startup resumes the journal before the content can be used again.

## Quality invariants

- No summary destroys raw evidence.
- No exact quote comes solely from a topic summary.
- No active factual paragraph lacks source support.
- Deleting one source retains a claim if another independent source still supports it.
- Inactive response revisions are excluded from default memory and retrieval.
- Proposal-only pages and revisions are excluded from default FTS, graph links, projection files, and retrieval.
- Rejection cannot mutate active pages, claim routing, or links; acceptance validates every recorded parent, shard, claim, route, and candidate-content guard in one transaction.
- Schema 18 preserves application-normalized NFKC/whitespace claim-slot identity across topic and status changes; its migration repairs keys that the old schema-14 metadata trigger could downgrade.
- A claim change commits with both its projection-dirty generation and a fresh durable repair token. Repair clears only the exact generation-token pair after durably publishing the active repair or an exactly guarded protected proposal. The same pair identifies its leaseable rebuild job, so concurrent mutations remain pending and a deleted/reinserted generation-1 marker cannot reuse an earlier completed job.
- Vector retrieval and publication are isolated to the exact configured model and authoritative source generation. A stale embedding completion cannot replace a newer vector.
- The embedding model becomes immutable as soon as any embeddable corpus or embedding work exists. A future model migration must first preview cost, then rebuild resumably and validate the complete corpus.
- Re-extracting changed source bytes invalidates stale derived claims, indexes, and generated topic projections before rebuild.
