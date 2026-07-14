import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BrainCircuit, Check, Copy, ExternalLink, FileText, GitBranch, History, LoaderCircle, MoreHorizontal, RefreshCw, Sparkles, Trash2, Wrench } from "lucide-react";
import type { Attachment } from "@continuum/contracts";

import { continuumApi } from "../lib/api-client";
import type { ConversationEvent, MemoryReference } from "../lib/types";
import { EmptyState, IconButton, formatBytes, formatRelativeTime } from "./Primitives";
import { SafeMarkdown } from "./SafeMarkdown";

const MAX_MOUNTED_EVENTS = 160;
const WINDOW_SHIFT = 80;

export function ChatTimeline({ events, offline, hasOlder, loadingOlder, onLoadOlder, referencesByRunId, loadingTraceRunIds, highlightedEventId, revealedEventIds, onSource, onInspectAnswer, onShowInGraph, onOpenRevisions, onRegenerate, onDelete, onDeleteAttachment, onRetry }: {
  events: ConversationEvent[];
  offline: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  referencesByRunId: Record<string, MemoryReference[]>;
  loadingTraceRunIds: Set<string>;
  highlightedEventId: string | null;
  revealedEventIds: Set<string>;
  onSource: (reference: MemoryReference) => void;
  onInspectAnswer: (event: ConversationEvent) => void;
  onShowInGraph: (event: ConversationEvent) => void;
  onOpenRevisions: (eventId: string) => void;
  onRegenerate: (eventId: string) => void;
  onDelete: (eventId: string) => void;
  onDeleteAttachment: (attachmentId: string, title: string) => void;
  onRetry: (eventId: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const previousLastId = useRef<string | null>(null);
  const followLatestRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const visibleEvents = useMemo(
    () => events.filter((event) => event.active || revealedEventIds.has(event.id) || event.kind === "tool_call" || event.kind === "tool_result"),
    [events, revealedEventIds]
  );
  const previousVisibleIds = useRef<string[]>([]);
  const [windowRange, setWindowRange] = useState(() => ({
    start: Math.max(0, visibleEvents.length - MAX_MOUNTED_EVENTS),
    end: visibleEvents.length
  }));

  useEffect(() => {
    const nextIds = visibleEvents.map((event) => event.id);
    const previousIds = previousVisibleIds.current;
    setWindowRange((current) => {
      if (highlightedEventId) {
        const highlightedIndex = nextIds.indexOf(highlightedEventId);
        if (highlightedIndex >= 0) {
          const start = Math.max(0, Math.min(highlightedIndex - Math.floor(MAX_MOUNTED_EVENTS / 2), nextIds.length - MAX_MOUNTED_EVENTS));
          return { start, end: Math.min(nextIds.length, start + MAX_MOUNTED_EVENTS) };
        }
      }

      if (previousIds.length === 0) return { start: Math.max(0, nextIds.length - MAX_MOUNTED_EVENTS), end: nextIds.length };
      const wasFollowingLatest = current.end >= previousIds.length;
      const previousLastVisibleId = previousIds[Math.max(current.start, current.end - 1)];
      const previousFirstVisibleId = previousIds[current.start];
      if (wasFollowingLatest && nextIds.at(-1) !== previousIds.at(-1)) {
        return { start: Math.max(0, nextIds.length - MAX_MOUNTED_EVENTS), end: nextIds.length };
      }
      const nextStart = previousFirstVisibleId ? nextIds.indexOf(previousFirstVisibleId) : -1;
      const nextLast = previousLastVisibleId ? nextIds.indexOf(previousLastVisibleId) : -1;
      if (nextStart >= 0 && nextLast >= nextStart) return { start: nextStart, end: Math.min(nextIds.length, nextLast + 1) };
      return { start: Math.max(0, nextIds.length - MAX_MOUNTED_EVENTS), end: nextIds.length };
    });
    previousVisibleIds.current = nextIds;
  }, [highlightedEventId, visibleEvents]);

  useEffect(() => {
    const updateFollowState = () => {
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      followLatestRef.current = window.scrollY + window.innerHeight >= documentHeight - 160;
    };
    updateFollowState();
    window.addEventListener("scroll", updateFollowState, { passive: true });
    window.addEventListener("resize", updateFollowState);
    return () => {
      window.removeEventListener("scroll", updateFollowState);
      window.removeEventListener("resize", updateFollowState);
    };
  }, []);

  useEffect(() => {
    const last = events.at(-1);
    if (!last) return;
    const firstPaint = previousLastId.current === null;
    const appended = previousLastId.current !== last.id;
    if (firstPaint || (followLatestRef.current && (appended || last.status === "streaming"))) {
      if (scrollFrameRef.current !== null) window.clearTimeout(scrollFrameRef.current);
      scrollFrameRef.current = window.setTimeout(() => {
        endRef.current?.scrollIntoView({ block: "end", behavior: firstPaint ? "auto" : "smooth" });
        scrollFrameRef.current = null;
      }, firstPaint ? 0 : 40);
    }
    previousLastId.current = last.id;
    return () => {
      if (scrollFrameRef.current !== null) window.clearTimeout(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, [events]);

  if (!events.length) return <div className="conversation conversation-empty"><EmptyState icon={offline ? <AlertTriangle size={28} /> : <BrainCircuit size={28} />} title={offline ? "Vault data is unavailable" : "Start your continuous conversation"} description={offline ? "Continuum did not load preview content in place of your vault. Reconnect the local service to view retained history." : "Ask a question, attach a source, or tell Continuum something worth remembering. Every retained turn remains searchable."} /></div>;

  const boundedStart = Math.min(windowRange.start, Math.max(0, visibleEvents.length - 1));
  const boundedEnd = Math.max(boundedStart, Math.min(windowRange.end, visibleEvents.length));
  const mountedEvents = visibleEvents.slice(boundedStart, boundedEnd);
  const earlierLoadedCount = boundedStart;
  const newerLoadedCount = visibleEvents.length - boundedEnd;

  const latestStatus = events.at(-1)?.status;
  return <div className="conversation" aria-busy={events.some((event) => event.status === "streaming")}>
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{latestStatus === "streaming" ? "Assistant response is streaming." : latestStatus === "incomplete" ? "Assistant response was interrupted and can be retried." : latestStatus === "failed" ? "Response failed and can be retried." : ""}</div>
    {hasOlder && <button type="button" className="load-history-button" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{loadingOlder ? "Loading earlier history…" : "Load earlier history"}</button>}
    {earlierLoadedCount > 0 && <button type="button" className="timeline-window-button" onClick={() => setWindowRange((current) => {
      const start = Math.max(0, current.start - WINDOW_SHIFT);
      return { start, end: Math.min(visibleEvents.length, start + MAX_MOUNTED_EVENTS) };
    })}>Show earlier loaded messages <span>{earlierLoadedCount.toLocaleString()} hidden</span></button>}
    {mountedEvents.map((event) => {
      if (event.role === "tool" || event.kind === "tool_call" || event.kind === "tool_result") return <ToolEvent key={event.id} event={event} />;
      return <Message
        key={event.id}
        event={event}
        references={event.runId ? referencesByRunId[event.runId] ?? [] : []}
        traceLoading={Boolean(event.runId && loadingTraceRunIds.has(event.runId))}
        highlighted={highlightedEventId === event.id}
        onSource={onSource}
        onInspectAnswer={onInspectAnswer}
        onShowInGraph={onShowInGraph}
        onOpenRevisions={onOpenRevisions}
        onRegenerate={onRegenerate}
        onDelete={onDelete}
        onRetry={onRetry}
        onDeleteAttachment={onDeleteAttachment}
      />;
    })}
    {newerLoadedCount > 0 && <button type="button" className="timeline-window-button" onClick={() => setWindowRange((current) => {
      const end = Math.min(visibleEvents.length, current.end + WINDOW_SHIFT);
      return { start: Math.max(0, end - MAX_MOUNTED_EVENTS), end };
    })}>Show newer loaded messages <span>{newerLoadedCount.toLocaleString()} hidden</span></button>}
    <div ref={endRef} />
  </div>;
}

function Message({ event, references, traceLoading, highlighted, onSource, onInspectAnswer, onShowInGraph, onOpenRevisions, onRegenerate, onDelete, onDeleteAttachment, onRetry }: {
  event: ConversationEvent;
  references: MemoryReference[];
  traceLoading: boolean;
  highlighted: boolean;
  onSource: (reference: MemoryReference) => void;
  onInspectAnswer: (event: ConversationEvent) => void;
  onShowInGraph: (event: ConversationEvent) => void;
  onOpenRevisions: (eventId: string) => void;
  onRegenerate: (eventId: string) => void;
  onDelete: (eventId: string) => void;
  onDeleteAttachment: (attachmentId: string, title: string) => void;
  onRetry: (eventId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const failed = event.status === "failed";
  const incomplete = event.status === "incomplete";
  const streaming = event.status === "streaming";

  const messageReferences = useMemo(() => references.slice(0, 4), [references]);
  return <article id={`event-${event.id}`} className={`message ${event.role}-message ${highlighted ? "message-highlight" : ""} ${failed ? "message-failed" : ""}`} data-event-id={event.id}>
    {event.role === "assistant" && <div className="assistant-avatar" aria-hidden="true"><Sparkles size={16} /></div>}
    <div className={event.role === "assistant" ? "assistant-body" : "message-bubble"}>
      {event.attachments.length > 0 && <div className="message-attachments">
        {event.attachments.map((attachment) => <PersistedAttachment key={attachment.id} attachment={attachment} onDelete={onDeleteAttachment} />)}
      </div>}
      <div className="message-content">
        {event.role === "assistant" ? <SafeMarkdown onTopicLink={(identity) => onSource({ id: identity, type: "topic", title: identity, excerpt: "Related durable-memory page", topicId: identity })}>{event.content || (streaming ? "" : "No response content.")}</SafeMarkdown> : <p>{event.content}</p>}
        {streaming && <span className="stream-caret" aria-label="Response streaming" />}
      </div>
      {failed && <div className="inline-alert"><AlertTriangle size={15} /><span>{event.role === "user" ? "This message was not saved. Its draft and files were restored." : "This response failed before completion."}</span><button type="button" onClick={() => onRetry(event.id)}>{event.role === "user" ? "Send again" : "Retry response"}</button></div>}
      {incomplete && <div className="inline-alert"><AlertTriangle size={15} /><span>This response was interrupted and retained verbatim, but excluded from long-term memory.</span><button type="button" onClick={() => onRetry(event.id)}>Retry response</button></div>}
      {!event.active && <div className="incomplete-note">Historical revision · excluded from active memory</div>}
      {messageReferences.length > 0 && !failed && <div className="source-row" aria-label="Sources used">
        {messageReferences.map((reference) => <button type="button" className={`source-chip source-${reference.status ?? "current"}`} key={reference.id} onClick={() => onSource(reference)}>
          {reference.type === "topic" ? <GitBranch size={13} /> : <FileText size={13} />}{reference.title}<span>{reference.type}</span>
        </button>)}
        {references.length > messageReferences.length && <button type="button" className="source-chip more-sources" onClick={() => onSource(references[messageReferences.length]!)}>+{references.length - messageReferences.length} more</button>}
      </div>}
      {traceLoading && <div className="source-loading" role="status"><LoaderCircle size={13} className="spin" /> Loading this answer’s provenance…</div>}
      <div className="message-meta">
        <span>{formatRelativeTime(event.createdAt)}</span>
        {event.role === "assistant" && event.kind === "revision" && <span className="revision-label">Regenerated revision</span>}
        <div className="message-actions">
          <IconButton label={copied ? "Copied" : "Copy message"} onClick={() => { void navigator.clipboard.writeText(event.content); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>
          {event.role === "assistant" && event.runId && !streaming && <IconButton label="Inspect this answer’s provenance" onClick={() => onInspectAnswer(event)}><BrainCircuit size={14} /></IconButton>}
          {event.role === "assistant" && !streaming && <IconButton label="Show this answer in the knowledge graph" onClick={() => onShowInGraph(event)}><GitBranch size={14} /></IconButton>}
          {event.role === "assistant" && !streaming && <IconButton label="View persisted response revisions" onClick={() => onOpenRevisions(event.id)}><History size={14} /></IconButton>}
          {event.role === "assistant" && !streaming && <IconButton label="Regenerate response" onClick={() => onRegenerate(event.id)}><RefreshCw size={14} /></IconButton>}
          <div className="popover-anchor">
            <IconButton label="More message actions" onClick={() => setMenu((value) => !value)}><MoreHorizontal size={15} /></IconButton>
            {menu && <div className="message-menu popover-panel"><button type="button" className="danger-item" onClick={() => { setMenu(false); onDelete(event.id); }}><Trash2 size={14} /> Delete permanently</button></div>}
          </div>
        </div>
      </div>
    </div>
  </article>;
}

function PersistedAttachment({ attachment, onDelete }: { attachment: Attachment; onDelete: (attachmentId: string, title: string) => void }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const canPreview = attachment.status === "ready" && attachment.mediaType.startsWith("image/") && !previewFailed;
  return <div className={`message-file-wrap ${canPreview ? "message-image-wrap" : ""}`}>
    {canPreview
      ? <figure className="message-image"><img src={continuumApi.attachmentContentUrl(attachment.id)} alt={attachment.filename} loading="lazy" decoding="async" onError={() => setPreviewFailed(true)} /><figcaption><strong>{attachment.filename}</strong><small>{formatBytes(attachment.size)}</small></figcaption></figure>
      : <div className="message-file"><FileText size={16} /><span><strong>{attachment.filename}</strong><small>{formatBytes(attachment.size)} · {previewFailed ? "preview unavailable" : attachment.status}</small></span></div>}
    {attachment.status === "ready" && <IconButton label={`Delete ${attachment.filename} permanently`} onClick={() => onDelete(attachment.id, attachment.filename)}><Trash2 size={13} /></IconButton>}
  </div>;
}

function ToolEvent({ event }: { event: ConversationEvent }) {
  const payload = useMemo(() => parseToolPayload(event.content), [event.content]);
  const label = payload.name ? `${event.kind === "tool_call" ? "Using" : "Result from"} ${payload.name.replaceAll("_", " ")}` : event.kind === "tool_call" ? "Using a tool" : "Tool result";
  return <details className="tool-event">
    <summary><Wrench size={14} /><span>{label}</span><small>{event.status === "complete" ? "Complete" : event.status}</small></summary>
    {payload.citations.length > 0 && <div className="tool-citations" aria-label="Web citations">{payload.citations.map((citation) => <a key={`${citation.url}-${citation.title}`} href={citation.url} target="_blank" rel="noreferrer"><span><strong>{citation.title || new URL(citation.url).hostname}</strong><small>{new URL(citation.url).hostname}</small></span><ExternalLink size={13} /></a>)}</div>}
    <details className="tool-raw"><summary>Technical details</summary><pre>{event.content}</pre></details>
  </details>;
}

function parseToolPayload(content: string): { name: string | null; citations: Array<{ title: string; url: string }> } {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { name: null, citations: [] };
    const record = value as Record<string, unknown>;
    const citations = Array.isArray(record.citations) ? record.citations.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const citation = candidate as Record<string, unknown>;
      if (typeof citation.url !== "string") return [];
      try {
        const url = new URL(citation.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") return [];
        return [{ title: typeof citation.title === "string" ? citation.title : "", url: url.toString() }];
      } catch { return []; }
    }) : [];
    return { name: typeof record.name === "string" ? record.name : null, citations };
  } catch { return { name: null, citations: [] }; }
}
