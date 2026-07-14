import { type ReactNode, useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, BrainCircuit, Check, ChevronDown, ChevronRight, Database, FileText, GitBranch, GitMerge, Info, Layers3, LoaderCircle, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, SearchCheck, Sparkles, Trash2, X } from "lucide-react";

import type { AttentionItem, BudgetSummary, DebugSnapshot, MemoryReference, RuntimeState, TopicPage, TopicProposal } from "../lib/types";
import { IconButton, Modal, SegmentedControl, formatRelativeTime } from "./Primitives";

export function MemoryInspector({ open, requestedTab, answerRunId, traceLoading, memories, topics, attention, proposals, debug, runtime, budget, onClose, onNavigate, onPin, onEditTopic, onDeleteMemory, onResolveProposal, onReviewEntityMerges, onRetryJob, onLint }: {
  open: boolean;
  requestedTab: "memory" | "debug";
  answerRunId: string | null;
  traceLoading: boolean;
  memories: MemoryReference[];
  topics: TopicPage[];
  attention: AttentionItem[];
  proposals: TopicProposal[];
  debug: DebugSnapshot;
  runtime: RuntimeState;
  budget: BudgetSummary;
  onClose: () => void;
  onNavigate: (memory: MemoryReference) => void;
  onPin: (memory: MemoryReference, pinned: boolean) => void;
  onEditTopic: (topic: TopicPage) => void;
  onDeleteMemory: (memory: MemoryReference) => void;
  onResolveProposal: (proposal: TopicProposal, action: "accept" | "reject") => Promise<void>;
  onReviewEntityMerges: () => void;
  onRetryJob: (jobId: string) => void;
  onLint: () => void;
}) {
  const [tab, setTab] = useState<"memory" | "debug">("memory");
  const [expandedAttention, setExpandedAttention] = useState<string | null>(null);
  const [resolvingProposal, setResolvingProposal] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  useEffect(() => { if (open) setTab(requestedTab); }, [open, requestedTab]);
  if (!open) return null;
  return <aside className="side-drawer memory-drawer" aria-label="Memory inspector">
    <header className="drawer-header"><div><span className="drawer-eyebrow">{answerRunId ? `Answer ${answerRunId.slice(0, 8)}` : "No answer selected"}</span><h2>Memory inspector</h2></div>{traceLoading && <LoaderCircle size={16} className="spin" aria-label="Loading answer provenance" />}<IconButton label="Close memory inspector" onClick={onClose}><X size={18} /></IconButton></header>
    <div className="drawer-tabs"><button type="button" className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}><BrainCircuit size={15} /> Memory</button><button type="button" className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}><Database size={15} /> Debug</button></div>
    {tab === "memory" ? <div className="drawer-scroll">
      <section className="inspector-section">
        <div className="section-heading"><div><h3>Evidence used</h3><p>{memories.length} items selected for this answer</p></div><span className="section-badge">grounded</span></div>
        <div className="memory-list">{memories.length ? memories.map((memory) => <MemoryCard key={memory.id} memory={memory} topic={topics.find((topic) => topic.id === memory.topicId)} onNavigate={onNavigate} onPin={onPin} onEditTopic={onEditTopic} onDelete={onDeleteMemory} />) : <p className="inspector-empty">No historical evidence was selected for the active answer.</p>}</div>
      </section>
      <section className="inspector-section">
        <div className="section-heading"><div><h3>Current topics</h3><p>Compiled pages connected to this turn</p></div></div>
        <div className="topic-mini-list">{topics.length ? topics.slice(0, 4).map((topic) => <button type="button" key={topic.id} onClick={() => onNavigate({ id: topic.id, type: "topic", title: topic.title, excerpt: topic.summary, topicId: topic.id })}><span className={`topic-icon topic-${topic.type}`}><GitBranch size={14} /></span><span><strong>{topic.title}</strong><small>{topic.type} · revision {topic.revision}</small></span><ChevronRight size={15} /></button>) : <p className="inspector-empty">Topic pages will appear after durable memory is compiled.</p>}</div>
      </section>
      <section className="inspector-section">
        <div className="section-heading"><div><h3>Needs attention</h3><p>Memory quality checks and proposed page changes</p></div>{attention.length + proposals.length > 0 && <span className="attention-count">{attention.length + proposals.length}</span>}</div>
        {proposals.length > 0 && <div className="proposal-list">{proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} resolving={resolvingProposal === proposal.id} onResolve={(action) => { setResolvingProposal(proposal.id); setProposalError(null); void onResolveProposal(proposal, action).catch((error: unknown) => setProposalError(error instanceof Error ? error.message : "The proposal could not be resolved.")).finally(() => setResolvingProposal(null)); }} />)}</div>}
        {proposalError && <p className="error-copy" role="alert"><AlertTriangle size={13} /> {proposalError}</p>}
        {attention.length ? <div className="attention-list">{attention.map((item) => <div className={`attention-card attention-${item.kind}`} key={item.id}>
          <button type="button" onClick={() => setExpandedAttention(expandedAttention === item.id ? null : item.id)}><AlertTriangle size={15} /><span><strong>{item.title}</strong><small>{item.description}</small></span><ChevronDown size={15} className={expandedAttention === item.id ? "rotated" : ""} /></button>
          {expandedAttention === item.id && <div className="attention-detail"><p>Continuum will not resolve this automatically because it could change the meaning of retained memory. Inspect the related evidence before changing the durable view.</p>{item.kind === "merge" && <button type="button" className="secondary-button" onClick={onReviewEntityMerges}><GitMerge size={14} /> Review possible entity merges</button>}</div>}
        </div>)}</div> : proposals.length === 0 ? <div className="all-clear"><Check size={15} /> No unresolved memory issues</div> : null}
        <button type="button" className="merge-review-button" onClick={onReviewEntityMerges}><GitMerge size={15} /><span><strong>Review duplicate identities</strong><small>Inspect impact before any reversible entity merge</small></span><ChevronRight size={15} /></button>
      </section>
      <section className="inspector-section compact-section">
        <button type="button" className="lint-button" onClick={onLint}><SearchCheck size={16} /><span><strong>Run deep memory lint</strong><small>Check conflicts, stale claims, links, and duplicates</small></span><ArrowUpRight size={15} /></button>
      </section>
    </div> : <DebugPanel debug={debug} runtime={runtime} budget={budget} onRetryJob={onRetryJob} />}
  </aside>;
}

function ProposalCard({ proposal, resolving, onResolve }: { proposal: TopicProposal; resolving: boolean; onResolve: (action: "accept" | "reject") => void }) {
  const canAccept = proposal.canAccept !== false;
  return <article className="proposal-card">
    <header><span>{proposal.kind === "topic_patch" ? "Bounded topic patch" : proposal.kind === "topic_split" ? "Topic restructure / split" : "Topic update"}</span><small>{formatRelativeTime(proposal.proposedAt)}</small></header>
    <h4>{proposal.title}</h4>
    <p>{proposal.description}</p>
    <div className="proposal-reason"><Info size={13} /><span>{proposal.reason}</span></div>
    {!canAccept && proposal.acceptanceBlockedReason && <div className="proposal-reason"><AlertTriangle size={13} /><span>{proposal.acceptanceBlockedReason}</span></div>}
    {proposal.affectedTopicIds.length > 0 && <p className="proposal-affected">Affects {proposal.affectedTopicIds.length} {proposal.affectedTopicIds.length === 1 ? "topic" : "topics"}</p>}
    {proposal.proposedRevision && <details className="proposal-preview"><summary>Inspect proposed revision</summary><pre>{formatDebugValue(proposal.proposedRevision)}</pre></details>}
    <footer><button type="button" className="secondary-button" disabled={resolving} onClick={() => onResolve("reject")}>Reject</button>{canAccept && <button type="button" className="primary-button" disabled={resolving} onClick={() => onResolve("accept")}>{resolving ? "Applying…" : "Accept proposal"}</button>}</footer>
  </article>;
}

function MemoryCard({ memory, topic, onNavigate, onPin, onEditTopic, onDelete }: {
  memory: MemoryReference;
  topic: TopicPage | undefined;
  onNavigate: (memory: MemoryReference) => void;
  onPin: (memory: MemoryReference, pinned: boolean) => void;
  onEditTopic: (topic: TopicPage) => void;
  onDelete: (memory: MemoryReference) => void;
}) {
  const [menu, setMenu] = useState(false);
  return <article className="memory-card">
    <div className="memory-card-top"><span className={`memory-kind memory-${memory.type}`}>{memory.type === "topic" ? <GitBranch size={13} /> : <FileText size={13} />}{memory.type}</span><div className="popover-anchor"><IconButton label={`Actions for ${memory.title}`} onClick={() => setMenu((value) => !value)}><MoreHorizontal size={15} /></IconButton>{menu && <div className="memory-menu popover-panel">
      {memory.type !== "attachment" && <button type="button" onClick={() => { onPin(memory, !memory.pinned); setMenu(false); }}>{memory.pinned ? <PinOff size={14} /> : <Pin size={14} />}{memory.pinned ? "Unpin" : "Pin to context"}</button>}
      {topic && <button type="button" onClick={() => { onEditTopic(topic); setMenu(false); }}><Pencil size={14} /> Edit page</button>}
      {(memory.type === "event" || memory.type === "topic" || memory.type === "claim" || memory.type === "attachment") && <button type="button" className="danger-item" onClick={() => { onDelete(memory); setMenu(false); }}><Trash2 size={14} /> Delete</button>}
    </div>}</div></div>
    <button type="button" className="memory-card-content" onClick={() => onNavigate(memory)}><strong>{memory.title}</strong><p>{memory.excerpt}</p></button>
    <footer>{memory.status && <span className={`claim-status status-${memory.status}`}>{memory.status}</span>}{memory.pinned && <span><Pin size={11} /> Pinned</span>}{memory.reason && <span className="memory-reason"><Sparkles size={11} />{memory.reason}</span>}</footer>
  </article>;
}

function DebugPanel({ debug, runtime, budget, onRetryJob }: { debug: DebugSnapshot; runtime: RuntimeState; budget: BudgetSummary; onRetryJob: (id: string) => void }) {
  const [scoreMode, setScoreMode] = useState<"final" | "components">("final");
  const trace = debug.trace;
  const tokenTotal = trace ? trace.tokenBudget.instructions + trace.tokenBudget.recentTurns + trace.tokenBudget.evidence : 0;
  const allocatedPercent = Math.min(100, budget.capUsd > 0 ? (budget.allocatedUsd / budget.capUsd) * 100 : 100);
  const selected = trace?.candidates.filter((candidate) => candidate.selected) ?? [];
  const excluded = trace?.candidates.filter((candidate) => !candidate.selected) ?? [];
  const cachedTokenTotal = debug.modelCalls.reduce((total, call) => total + call.cachedInputTokens, 0);
  return <div className="drawer-scroll debug-panel">
    <section className="inspector-section debug-summary">
      <div className="debug-status"><span className={`big-status status-${runtime.memoryQueue === "failed" ? "failed" : runtime.memoryQueue === "working" ? "working" : "ready"}`}><BrainCircuit size={18} /></span><div><strong>{runtime.memoryQueue === "working" ? "Memory compiling" : runtime.memoryQueue === "failed" ? "Memory update failed" : trace ? "Turn fully indexed" : "No completed retrieval yet"}</strong><small>{runtime.lastMemoryUpdate ? `Updated ${formatRelativeTime(runtime.lastMemoryUpdate)}` : "No completed update"}</small></div></div>
      <div className="metric-grid"><Metric label="Retrieval" value={trace ? `${Math.round(trace.latencyMs)} ms` : "—"} /><Metric label="Candidates" value={trace ? String(trace.candidates.length) : "—"} /><Metric label="Selected" value={trace ? String(trace.selectedIds.length) : "—"} /><Metric label="Input" value={trace ? tokenTotal.toLocaleString() : "—"} /></div>
    </section>
    <section className="inspector-section">
      <h3>Query understanding</h3>
      <p className="debug-query">“{trace?.query ?? "No retrieval trace for this turn"}”</p>
      <div className="classification-row">{trace?.classifications.map((classification) => <span key={classification}>{classification.replaceAll("_", " ")}</span>)}</div>
    </section>
    <section className="inspector-section">
      <div className="section-heading"><div><h3>Candidate ranking</h3><p>Why evidence entered the context packet</p></div></div>
      <SegmentedControl label="Candidate score view" value={scoreMode} options={[{ value: "final", label: "Final" }, { value: "components", label: "Signals" }]} onChange={setScoreMode} />
      <div className="candidate-list">
        {selected.map((candidate) => <details className="candidate selected" key={candidate.id} open><summary><Check size={13} /><span><strong>{candidate.title}</strong><small>{candidate.reason}</small></span><em>{Math.round((candidate.rerankScore ?? candidate.fusedScore) * 100)}</em></summary>{scoreMode === "components" && <ScoreSignals candidate={candidate} />}</details>)}
        {excluded.map((candidate) => <details className="candidate excluded" key={candidate.id}><summary><X size={13} /><span><strong>{candidate.title}</strong><small>{candidate.reason}</small></span><em>{Math.round((candidate.rerankScore ?? candidate.fusedScore) * 100)}</em></summary>{scoreMode === "components" && <ScoreSignals candidate={candidate} />}</details>)}
        {!trace && <p className="inspector-empty">Send a message to record a reproducible retrieval trace.</p>}
      </div>
    </section>
    <section className="inspector-section">
      <div className="section-heading"><div><h3>Context packet</h3><p>Selected input, not the whole transcript</p></div><span className="section-badge">{tokenTotal.toLocaleString()} tokens</span></div>
      {trace && tokenTotal > 0 ? <div className="token-allocation" aria-label="Context token allocation">
        <div className="allocation-bar"><span className="allocation-instructions" style={{ width: `${(trace.tokenBudget.instructions / tokenTotal) * 100}%` }} /><span className="allocation-recent" style={{ width: `${(trace.tokenBudget.recentTurns / tokenTotal) * 100}%` }} /><span className="allocation-evidence" style={{ width: `${(trace.tokenBudget.evidence / tokenTotal) * 100}%` }} /></div>
        <TokenLine color="instructions" label="Instructions + tools" value={trace.tokenBudget.instructions} />
        <TokenLine color="recent" label="Recent turns" value={trace.tokenBudget.recentTurns} />
        <TokenLine color="evidence" label="Retrieved evidence" value={trace.tokenBudget.evidence} />
        <TokenLine color="output" label="Reserved output" value={trace.tokenBudget.reservedOutput} />
      </div> : <p className="inspector-empty">No context packet has been assembled yet.</p>}
      {debug.contextPacket ? <div className="context-packet-exact">
        <div className="context-packet-meta"><span><small>Packet hash</small><code>{debug.contextPacket.hash}</code></span><span><small>Prompt version</small><code>{debug.contextPacket.promptVersion}</code></span><span><small>Maximum input</small><strong>{debug.contextPacket.tokenBudget.maximumInput?.toLocaleString() ?? "—"}</strong></span></div>
        <details><summary>Ordered source IDs ({debug.contextPacket.orderedSourceIds.length})</summary>{debug.contextPacket.orderedSourceIds.length ? <ol>{debug.contextPacket.orderedSourceIds.map((id, index) => <li key={`${id}:${index}`}><span>{index + 1}</span><code>{id}</code></li>)}</ol> : <p>No durable source IDs were included.</p>}</details>
        <details><summary><span>{debug.contextPacket.reconstructionIntegrity === "verified" ? "Exact rendered packet" : "Rendered packet unavailable"}</span>{debug.contextPacket.reconstructionIntegrity === "verified" && <em>verified from references</em>}</summary>
          {debug.contextPacket.reconstructionIntegrity === "verified"
            ? <pre>{debug.contextPacket.renderedContent}</pre>
            : <p>The audit record contains references and hashes only. One or more referenced bodies are no longer available or did not match, so Continuum will not display stale packet text.{debug.contextPacket.unavailableReferenceIds.length ? ` Missing references: ${debug.contextPacket.unavailableReferenceIds.join(", ")}.` : ""}</p>}
        </details>
      </div> : <p className="debug-unavailable">The exact rendered packet was not returned for this answer.</p>}
    </section>
    <section className="inspector-section">
      <div className="section-heading"><div><h3>Model calls</h3><p>{cachedTokenTotal > 0 ? `${cachedTokenTotal.toLocaleString()} cached input tokens` : "No cached input tokens for this answer"}</p></div></div>
      <div className="call-list">{debug.modelCalls.length ? debug.modelCalls.map((call) => <details key={call.id}><summary><span className={`call-icon call-${call.status}`}>{call.status === "running" ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}</span><span><strong>{call.label}</strong><small>{call.model}</small></span><em>{call.latencyMs.toLocaleString()} ms</em><ChevronDown size={14} /></summary><div className="call-detail"><span>{call.inputTokens.toLocaleString()} input</span><span>{call.cachedInputTokens.toLocaleString()} cached</span><span>{call.outputTokens.toLocaleString()} output</span><span>${call.estimatedCostUsd.toFixed(3)}</span>{call.promptVersion && <span>prompt {call.promptVersion}</span>}{call.modelVersion && <span>model {call.modelVersion}</span>}</div></details>) : <p className="inspector-empty">No model calls recorded.</p>}</div>
    </section>
    <section className="inspector-section">
      <div className="section-heading"><div><h3>Tool calls</h3><p>Arguments, outputs, timing, and sandbox boundary</p></div></div>
      <div className="tool-debug-list">{debug.toolCalls.length ? debug.toolCalls.map((call) => <details key={call.id}><summary><span className={`call-icon call-${call.status}`}><Database size={13} /></span><span><strong>{call.name}</strong><small>{call.status} · {call.durationMs.toLocaleString()} ms</small></span><ChevronDown size={14} /></summary><div className="tool-debug-detail"><span><small>Started</small><code>{call.startedAt ?? "—"}</code></span><span><small>Completed</small><code>{call.completedAt ?? "—"}</code></span><section><h4>Arguments</h4><pre>{formatDebugValue(call.arguments)}</pre></section><section><h4>Output</h4><pre>{formatDebugValue(call.output)}</pre></section><section><h4>Sandbox</h4><pre>{formatDebugValue(call.sandbox)}</pre></section></div></details>) : <p className="inspector-empty">No tool calls were recorded for this answer.</p>}</div>
    </section>
    <section className="inspector-section">
      <div className="section-heading"><div><h3>Background jobs</h3><p>Durable and safe to retry</p></div></div>
      <div className="job-list">{debug.jobs.length ? debug.jobs.map((job) => <div key={job.id}><span className={`job-status job-${job.status}`}>{job.status === "running" ? <LoaderCircle size={13} className="spin" /> : job.status === "failed" ? <AlertTriangle size={13} /> : <Check size={13} />}</span><span><strong>{job.name}</strong><small>{job.status} · attempt {job.attempts}</small></span>{job.status === "failed" && <IconButton label={`Retry ${job.name}`} onClick={() => onRetryJob(job.id)}><RefreshCw size={14} /></IconButton>}</div>) : <p className="inspector-empty">No background memory jobs.</p>}</div>
    </section>
    <section className="inspector-section">
      <div className="section-heading"><div><h3>API budget</h3><p>Hard stop at ${budget.capUsd.toFixed(0)}</p></div><span className="section-badge">${budget.allocatedUsd.toFixed(2)} allocated</span></div>
      <div className="budget-meter"><span style={{ width: `${allocatedPercent}%` }} /></div><div className="budget-labels"><span>{allocatedPercent.toFixed(1)}% allocated · ${budget.totalUsd.toFixed(2)} spent + ${budget.reservedUsd.toFixed(2)} reserved</span><span>${budget.availableUsd.toFixed(2)} available</span></div>
    </section>
    <section className="inspector-section"><div className="section-heading"><div><h3>Version identifiers</h3><p>Reproduce this answer with the same pipeline</p></div></div><div className="version-grid"><VersionIdentifier icon={<Info size={13} />} label="Prompt" value={debug.versions.prompt} /><VersionIdentifier icon={<Layers3 size={13} />} label="Schema" value={debug.versions.schema} /><VersionIdentifier label="Retrieval" value={debug.versions.retrieval} /><VersionIdentifier label="Reranker" value={debug.versions.reranker} /><VersionIdentifier label="Context builder" value={debug.versions.contextBuilder} /><VersionIdentifier label="Vector" value={debug.versions.vector} /><VersionIdentifier label="Parser" value={debug.versions.parser} /><VersionIdentifier label="Chunker" value={debug.versions.chunker} /><VersionIdentifier label="Response model" value={debug.versions.responseModel} /><VersionIdentifier label="Embedding model" value={debug.versions.embeddingModel} /></div></section>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function TokenLine({ color, label, value }: { color: string; label: string; value: number }) { return <div className="token-line"><span className={`token-color token-${color}`} /><span>{label}</span><strong>{value.toLocaleString()}</strong></div>; }
function VersionIdentifier({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) { return <span>{icon}{label}<strong title={value}>{value}</strong></span>; }
function formatDebugValue(value: unknown) {
  if (value === undefined) return "Not recorded";
  if (value === null) return "None";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return "The recorded value could not be displayed."; }
}
function ScoreSignals({ candidate }: { candidate: NonNullable<DebugSnapshot["trace"]>["candidates"][number] }) {
  return <div className="score-signals">{[["Lexical", candidate.lexicalScore], ["Vector", candidate.vectorScore], ["Graph", candidate.graphScore], ["Temporal", candidate.temporalScore], ["Fused", candidate.fusedScore]] .map(([label, score]) => <span key={String(label)}><small>{label}</small><strong>{typeof score === "number" ? score.toFixed(2) : "—"}</strong></span>)}</div>;
}

export function TopicEditor({ topic, open, onClose, onSave }: { topic: TopicPage | null; open: boolean; onClose: () => void; onSave: (topic: TopicPage, patch: Partial<TopicPage>) => Promise<void> }) {
  const [summary, setSummary] = useState(topic?.summary ?? "");
  const [currentState, setCurrentState] = useState(topic?.currentState ?? "");
  const [tags, setTags] = useState(topic?.tags.join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!topic) return;
    setSummary(topic.summary);
    setCurrentState(topic.currentState);
    setTags(topic.tags.join(", "));
    setSaveError(null);
  }, [topic]);
  if (!topic) return null;
  return <Modal open={open} title={`Edit ${topic.title}`} description="Your revision is trusted, visibly user-authored, and will not be overwritten by automatic compilation." dismissible={!saving} onClose={onClose} footer={<><span className="modal-footer-status" role="status">{saveError}</span><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={saving || !summary.trim()} onClick={() => { setSaving(true); setSaveError(null); void onSave(topic, { summary: summary || topic.summary, currentState: currentState || topic.currentState, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), userAuthored: true }).catch((error: unknown) => setSaveError(error instanceof Error ? error.message : "The revision could not be saved.")).finally(() => setSaving(false)); }}>{saving ? "Saving…" : "Save trusted revision"}</button></>}>
    <div className="edit-topic-form"><label>Summary<textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} /></label><label>Current state<textarea rows={4} value={currentState} onChange={(event) => setCurrentState(event.target.value)} /></label><label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="decision, architecture" /></label><div className="trust-note"><Pin size={15} /><span><strong>User-authored revision</strong><small>Future automatic updates will be proposed separately.</small></span></div></div>
  </Modal>;
}
