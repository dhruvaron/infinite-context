import { useEffect, useRef } from "react";
import { AlertTriangle, ArrowUp, FileArchive, FileCode2, FileImage, FileText, Globe2, Paperclip, RotateCcw, Square, X } from "lucide-react";

import type { PendingAttachment, StreamProgress } from "../lib/types";
import { IconButton, formatBytes } from "./Primitives";

const ACCEPTED = ".txt,.md,.markdown,.mdx,.json,.csv,.pdf,.png,.jpg,.jpeg,.webp,.js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx,.py,.c,.h,.cc,.cpp,.hpp,.go,.rs,.java,.sh,.bash,.yaml,.yml,.css,.html,.htm";

function fileIcon(type: string, name: string) {
  if (type.startsWith("image/")) return <FileImage size={16} />;
  if (/\.(js|jsx|ts|tsx|py|go|rs|java|css|html)$/i.test(name)) return <FileCode2 size={16} />;
  if (/\.(json|csv)$/i.test(name)) return <FileArchive size={16} />;
  return <FileText size={16} />;
}

export function Composer({ draft, attachments, progress, memoryPaused, webSearchEnabled, retryAvailable, disabled, onDraft, onFiles, onRemoveAttachment, onSubmit, onStop, onResumeResponse, onRetryResponse, onToggleMemory, onToggleWeb }: {
  draft: string;
  attachments: PendingAttachment[];
  progress: StreamProgress;
  memoryPaused: boolean;
  webSearchEnabled: boolean;
  retryAvailable: boolean;
  disabled?: boolean;
  onDraft: (draft: string) => void;
  onFiles: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onResumeResponse: () => void;
  onRetryResponse: () => void;
  onToggleMemory: () => void;
  onToggleWeb: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = !["idle", "cancelled", "failed"].includes(progress.stage);
  useEffect(() => {
    const target = textarea.current;
    if (!target) return;
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 190)}px`;
  }, [draft]);

  return <div className="composer-wrap">
    <form className={`composer ${running ? "composer-running" : ""}`} onSubmit={(event) => { event.preventDefault(); if (!running && !disabled) onSubmit(); }}>
      {attachments.length > 0 && <div className="attachment-tray" aria-label="Attached files">
        {attachments.map((attachment) => <div className={`attachment-chip attachment-${attachment.status}`} key={attachment.localId}>
          {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <span className="file-icon">{fileIcon(attachment.file.type, attachment.file.name)}</span>}
          <span className="attachment-copy"><strong>{attachment.file.name}</strong><small>{attachment.status === "uploading" ? "Uploading…" : attachment.status === "failed" ? attachment.error : attachment.fileUnavailable ? `${formatBytes(attachment.remote?.size ?? 0)} · recovered upload` : formatBytes(attachment.file.size)}</small></span>
          <IconButton label={`Remove ${attachment.file.name}`} onClick={() => onRemoveAttachment(attachment.localId)}><X size={14} /></IconButton>
        </div>)}
      </div>}
      <textarea
        ref={textarea}
        aria-label="Message Continuum"
        placeholder={progress.stage === "connection_lost" ? "Resume or stop the active response before sending another message…" : running ? "Continuum is responding…" : disabled ? "Draft here while the local service reconnects…" : "Ask anything across your whole history…"}
        rows={1}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!running && !disabled && (draft.trim() || attachments.length)) onSubmit();
          }
        }}
      />
      <div className="composer-footer">
        <div className="composer-tools">
          <IconButton label="Attach files" className="subtle" disabled={running} onClick={() => fileInput.current?.click()}><Paperclip size={18} /></IconButton>
          <input ref={fileInput} className="visually-hidden" type="file" multiple accept={ACCEPTED} onChange={(event) => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" disabled={disabled} className={`tool-pill ${memoryPaused ? "paused" : ""}`} onClick={onToggleMemory}><span className="pulse-dot" /> {memoryPaused ? "Memory paused" : "Memory on"}</button>
          <button type="button" disabled={disabled} className={`tool-pill mobile-hide ${webSearchEnabled ? "active" : "paused"}`} aria-pressed={webSearchEnabled} onClick={onToggleWeb}><Globe2 size={14} /> {webSearchEnabled ? "Web when needed" : "Web off"}</button>
        </div>
        {running
          ? progress.stage === "connection_lost"
            ? null
            : <button className="stop-button" type="button" disabled={disabled || progress.stage === "cancelling" || progress.stage === "saving"} onClick={onStop} aria-label={progress.stage === "cancelling" ? "Stopping response" : progress.stage === "saving" ? "Message is being saved" : "Stop response"}><Square size={13} fill="currentColor" /></button>
          : <button className="send-button" type="submit" aria-label="Send message" disabled={disabled || (!draft.trim() && !attachments.length)}><ArrowUp size={18} /></button>}
      </div>
      {running && progress.stage !== "connection_lost" && <div className="run-progress" role="status"><span className="run-shimmer" /><span>{progress.label}</span></div>}
      {progress.stage === "connection_lost" && <div className="run-progress run-failed" role="status"><AlertTriangle size={14} /><span>{progress.label}</span><button type="button" className="text-button" disabled={disabled} onClick={onResumeResponse}><RotateCcw size={13} /> Resume response</button><button type="button" className="text-button" disabled={disabled} onClick={onStop}>Stop response</button></div>}
      {progress.stage === "failed" && <div className="run-progress run-failed" role="status"><AlertTriangle size={14} /><span>{progress.label}</span>{retryAvailable && <button type="button" className="text-button" disabled={disabled} onClick={onRetryResponse}><RotateCcw size={13} /> Retry response</button>}</div>}
    </form>
    <p className="composer-note" role={disabled ? "status" : undefined}>{disabled ? "Drafts stay in this browser while the local service is unavailable. Reconnect to send." : "History is stored locally. Only selected context and your current request are sent to the configured model."}</p>
  </div>;
}
