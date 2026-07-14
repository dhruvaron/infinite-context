import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, Check, CheckCircle2, Database, ExternalLink, FileText, GitBranch, GitMerge, History, Link2, LoaderCircle, Pencil, RotateCcw, ShieldCheck, Trash2, UserRound } from "lucide-react";

import type { AssistantRevision, EntityMergeCandidate, EntityMergeEnvelope, EntityMergeResult, EvidenceRecord, ImpactSummary, TopicPageDetail, VaultDeletionImpact } from "../lib/types";
import { Modal, formatRelativeTime } from "./Primitives";
import { SafeMarkdown } from "./SafeMarkdown";

export function TopicDetailDialog({ topic, open, onClose, onEdit, onOpenEvidence, onOpenTopic, onShowInGraph }: { topic: TopicPageDetail | null; open: boolean; onClose: () => void; onEdit: (topic: TopicPageDetail) => void; onOpenEvidence: (evidenceId: string) => void; onOpenTopic: (topicIdOrSlug: string) => void; onShowInGraph: (topicId: string) => void }) {
  if (!topic) return null;
  const sourceReferences = topic.sourceReferences ?? topic.sourceIds.map((id) => ({ id, type: "unknown" as const }));
  const historicalRevision = topic.revisionState === "superseded" || (topic.activeRevision !== undefined && topic.revision !== topic.activeRevision);
  return <Modal open={open} title={topic.title} description={`${topic.type} · revision ${topic.revision} · ${historicalRevision ? "superseded" : "current"} · updated ${formatRelativeTime(topic.updatedAt)}`} width="large" onClose={onClose} footer={<><button type="button" className="secondary-button" onClick={onClose}>Close</button><button type="button" className="secondary-button" onClick={() => onShowInGraph(topic.id)}><GitBranch size={14} /> Show in graph</button>{historicalRevision ? <button type="button" className="primary-button" onClick={() => onOpenTopic(topic.id)}><History size={14} /> Open current revision</button> : <button type="button" className="primary-button" onClick={() => onEdit(topic)}><Pencil size={14} /> Edit trusted revision</button>}</>}>
    <article className="topic-detail">
      <div className="topic-detail-banner"><span className={`topic-large-icon topic-${topic.type}`}><GitBranch size={19} /></span><div><span className="topic-tags">{historicalRevision && <i>superseded revision</i>}{topic.tags.map((tag) => <i key={tag}>{tag}</i>)}</span><p>{topic.summary}</p></div><span className="topic-trust-badges">{topic.userAuthored && <span className="authored-badge"><UserRound size={12} /> User-authored revision</span>}{topic.updatePolicy === "confirm" && <span className="policy-badge" title="Automatic memory changes require explicit approval"><ShieldCheck size={12} /> Confirmation-only updates</span>}</span></div>
      {topic.markdown ? <section className="topic-full-page"><SafeMarkdown onTopicLink={onOpenTopic}>{topic.markdown}</SafeMarkdown></section> : <>
        <section><h3><CheckCircle2 size={16} /> Current state</h3><p>{topic.currentState || "No current-state statement has been compiled."}</p></section>
        <section><h3><History size={16} /> History</h3><p>{topic.history || "No earlier state recorded."}</p></section>
        {topic.openQuestions.length > 0 && <section><h3><CalendarClock size={16} /> Open questions</h3><ul>{topic.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul></section>}
      </>}
      <section><h3><Link2 size={16} /> Supporting evidence</h3><div className="topic-source-list">{sourceReferences.map((reference, index) => <button type="button" key={`${reference.type}:${reference.id}`} onClick={() => onOpenEvidence(reference.id)}><FileText size={15} /><span><strong>{reference.type === "event" ? "Transcript evidence" : reference.type === "source_chunk" ? "Source excerpt" : "Retained evidence"} {index + 1}</strong><small>Open exact retained {reference.type === "event" ? "event" : "evidence"}</small></span></button>)}</div></section>
      <div className="provenance-note"><ShieldCheck size={16} /><span><strong>Compiled view, not source of truth</strong><small>This page is derived from claims and exact evidence. Raw events remain authoritative and searchable.</small></span></div>
    </article>
  </Modal>;
}

export function DeleteImpactDialog({ open, title, impact, loading, onClose, onConfirm }: { open: boolean; title: string; impact: ImpactSummary | null; loading: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false);
  return <Modal open={open} title="Delete permanently?" description={`Continuum will remove “${title}” and derived memory that has no other support.`} dismissible={!deleting} onClose={onClose} footer={<><button type="button" className="secondary-button" disabled={deleting} onClick={onClose}>Cancel</button><button type="button" className="danger-button" disabled={!impact || loading || deleting} onClick={() => { setDeleting(true); void onConfirm().finally(() => setDeleting(false)); }}><Trash2 size={14} />{deleting ? "Deleting…" : "Delete permanently"}</button></>}>
    <div className="delete-impact"><div className="destructive-warning"><AlertTriangle size={18} /><p><strong>This cannot be undone.</strong> Managed backups will be cleaned during maintenance. Already exported copies cannot be recalled.</p></div>{loading ? <div className="impact-loading"><span className="loading-ring" />Calculating dependent memory…</div> : impact && <div className="impact-grid"><Impact number={impact.events} label="events" /><Impact number={impact.attachments} label="attachments" /><Impact number={impact.claimsRemoved} label="claims removed" /><Impact number={impact.claimsRetained} label="claims retained" /><Impact number={impact.topicsRebuilt} label="pages rebuilt" /><Impact number={impact.edgesRemoved} label="edges removed" /></div>}</div>
  </Modal>;
}

function Impact({ number, label }: { number: number; label: string }) { return <span><strong>{number}</strong><small>{label}</small></span>; }

export function ResponseRevisionsDialog({ open, revisions, loading, error, onClose, onActivate }: {
  open: boolean;
  revisions: AssistantRevision[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onActivate: (eventId: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setSelectedId(revisions.find((revision) => revision.active)?.event.id ?? revisions.at(-1)?.event.id ?? null);
    setActivationError(null);
  }, [open, revisions]);
  const selected = revisions.find((revision) => revision.event.id === selectedId) ?? null;
  return <Modal open={open} title="Persisted response revisions" description="Every regeneration remains stored. One revision is active for retrieval; the others stay inspectable." width="wide" dismissible={!activating} onClose={onClose} footer={<><span className="modal-footer-status" role="status">{activationError}</span><button type="button" className="secondary-button" disabled={activating} onClick={onClose}>Close</button><button type="button" className="primary-button" disabled={!selected || selected.active || activating} onClick={() => { if (!selected) return; setActivating(true); setActivationError(null); void onActivate(selected.event.id).catch((reason: unknown) => setActivationError(reason instanceof Error ? reason.message : "That revision could not be activated.")).finally(() => setActivating(false)); }}>{activating ? "Activating…" : selected?.active ? "Active revision" : "Make active"}</button></>}>
    {loading ? <div className="revision-dialog-loading"><LoaderCircle size={19} className="spin" /> Loading persisted revisions…</div> : error ? <div className="inline-alert"><AlertTriangle size={16} /><span>{error}</span></div> : revisions.length ? <div className="revision-dialog-layout"><nav className="revision-list" aria-label="Response revisions">{revisions.map((revision) => <button type="button" className={`${revision.event.id === selectedId ? "selected" : ""} ${revision.active ? "active" : ""}`} key={revision.event.id} onClick={() => setSelectedId(revision.event.id)}><span><strong>Revision {revision.revisionNumber}</strong><small>{revision.quality} · {formatRelativeTime(revision.event.createdAt)}</small></span>{revision.active && <em><Check size={12} /> Active</em>}</button>)}</nav>{selected && <article className="revision-preview"><header><span>Revision {selected.revisionNumber} · {selected.quality}</span><small>{selected.active ? "Used by retrieval now" : "Historical · excluded from active memory"}</small></header><SafeMarkdown>{selected.event.content || "No response content."}</SafeMarkdown></article>}</div> : <div className="revision-dialog-empty"><History size={22} /><strong>No revision history yet</strong><p>Regenerate this answer to create another persisted revision.</p></div>}
  </Modal>;
}

export function EvidenceDialog({ open, evidence, loading, error, onClose, onOpenEvidence, onCorrectClaim, onDeleteClaim, onReverseMerge }: {
  open: boolean;
  evidence: EvidenceRecord | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpenEvidence: (id: string) => Promise<void>;
  onCorrectClaim: (id: string, value: string, reason: string) => Promise<void>;
  onDeleteClaim: (id: string, title: string) => void;
  onReverseMerge: (mergeId: string, entityId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reversingId, setReversingId] = useState<string | null>(null);
  const detail = asRecord(evidence?.record);
  const claim = evidence?.type === "claim" ? asRecord(detail.claim ?? detail) : {};
  const entity = evidence?.type === "entity" ? asRecord(detail.entity ?? detail) : {};
  const source = evidence?.type === "source" ? asRecord(detail.source ?? detail) : {};
  useEffect(() => {
    setEditing(false); setReason(""); setActionError(null);
    if (evidence?.type === "claim") setValue(stringValue(claim.value));
  }, [evidence?.id, evidence?.type, claim.value]);
  const title = evidence ? evidenceTitle(evidence.type, detail) : "Exact evidence";
  return <Modal open={open} title={title} description={evidence ? `${evidence.type.replaceAll("_", " ")} · retained locally · ${shortId(evidence.id)}` : "Loading an exact retained record…"} width="large" dismissible={!saving && !reversingId} onClose={onClose} footer={<><span className="modal-footer-status" role="status">{actionError}</span><button type="button" className="secondary-button" disabled={saving || Boolean(reversingId)} onClick={onClose}>Close</button></>}>
    {loading ? <div className="revision-dialog-loading" role="status"><LoaderCircle size={19} className="spin" /> Loading exact evidence…</div> : error ? <div className="inline-alert" role="alert"><AlertTriangle size={16} /><span>{error}</span></div> : evidence && <article className="evidence-detail">
      {evidence.type === "claim" && <>
        <div className="evidence-summary"><span className={`claim-status status-${stringValue(claim.status, "current")}`}>{stringValue(claim.status, "current")}</span><p><strong>{stringValue(claim.subject)}</strong> {stringValue(claim.predicate)}</p><SafeMarkdown>{stringValue(claim.value, "No claim value retained.")}</SafeMarkdown></div>
        <div className="evidence-metrics"><span><strong>{Math.round(numberValue(claim.confidence) * 100)}%</strong><small>confidence</small></span><span><strong>{asArray(detail.evidence).length || asArray(claim.sourceIds).length}</strong><small>evidence records</small></span><span><strong>{asArray(detail.relations).length}</strong><small>claim relations</small></span></div>
        {(asArray(detail.evidence).length > 0 || asArray(claim.sourceIds).length > 0) && <section><h3><Link2 size={15} /> Supporting evidence</h3><div className="evidence-link-list">{(asArray(detail.evidence).length ? asArray(detail.evidence).map((item) => stringValue(asRecord(item).sourceId)) : asArray(claim.sourceIds).map(String)).filter(Boolean).map((id) => <button type="button" key={id} onClick={() => void onOpenEvidence(id)}><FileText size={14} /> Open {shortId(id)}</button>)}</div></section>}
        {asArray(detail.relations).length > 0 && <section><h3><GitBranch size={15} /> Related claims</h3><div className="evidence-link-list">{asArray(detail.relations).map((item) => { const relation = asRecord(item); const id = stringValue(relation.sourceClaimId) === evidence.id ? stringValue(relation.targetClaimId) : stringValue(relation.sourceClaimId); return <button type="button" key={stringValue(relation.id)} onClick={() => void onOpenEvidence(id)}><GitBranch size={14} /> {stringValue(relation.type, "related")} · {shortId(id)}</button>; })}</div></section>}
        {!editing ? <div className="claim-record-actions"><button type="button" className="secondary-button" onClick={() => setEditing(true)}><Pencil size={14} /> Correct this claim</button><button type="button" className="danger-button" onClick={() => onDeleteClaim(evidence.id, stringValue(claim.value, "memory claim").slice(0, 80))}><Trash2 size={14} /> Delete claim permanently</button></div> : <div className="claim-correction"><div className="destructive-warning"><ShieldCheck size={17} /><p><strong>The original claim remains in history.</strong>Your correction creates a new user-authored claim and supersedes this one.</p></div><label>Correct value<textarea rows={4} value={value} onChange={(event) => setValue(event.target.value)} /></label><label>Reason <small>(optional)</small><textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="claim-correction-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setEditing(false)}>Cancel correction</button><button type="button" className="primary-button" disabled={saving || !value.trim() || value.trim() === stringValue(claim.value).trim()} onClick={() => { setSaving(true); setActionError(null); void onCorrectClaim(evidence.id, value.trim(), reason.trim()).then(() => setEditing(false)).catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The correction could not be saved.")).finally(() => setSaving(false)); }}>{saving ? "Saving correction…" : "Save as new current claim"}</button></div></div>}
      </>}
      {evidence.type === "entity" && <>
        <div className="evidence-summary"><span className={`claim-status status-${stringValue(entity.status, "active")}`}>{stringValue(entity.status, "active")}</span><p>{stringValue(entity.description, "No canonical description has been compiled.")}</p></div>
        <div className="evidence-metrics"><span><strong>{asArray(detail.aliases).length}</strong><small>aliases</small></span><span><strong>{asArray(detail.edges).length}</strong><small>relationships</small></span><span><strong>{asArray(detail.mergeHistory).length}</strong><small>merge records</small></span></div>
        {asArray(detail.aliases).length > 0 && <section><h3>Known aliases</h3><div className="evidence-tags">{asArray(detail.aliases).map((item) => <span key={stringValue(asRecord(item).id)}>{stringValue(asRecord(item).alias)}</span>)}</div></section>}
        {asArray(detail.mergeHistory).length > 0 && <section><h3><History size={15} /> Reversible merge history</h3><div className="merge-history-list">{asArray(detail.mergeHistory).map((item) => { const merge = asRecord(item); const mergeId = stringValue(merge.id); const reversed = Boolean(merge.reversedAt); return <div key={mergeId}><span><strong>{shortId(stringValue(merge.sourceId))} → {shortId(stringValue(merge.targetId))}</strong><small>{reversed ? "Already reversed" : "Active merge"}</small></span><button type="button" className="secondary-button" disabled={reversed || Boolean(reversingId)} onClick={() => { setReversingId(mergeId); setActionError(null); void onReverseMerge(mergeId, evidence.id).catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The merge could not be reversed.")).finally(() => setReversingId(null)); }}>{reversingId === mergeId ? "Reversing…" : "Reverse"}</button></div>; })}</div></section>}
      </>}
      {evidence.type === "source" && <><div className="evidence-summary"><p>{stringValue(source.title, "Untitled source")}</p>{safeHttpUrl(stringValue(source.uri)) && <a href={safeHttpUrl(stringValue(source.uri))!} target="_blank" rel="noreferrer">Open original source <ExternalLink size={13} /></a>}</div><div className="evidence-metrics"><span><strong>{stringValue(source.type, "local")}</strong><small>source type</small></span><span><strong>{asArray(detail.chunks).length}</strong><small>retained chunks</small></span></div>{asArray(detail.chunks).length > 0 && <section><h3>Retained excerpts</h3><div className="source-chunk-list">{asArray(detail.chunks).slice(0, 20).map((item) => { const chunk = asRecord(item); return <button type="button" key={stringValue(chunk.id)} onClick={() => void onOpenEvidence(stringValue(chunk.id))}><span>Excerpt {numberValue(chunk.ordinal) + 1}</span><p>{stringValue(chunk.content)}</p></button>; })}</div>{Boolean(detail.chunksTruncated) && <p className="form-help">Only the first 200 retained chunks are shown.</p>}</section>}</>}
      {evidence.type === "source_chunk" && <><div className="evidence-summary"><p><strong>{stringValue(detail.sourceTitle, "Source excerpt")}</strong></p><SafeMarkdown>{stringValue(detail.content, "No retained excerpt text.")}</SafeMarkdown></div>{stringValue(detail.sourceId) && <button type="button" className="secondary-button" onClick={() => void onOpenEvidence(stringValue(detail.sourceId))}><Database size={14} /> Open parent source</button>}</>}
      {evidence.type === "attachment" && <><div className="evidence-summary"><p><strong>{stringValue(detail.filename, "Attachment")}</strong></p><p>{stringValue(detail.mediaType)} · {numberValue(detail.size).toLocaleString()} bytes · {stringValue(detail.status)}</p></div>{stringValue(detail.sourceId) && <button type="button" className="secondary-button" onClick={() => void onOpenEvidence(stringValue(detail.sourceId))}><FileText size={14} /> Inspect extracted source</button>}</>}
      {evidence.type === "tool_result" && <><div className="evidence-summary"><p><strong>{stringValue(detail.toolName, "Tool result")}</strong> · {stringValue(detail.status)}</p><SafeMarkdown>{stringValue(detail.output, "No retained tool output.")}</SafeMarkdown></div></>}
      <details className="evidence-technical"><summary>Technical record</summary><pre>{JSON.stringify(evidence.record, null, 2)}</pre></details>
    </article>}
  </Modal>;
}

export function EntityMergeDialog({ open, candidates, loading, error, onClose, onReview, onMerge, onReverse }: {
  open: boolean;
  candidates: EntityMergeCandidate[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onReview: (sourceId: string, targetId: string) => Promise<EntityMergeEnvelope>;
  onMerge: (envelope: EntityMergeEnvelope) => Promise<EntityMergeResult>;
  onReverse: (mergeId: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<EntityMergeCandidate | null>(null);
  const [impact, setImpact] = useState<EntityMergeEnvelope | null>(null);
  const [result, setResult] = useState<EntityMergeResult | null>(null);
  const [working, setWorking] = useState<"review" | "merge" | "reverse" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => { if (open) { setSelected(null); setImpact(null); setResult(null); setActionError(null); } }, [open]);
  return <Modal open={open} title="Review possible entity merges" description="Merge duplicate identities only after reviewing exact impact. Every merge records a reversible snapshot." width="large" dismissible={!working} onClose={onClose} footer={<><span className="modal-footer-status" role="status">{actionError}</span><button type="button" className="secondary-button" disabled={Boolean(working)} onClick={onClose}>Close</button></>}>
    {loading ? <div className="revision-dialog-loading" role="status"><LoaderCircle size={19} className="spin" /> Finding plausible duplicates…</div> : error ? <div className="inline-alert" role="alert"><AlertTriangle size={16} /><span>{error}</span></div> : result ? <div className="merge-complete"><CheckCircle2 size={24} /><h3>Entities merged</h3><p>The source identity now resolves to the target. Aliases and graph edges were rewritten from the reviewed snapshot.</p><button type="button" className="secondary-button" disabled={Boolean(working)} onClick={() => { setWorking("reverse"); setActionError(null); void onReverse(result.mergeId).then(() => { setResult(null); setImpact(null); setSelected(null); }).catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The merge could not be reversed.")).finally(() => setWorking(null)); }}><RotateCcw size={14} />{working === "reverse" ? "Reversing…" : "Undo this merge"}</button></div> : <div className="entity-merge-layout">
      <div className="merge-candidate-list" role="listbox" aria-label="Possible entity merges">{candidates.length ? candidates.map((candidate) => <button type="button" role="option" aria-selected={selected?.sourceId === candidate.sourceId && selected.targetId === candidate.targetId} className={selected?.sourceId === candidate.sourceId && selected.targetId === candidate.targetId ? "selected" : ""} key={`${candidate.sourceId}-${candidate.targetId}`} onClick={() => { setSelected(candidate); setImpact(null); setActionError(null); }}><span><strong>{candidate.sourceName}</strong><ArrowRight size={13} /><strong>{candidate.targetName}</strong></span><small>{Math.round(candidate.score * 100)}% match · {candidate.reason}</small></button>) : <div className="revision-dialog-empty"><GitMerge size={22} /><strong>No likely duplicates</strong><p>Memory lint did not find active same-type entities similar enough to review.</p></div>}</div>
      {selected && <div className="merge-review"><h3>{selected.sourceName} <ArrowRight size={14} /> {selected.targetName}</h3><p>The left identity will be marked merged. The right identity remains canonical.</p>{!impact ? <button type="button" className="primary-button" disabled={Boolean(working)} onClick={() => { setWorking("review"); setActionError(null); void onReview(selected.sourceId, selected.targetId).then(setImpact).catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "Merge impact could not be calculated.")).finally(() => setWorking(null)); }}>{working === "review" ? "Calculating impact…" : "Review exact impact"}</button> : <><div className="impact-grid"><Impact number={impact.impact.aliasesMoved} label="aliases moved" /><Impact number={impact.impact.edgesRewritten} label="edges rewritten" /></div><div className="destructive-warning"><ShieldCheck size={17} /><p><strong>This merge is reversible.</strong>Reversal is allowed only while the merged identity has not accumulated newer changes.</p></div><button type="button" className="danger-button" disabled={Boolean(working)} onClick={() => { setWorking("merge"); setActionError(null); void onMerge(impact).then(setResult).catch((cause: unknown) => { setImpact(null); setActionError(cause instanceof Error ? cause.message : "The entities could not be merged. Review the impact again."); }).finally(() => setWorking(null)); }}>{working === "merge" ? "Merging…" : `Merge ${selected.sourceName} into ${selected.targetName}`}</button></>}</div>}
    </div>}
  </Modal>;
}

export function ResetVaultDialog({ open, impact, loading, error, onRetryImpact, onClose, onConfirm }: {
  open: boolean;
  impact: VaultDeletionImpact | null;
  loading: boolean;
  error: string | null;
  onRetryImpact: () => Promise<void>;
  onClose: () => void;
  onConfirm: (impact: VaultDeletionImpact) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { if (!open) setConfirmation(""); }, [open]);
  const matches = Boolean(impact && confirmation === impact.requiredPhrase);
  return <Modal open={open} title="Destroy the entire vault?" description="This is the only start-over operation. It does not create another conversation." dismissible={!deleting} onClose={onClose} footer={<><button type="button" className="secondary-button" disabled={deleting} onClick={onClose}>Cancel</button><button type="button" className="danger-button" disabled={!matches || deleting || loading || !impact} onClick={() => { if (!impact) return; setDeleting(true); void onConfirm(impact).finally(() => setDeleting(false)); }}><Trash2 size={14} />{deleting ? "Destroying vault…" : "Destroy vault"}</button></>}>
    <div className="reset-vault-content">
      <div className="destructive-warning"><AlertTriangle size={18} /><p><strong>Every retained event and attachment will be deleted.</strong>The wiki, claims, graph, indexes, and managed backups will be removed too.</p></div>
      {loading ? <div className="impact-loading" role="status"><span className="loading-ring" />Calculating the current vault impact…</div> : error ? <div className="inline-alert" role="alert"><AlertTriangle size={16} /><span>{error}</span><button type="button" onClick={() => void onRetryImpact()}>Try again</button></div> : impact && <><div className="impact-grid" aria-label="Current vault deletion impact"><Impact number={impact.events} label="events" /><Impact number={impact.attachments} label="attachments" /><Impact number={impact.claimsRemoved} label="claims" /><Impact number={impact.edgesRemoved} label="graph edges" /><Impact number={impact.managedBackupsAffected} label="managed backups" /></div><label>Type <strong>{impact.requiredPhrase}</strong> to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} aria-describedby="vault-deletion-warning" /></label><p id="vault-deletion-warning" className="form-help">The impact token is bound to these counts. If the vault changes, Continuum will stop and ask you to review again.</p></>}
    </div>
  </Modal>;
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function numberValue(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function shortId(value: string): string { return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
function safeHttpUrl(value: string): string | null { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null; } catch { return null; } }
function evidenceTitle(type: EvidenceRecord["type"], detail: Record<string, unknown>): string {
  const nested = type === "claim" ? asRecord(detail.claim ?? detail) : type === "entity" ? asRecord(detail.entity ?? detail) : type === "source" ? asRecord(detail.source ?? detail) : detail;
  if (type === "claim") return `${stringValue(nested.subject, "Claim")} ${stringValue(nested.predicate)}`.trim();
  if (type === "entity") return stringValue(nested.displayName, "Memory entity");
  if (type === "source") return stringValue(nested.title, "Retained source");
  if (type === "source_chunk") return stringValue(nested.sourceTitle, "Source excerpt");
  if (type === "attachment") return stringValue(nested.filename, "Attachment");
  if (type === "tool_result") return stringValue(nested.toolName, "Tool result");
  return "Exact evidence";
}
