import { useState } from "react";
import { BrainCircuit, ChevronDown, Command, GitBranch, Search, Settings2, Sparkles, X } from "lucide-react";

import type { QualityPreset, RuntimeState } from "../lib/types";
import { IconButton, StatusDot, formatRelativeTime } from "./Primitives";

const PRESET_DETAILS: Record<QualityPreset, { label: string; detail: string; cost: string }> = {
  fast: { label: "Fast", detail: "Quick everyday answers", cost: "Lowest cost" },
  balanced: { label: "Balanced", detail: "Best default for recall", cost: "Moderate cost" },
  deep: { label: "Deep", detail: "Hard research and reasoning", cost: "Highest cost" }
};

export function TopBar({ runtime, quality, memoryPaused, mutationsDisabled = false, vaultReadsDisabled = false, drawer, onQuality, onSearch, onDrawer, onSettings, onToggleMemory }: {
  runtime: RuntimeState;
  quality: QualityPreset;
  memoryPaused: boolean;
  mutationsDisabled?: boolean;
  vaultReadsDisabled?: boolean;
  drawer: "memory" | "graph" | null;
  onQuality: (quality: QualityPreset) => void;
  onSearch: () => void;
  onDrawer: (drawer: "memory" | "graph" | null) => void;
  onSettings: () => void;
  onToggleMemory: () => void;
}) {
  const [qualityOpen, setQualityOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const status = runtime.mode === "connected" ? (runtime.memoryQueue === "working" ? "working" : "ready") : runtime.mode === "degraded" ? "warning" : runtime.mode === "offline" ? "failed" : "warning";

  return <header className="topbar">
    <div className="brand-group">
      <div className="brand-mark" aria-hidden="true"><span /><span /></div>
      <span className="brand-name">Continuum</span>
      <div className="popover-anchor">
        <button type="button" className="local-pill" onClick={() => setStatusOpen((value) => !value)} aria-expanded={statusOpen} aria-haspopup="dialog">
          <StatusDot status={status} /> {runtime.mode === "demo" ? "Preview" : runtime.mode === "offline" ? "Offline" : "Local"}
        </button>
        {statusOpen && <div className="status-popover popover-panel" role="dialog" aria-label="System status">
          <div className="popover-title"><strong>System status</strong><IconButton label="Close status" onClick={() => setStatusOpen(false)}><X size={15} /></IconButton></div>
          <StatusLine label="Local service" status={runtime.apiReachable ? "ready" : "failed"} detail={runtime.apiReachable ? "Connected on loopback" : "Unavailable"} />
          <StatusLine label="OpenAI" status={runtime.providerReachable ? "ready" : runtime.mode === "demo" ? "warning" : "failed"} detail={runtime.providerReachable ? "Available" : "Local browsing still works"} />
          <StatusLine label="Memory index" status={runtime.vectorSearch === "ready" ? "ready" : "warning"} detail={runtime.vectorSearch === "ready" ? "Vector + text ready" : "Text-search fallback"} />
          <StatusLine label="Memory worker" status={runtime.memoryQueue === "paused" ? "paused" : runtime.memoryQueue === "failed" ? "failed" : runtime.memoryQueue === "working" ? "working" : "ready"} detail={runtime.memoryQueue === "working" ? "Compiling this turn" : runtime.memoryQueue === "paused" ? "Extraction paused" : `Updated ${formatRelativeTime(runtime.lastMemoryUpdate)}`} />
          {runtime.message && <p className="status-note">{runtime.message}</p>}
          <button type="button" className="text-button" disabled={mutationsDisabled} onClick={onToggleMemory}>{memoryPaused ? "Resume memory" : "Pause memory extraction"}</button>
        </div>}
      </div>
    </div>
    <nav className="top-actions" aria-label="Application controls">
      <button type="button" className="search-button" aria-label="Search memory" disabled={vaultReadsDisabled} onClick={onSearch}><Search size={16} /><span>Search memory</span><kbd><Command size={12} aria-hidden="true" />K</kbd></button>
      <div className="popover-anchor">
        <button type="button" className="mode-button" disabled={mutationsDisabled} onClick={() => setQualityOpen((open) => !open)} aria-expanded={qualityOpen} aria-haspopup="listbox"><Sparkles size={15} /> <span>{PRESET_DETAILS[quality].label}</span><ChevronDown size={13} /></button>
        {qualityOpen && <div className="quality-popover popover-panel" role="listbox" aria-label="Response quality">
          <p className="popover-eyebrow">Response quality</p>
          {(Object.keys(PRESET_DETAILS) as QualityPreset[]).map((preset) => <button type="button" role="option" disabled={mutationsDisabled} aria-selected={quality === preset} className={quality === preset ? "selected" : ""} key={preset} onClick={() => { onQuality(preset); setQualityOpen(false); }}>
            <span><strong>{PRESET_DETAILS[preset].label}</strong><small>{PRESET_DETAILS[preset].detail}</small></span><em>{PRESET_DETAILS[preset].cost}</em>
          </button>)}
        </div>}
      </div>
      <IconButton label={drawer === "graph" ? "Close knowledge graph" : "Open knowledge graph"} className={drawer === "graph" ? "active" : ""} disabled={vaultReadsDisabled} onClick={() => onDrawer(drawer === "graph" ? null : "graph")}><GitBranch size={18} /></IconButton>
      <IconButton label={drawer === "memory" ? "Close memory inspector" : "Open memory inspector"} className={drawer === "memory" ? "active" : ""} onClick={() => onDrawer(drawer === "memory" ? null : "memory")}><BrainCircuit size={18} /></IconButton>
      <IconButton label="Open settings" onClick={onSettings}><Settings2 size={18} /></IconButton>
    </nav>
  </header>;
}

function StatusLine({ label, status, detail }: { label: string; status: "ready" | "working" | "warning" | "failed" | "paused"; detail: string }) {
  return <div className="status-line"><StatusDot status={status} /><span><strong>{label}</strong><small>{detail}</small></span></div>;
}
