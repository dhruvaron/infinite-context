import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, BrainCircuit, Check, CircleDollarSign, Code2, Database, Download, ExternalLink, FileKey2, FolderOpen, Monitor, Moon, Plus, Settings2, ShieldCheck, Sun, Trash2, Upload } from "lucide-react";

import { ApiRequestError, continuumApi } from "../lib/api-client";
import type { AppSettings, AuthorizedWorkspace, BackupRecord, BudgetSummary, QualityPreset, RuntimeState, SecretFileApproval, ThemePreference } from "../lib/types";
import { Modal, Switch, formatBytes, formatRelativeTime } from "./Primitives";

type SettingsTab = "general" | "memory" | "models" | "data" | "developer";
const qualityOptions: Array<{ value: QualityPreset; label: string; detail: string; cost: string }> = [
  { value: "fast", label: "Fast", detail: "Everyday questions and drafting", cost: "$" },
  { value: "balanced", label: "Balanced", detail: "Recall, quality, and speed", cost: "$$" },
  { value: "deep", label: "Deep", detail: "Complex research and reasoning", cost: "$$$" }
];

export function SettingsDialog({ open, settings, runtime, budget, pinnedCount, onClose, onSave, onReset, onOpenMemory, onProviderChanged, onVaultReplaced }: {
  open: boolean;
  settings: AppSettings;
  runtime: RuntimeState;
  budget: BudgetSummary;
  pinnedCount: number;
  onClose: () => void;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
  onReset: () => void;
  onOpenMemory: () => void;
  onProviderChanged: () => Promise<void>;
  onVaultReplaced: () => Promise<void>;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "saving" | "saved" | "removing" | "removed" | "failed">("idle");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exportAttachments, setExportAttachments] = useState(true);
  const [exportTools, setExportTools] = useState(false);
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "downloaded" | "failed">("idle");
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [lintStatus, setLintStatus] = useState<"idle" | "running" | "queued" | "failed">("idle");
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [workspaces, setWorkspaces] = useState<AuthorizedWorkspace[]>([]);
  const [managementLoading, setManagementLoading] = useState(false);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [backupCreating, setBackupCreating] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceRevoking, setWorkspaceRevoking] = useState<string | null>(null);
  const [promptTraceAcknowledged, setPromptTraceAcknowledged] = useState(settings.promptTracingEnabled);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [verifiedImport, setVerifiedImport] = useState<{ token: string; expiresAt: string } | null>(null);
  const [importStatus, setImportStatus] = useState<"idle" | "verifying" | "verified" | "importing" | "retry" | "failed">("idle");
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const preview = runtime.mode === "demo";

  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setDraft(settings);
    setPromptTraceAcknowledged(settings.promptTracingEnabled);
    setSaveError(null);
    setImportFile(null);
    setVerifiedImport(null);
    setImportStatus("idle");
    setImportMessage(null);
  }, [open, settings]);

  useEffect(() => {
    if (!open || tab !== "data" || preview) return;
    let cancelled = false;
    setManagementLoading(true);
    setManagementError(null);
    void Promise.all([continuumApi.listBackups(), continuumApi.listWorkspaces()]).then(([nextBackups, nextWorkspaces]) => {
      if (!cancelled) { setBackups(nextBackups); setWorkspaces(nextWorkspaces); }
    }).catch((error: unknown) => {
      if (!cancelled) setManagementError(error instanceof Error ? error.message : "Vault management data could not be loaded.");
    }).finally(() => { if (!cancelled) setManagementLoading(false); });
    return () => { cancelled = true; };
  }, [open, preview, tab]);

  const tabs: Array<{ value: SettingsTab; label: string; icon: typeof Settings2 }> = [
    { value: "general", label: "General", icon: Settings2 },
    { value: "memory", label: "Memory", icon: BrainCircuit },
    { value: "models", label: "Models", icon: CircleDollarSign },
    { value: "data", label: "Data", icon: Database },
    { value: "developer", label: "Developer", icon: Code2 }
  ];

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try { await onSave(draft); onClose(); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Settings could not be saved."); }
    finally { setSaving(false); }
  };

  const saveApiKey = async () => {
    setKeyStatus("saving");
    try {
      await continuumApi.configureApiKey(apiKey.trim());
      setApiKey("");
      setKeyStatus("saved");
      await onProviderChanged();
    } catch { setKeyStatus("failed"); }
  };

  const removeApiKey = async () => {
    setKeyStatus("removing");
    try {
      await continuumApi.removeApiKey();
      setApiKey("");
      setKeyStatus("removed");
      onClose();
      await onProviderChanged();
    } catch { setKeyStatus("failed"); }
  };

  const runLint = async () => {
    if (preview) return;
    setLintStatus("running");
    try { await continuumApi.runMemoryLint(); setLintStatus("queued"); }
    catch { setLintStatus("failed"); }
  };

  const createBackup = async () => {
    setBackupCreating(true);
    setManagementError(null);
    try { await continuumApi.createBackup(); setBackups(await continuumApi.listBackups()); }
    catch (error) { setManagementError(error instanceof Error ? error.message : "Backup could not be created."); }
    finally { setBackupCreating(false); }
  };

  const exportVault = async () => {
    setExportStatus("exporting");
    setExportMessage(null);
    try {
      const result = await continuumApi.exportVault({ attachments: exportAttachments, toolOutputs: exportTools });
      setExportStatus("downloaded");
      setExportMessage(`${result.filename} is ready (${formatBytes(result.size)}).`);
    } catch (error) {
      setExportStatus("failed");
      setExportMessage(error instanceof Error ? error.message : "The vault could not be exported.");
    }
  };

  const authorizeWorkspace = async () => {
    const path = workspacePath.trim();
    if (!path) return;
    setWorkspaceSaving(true);
    setManagementError(null);
    try {
      await continuumApi.authorizeWorkspace(path, workspaceName.trim() || path.split("/").filter(Boolean).at(-1) || "Workspace");
      setWorkspaces(await continuumApi.listWorkspaces());
      setWorkspacePath("");
      setWorkspaceName("");
    } catch (error) { setManagementError(error instanceof Error ? error.message : "Workspace could not be authorized."); }
    finally { setWorkspaceSaving(false); }
  };

  const revokeWorkspace = async (workspace: AuthorizedWorkspace) => {
    setWorkspaceRevoking(workspace.id);
    setManagementError(null);
    try {
      const result = await continuumApi.revokeWorkspace(workspace.id);
      if (!result.revoked) throw new Error("That workspace was already revoked.");
      setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    } catch (error) { setManagementError(error instanceof Error ? error.message : "Workspace access could not be revoked."); }
    finally { setWorkspaceRevoking(null); }
  };

  const verifyImport = async (file: File) => {
    setImportFile(file);
    setImportStatus("verifying");
    setImportMessage(null);
    try {
      const result = await continuumApi.verifyVaultImport(file);
      if (!result.valid) throw new Error("The bundle did not pass verification.");
      setVerifiedImport({ token: result.verificationToken, expiresAt: result.expiresAt });
      const eventCount = result.manifest?.counts?.events;
      setImportMessage(`Checksums and schema are valid${typeof eventCount === "number" ? ` · ${eventCount.toLocaleString()} events` : ""}. The verified local copy can be committed without uploading it again.`);
      setImportStatus("verified");
    } catch (error) { setVerifiedImport(null); setImportMessage(error instanceof Error ? error.message : "The import could not be verified."); setImportStatus("failed"); }
  };

  const importVerifiedVault = async (mode: "fresh" | "replace") => {
    if (!verifiedImport || (importStatus !== "verified" && importStatus !== "retry")) return;
    setImportStatus("importing");
    try {
      await continuumApi.commitVerifiedVaultImport(verifiedImport.token, mode);
      await onVaultReplaced();
      setImportFile(null);
      setVerifiedImport(null);
      setImportMessage(mode === "fresh" ? "Transcript imported and durable memory queued for a fresh rebuild. A safety backup was created first." : "Vault replaced exactly. A safety backup was created first.");
      setImportStatus("idle");
    } catch (error) {
      const retryableToken = error instanceof ApiRequestError && (error.retryable || ["MAINTENANCE_BUSY", "MAINTENANCE_LOCKED", "VERIFIED_IMPORT_IN_USE", "INSUFFICIENT_IMPORT_STORAGE", "VAULT_IMPORT_IO_RETRYABLE"].includes(error.code));
      if (!retryableToken) setVerifiedImport(null);
      setImportMessage(`${error instanceof Error ? error.message : "The vault could not be imported."} ${retryableToken ? `The verified local copy remains available until ${formatRelativeTime(verifiedImport.expiresAt)}; retry when maintenance finishes.` : "Verify the selected file again before retrying."}`);
      setImportStatus(retryableToken ? "retry" : "failed");
    }
  };

  const modalBusy = saving || keyStatus === "saving" || keyStatus === "removing" || importStatus === "importing" || backupCreating || workspaceSaving || workspaceRevoking !== null;

  return <Modal open={open} title="Settings" description="Local preferences, model access, memory controls, and vault management." width="large" dismissible={!modalBusy} onClose={onClose} footer={<><span className="modal-footer-status" role="status">{saveError}</span><button type="button" className="secondary-button" disabled={modalBusy} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={modalBusy} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button></>}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings categories">{tabs.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}><Icon size={16} />{label}</button>)}</nav>
      <div className="settings-content">
        {tab === "general" && <SettingsSection title="Appearance" description="Continuum follows your system theme unless you choose otherwise.">
          <div className="theme-grid">{(["light", "dark", "system"] as ThemePreference[]).map((theme) => <button type="button" className={draft.theme === theme ? "selected" : ""} key={theme} onClick={() => setDraft((value) => ({ ...value, theme }))}>{theme === "light" ? <Sun size={18} /> : theme === "dark" ? <Moon size={18} /> : <Monitor size={18} />}<span>{theme}</span>{draft.theme === theme && <Check size={14} />}</button>)}</div>
          <label className="settings-field">Assistant instructions<textarea rows={5} value={draft.systemInstructions} onChange={(event) => setDraft((value) => ({ ...value, systemInstructions: event.target.value }))} /><small>Applied to response generation. Project-scoped instructions arrive with coding-agent scopes.</small></label>
          <Switch checked={draft.showSourceChips} onChange={(checked) => setDraft((value) => ({ ...value, showSourceChips: checked }))} label="Show source chips on answers" description="Older-memory claims link back to exact evidence." />
        </SettingsSection>}

        {tab === "memory" && <>
          <SettingsSection title="Long-term memory" description="Pausing extraction never stops the raw transcript from being stored.">
            <Switch checked={!draft.memoryPaused} onChange={(checked) => setDraft((value) => ({ ...value, memoryPaused: !checked }))} label="Compile long-term memory" description="Extract durable facts, decisions, preferences, and relationships after each turn." />
            <div className="memory-policy-card"><ShieldCheck size={18} /><span><strong>Conservative promotion</strong><small>Continuum prefers missing a minor detail over polluting durable memory. Saying “remember this” overrides the threshold.</small></span></div>
            <button type="button" className="wide-action" disabled={preview || lintStatus === "running"} onClick={() => void runLint()}><BrainCircuit size={16} /><span><strong>{lintStatus === "running" ? "Starting lint…" : lintStatus === "queued" ? "Memory lint queued" : "Run deep memory lint"}</strong><small>{lintStatus === "failed" ? "Could not start; try again." : "Find stale claims, conflicts, broken links, and duplicates."}</small></span></button>
          </SettingsSection>
          <SettingsSection title="Pinned context" description="Pinned items are always considered, but still respect the context budget."><div className="settings-info-row"><span>{pinnedCount} pinned {pinnedCount === 1 ? "memory" : "memories"}</span><button type="button" className="text-button" onClick={onOpenMemory}>Manage in inspector</button></div></SettingsSection>
        </>}

        {tab === "models" && <>
          <SettingsSection title="Response quality" description="Choose the default balance of speed, reasoning, and API cost."><div className="quality-settings">{qualityOptions.map((preset) => <button type="button" className={draft.quality === preset.value ? "selected" : ""} key={preset.value} onClick={() => setDraft((value) => ({ ...value, quality: preset.value }))}><span><strong>{preset.label}</strong><small>{preset.detail}</small></span><em>{preset.cost}</em>{draft.quality === preset.value && <Check size={14} />}</button>)}</div></SettingsSection>
          <SettingsSection title="OpenAI connection" description="The key is stored in macOS Keychain and never returned to the browser.">
            <div className="key-settings-row"><input aria-label="OpenAI API key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setKeyStatus("idle"); }} placeholder="Replace API key…" autoComplete="off" /><button type="button" className="secondary-button" disabled={preview || apiKey.trim().length < 20 || keyStatus === "saving" || keyStatus === "removing"} onClick={() => void saveApiKey()}>{keyStatus === "saving" ? "Saving…" : "Save to Keychain"}</button>{runtime.providerReachable && <button type="button" className="danger-button" disabled={preview || keyStatus === "saving" || keyStatus === "removing"} onClick={() => void removeApiKey()}>{keyStatus === "removing" ? "Removing…" : "Remove saved key"}</button>}</div>
            {keyStatus === "saved" && <p className="success-copy" role="status"><Check size={14} /> Key updated securely.</p>}{keyStatus === "removed" && <p className="success-copy" role="status"><Check size={14} /> Key removed from Keychain. Local browsing remains available.</p>}{keyStatus === "failed" && <p className="error-copy" role="alert"><AlertTriangle size={14} /> Keychain access could not be updated.</p>}
            <div className="budget-settings"><div><span>Development and evaluation budget</span><strong>${budget.allocatedUsd.toFixed(2)} allocated <small>/ ${budget.capUsd.toFixed(0)}</small></strong></div><div className="budget-meter"><span style={{ width: `${Math.min(100, budget.capUsd ? budget.allocatedUsd / budget.capUsd * 100 : 100)}%` }} /></div><p>${budget.totalUsd.toFixed(2)} spent · ${budget.reservedUsd.toFixed(2)} reserved across {budget.activeReservations} active {budget.activeReservations === 1 ? "call" : "calls"} · ${budget.availableUsd.toFixed(2)} available.</p><p>Warnings at $20, $50, $75, and $90. Nonessential runs stop at $95; all calls stop at $100.</p></div>
            <div className="budget-lifetime-notice"><ShieldCheck size={16} /><span><strong>One non-renewable $100 lifetime cap</strong><small>Application chat and evaluation share this installation-wide total. Vault deletion, replacement, import, or reinstalling a source checkout cannot reset earlier recorded spend.</small></span></div>
          </SettingsSection>
        </>}

        {tab === "data" && <>
          {preview && <div className="settings-notice"><ShieldCheck size={16} /><span>Vault management is disabled in the temporary preview. Leave preview to manage your personal data.</span></div>}
          <SettingsSection title="Portable vault" description="Exports are versioned, checksummed, and contain no API key or embeddings.">
            <div className="export-options"><label><input type="checkbox" checked={exportAttachments} onChange={(event) => setExportAttachments(event.target.checked)} /> Include original attachments</label><label><input type="checkbox" checked={exportTools} onChange={(event) => setExportTools(event.target.checked)} /> Include sensitive tool output</label></div>
            <div className="action-grid"><button type="button" disabled={preview || exportStatus === "exporting"} onClick={() => void exportVault()}><Download size={17} /><span><strong>{exportStatus === "exporting" ? "Preparing export…" : "Export vault"}</strong><small>ZIP with JSONL, JSON, Markdown, and checksums</small></span></button><button type="button" disabled={preview || importStatus === "verifying" || importStatus === "importing"} onClick={() => importInput.current?.click()}><Upload size={17} /><span><strong>{importStatus === "verifying" ? "Verifying…" : importStatus === "importing" ? "Importing…" : "Import vault"}</strong><small>Verify before changing any local data</small></span></button></div>
            <input ref={importInput} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void verifyImport(file); event.target.value = ""; }} />
            {exportMessage && <div className={`import-status status-${exportStatus}`} role="status"><span>{exportMessage}</span></div>}
            {importMessage && <div className={`import-status status-${importStatus}`} role="status"><span>{importMessage}</span>{(importStatus === "verified" || importStatus === "retry") && <div className="import-actions"><button type="button" className="secondary-button" onClick={() => void importVerifiedVault("fresh")}>Import transcript, rebuild memory</button><button type="button" className="danger-button" onClick={() => void importVerifiedVault("replace")}>{importStatus === "retry" ? "Retry exact replacement" : "Replace with exact vault"}</button></div>}</div>}
          </SettingsSection>
          <SettingsSection title="Backups" description="Seven daily and four weekly local snapshots are managed automatically.">
            <div className="settings-info-row"><span><Archive size={15} />{managementLoading ? "Loading backups…" : backups[0] ? `Last backup ${formatRelativeTime(backups[0].createdAt)}` : "No managed backup yet"}</span><button type="button" className="text-button" disabled={preview || backupCreating} onClick={() => void createBackup()}>{backupCreating ? "Creating…" : "Create backup now"}</button></div>
            {backups.length > 0 && <div className="management-list">{backups.slice(0, 4).map((backup) => <span key={backup.id}><strong>{backup.kind}</strong><small>{formatBytes(backup.size)} · {formatRelativeTime(backup.createdAt)}</small></span>)}</div>}
          </SettingsSection>
          <SettingsSection title="Authorized workspaces" description="V1 reads only local roots you explicitly authorize and never writes to them.">
            <div className="workspace-form"><label>Absolute folder path<input value={workspacePath} disabled={preview} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/Users/you/Projects/example" /></label><label>Display name <small>(optional)</small><input value={workspaceName} disabled={preview} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Example project" /></label><button type="button" className="secondary-button" disabled={preview || !workspacePath.trim() || workspaceSaving} onClick={() => void authorizeWorkspace()}><Plus size={14} />{workspaceSaving ? "Authorizing…" : "Authorize read-only"}</button></div>
            {workspaces.length > 0 && <div className="management-list workspace-management-list">{workspaces.map((workspace) => <div className="workspace-management-card" key={workspace.id}><div className="management-row"><span><strong><FolderOpen size={13} />{workspace.displayName}</strong><small>{workspace.path} · read-only · likely-secret files denied by default</small></span><button type="button" className="icon-button" aria-label={`Revoke access to ${workspace.displayName}`} disabled={workspaceRevoking === workspace.id} onClick={() => void revokeWorkspace(workspace)}>{workspaceRevoking === workspace.id ? <span className="loading-ring" /> : <Trash2 size={14} />}</button></div><WorkspaceSecretApprovalForm workspace={workspace} disabled={preview} /></div>)}</div>}
            {managementError && <p className="error-copy"><AlertTriangle size={14} /> {managementError}</p>}
          </SettingsSection>
          <div className="danger-zone"><div><AlertTriangle size={18} /><span><strong>Destroy this vault</strong><small>Permanently delete the timeline, wiki, graph, attachments, and managed backups.</small></span></div><button type="button" className="danger-button" onClick={onReset}>{preview ? "Clear preview…" : "Start over…"}</button></div>
        </>}

        {tab === "developer" && <>
          <SettingsSection title="Technical controls" description="Changes here affect reproducibility and benchmark comparability.">
            <Switch checked={draft.developerOverrides} onChange={(checked) => setDraft((value) => ({ ...value, developerOverrides: checked }))} label="Enable model overrides" description="Unlock raw response, extraction, and embedding model IDs." />
            <div className={draft.developerOverrides ? "advanced-model-grid" : "advanced-model-grid disabled"}>{(["fast", "balanced", "deep"] as QualityPreset[]).map((preset) => <label key={preset}><span>{preset} model</span><input disabled={!draft.developerOverrides} value={draft.responseModelIds[preset]} onChange={(event) => setDraft((value) => ({ ...value, responseModelIds: { ...value.responseModelIds, [preset]: event.target.value } }))} /></label>)}<label><span>Extraction model</span><input disabled={!draft.developerOverrides} value={draft.extractionModelId} onChange={(event) => setDraft((value) => ({ ...value, extractionModelId: event.target.value }))} /></label><label><span>Embedding model</span><input disabled={!draft.developerOverrides} value={draft.embeddingModelId} onChange={(event) => setDraft((value) => ({ ...value, embeddingModelId: event.target.value }))} /></label></div>
          </SettingsSection>
          <SettingsSection title="Prompt tracing" description="A separate, sensitive local diagnostic. It is off by default and never required for model overrides.">
            <div className="sensitive-setting-warning"><AlertTriangle size={17} /><span><strong>Raw-content logging</strong><small>When enabled, raw prompts, messages, and ordinary tool output are logged locally for up to 7 days. Recognized credential patterns and explicitly approved secret-file output are withheld, but unrecognized secrets in other raw text may still be recorded. Trace logs never leave this machine unless you explicitly export them.</small></span></div>
            <label className="sensitive-acknowledgement"><input type="checkbox" checked={promptTraceAcknowledged} onChange={(event) => { const acknowledged = event.target.checked; setPromptTraceAcknowledged(acknowledged); if (!acknowledged) setDraft((value) => ({ ...value, promptTracingEnabled: false })); }} /> I understand raw conversation and tool content will be retained in local diagnostic logs for up to 7 days.</label>
            <Switch checked={draft.promptTracingEnabled} disabled={!promptTraceAcknowledged && !draft.promptTracingEnabled} onChange={(checked) => setDraft((value) => ({ ...value, promptTracingEnabled: checked }))} label="Enable raw prompt tracing" description={draft.promptTracingEnabled ? "Enabled. Approved secret-file output is withheld; other raw text may contain unrecognized secrets." : "Disabled. Ordinary logs contain metadata and redacted content only."} />
          </SettingsSection>
          <SettingsSection title="Local diagnostics" description="No trace leaves your machine."><div className="diagnostic-grid"><span><strong>{runtime.version ?? "0.1.0"}</strong><small>App version</small></span><span><strong>{runtime.vectorSearch === "fallback" ? `fallback · ${(runtime.vectorFallbackLimit ?? 5_000).toLocaleString()} max` : runtime.vectorSearch}</strong><small>Vector index</small></span><span><strong>{runtime.memoryQueue}</strong><small>Worker</small></span></div>{runtime.vectorSearch === "fallback" && <p className="settings-note">Degraded mode searches only the newest {(runtime.vectorFallbackLimit ?? 5_000).toLocaleString()} vectors for each embedding size. Text and graph search remain available.</p>}<a className="docs-link" href="/docs/architecture.html" target="_blank" rel="noreferrer"><FileKey2 size={15} /> Open architecture documentation <ExternalLink size={13} /></a></SettingsSection>
        </>}
      </div>
    </div>
  </Modal>;
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="settings-section"><div className="settings-section-heading"><h3>{title}</h3><p>{description}</p></div>{children}</section>;
}

function WorkspaceSecretApprovalForm({ workspace, disabled }: { workspace: AuthorizedWorkspace; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [relativePath, setRelativePath] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [approval, setApproval] = useState<SecretFileApproval | null>(null);
  const [status, setStatus] = useState<"idle" | "granting" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const path = relativePath.trim();
  const unsafePath = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]+/).some((segment) => segment === "..");
  const grant = async () => {
    if (!path || unsafePath || !acknowledged) return;
    setStatus("granting");
    setError(null);
    try {
      const next = await continuumApi.approveWorkspaceSecretFile(workspace.id, path);
      setApproval(next);
      setRelativePath("");
      setAcknowledged(false);
      setStatus("idle");
    } catch (caught) {
      setStatus("failed");
      setError(caught instanceof Error ? caught.message : "The one-use approval could not be created.");
    }
  };
  return <div className="secret-approval">
    <button type="button" className="secret-approval-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><FileKey2 size={14} /><span><strong>One-use secret-file approval</strong><small>{approval?.status === "ready" ? `${approval.relativePath} · one read available ${formatRelativeTime(approval.expiresAt)}` : "No secret file is approved"}</small></span></button>
    {open && <div className="secret-approval-form">
      <div className="sensitive-setting-warning compact"><AlertTriangle size={15} /><span><strong>This can expose a secret to the model</strong><small>Approval is scoped to one exact relative path, expires shortly, and is consumed by one read. It does not allow directory-wide secret access.</small></span></div>
      <label>Relative file path<input aria-label={`Secret file path for ${workspace.displayName}`} value={relativePath} disabled={disabled || status === "granting"} onChange={(event) => { setRelativePath(event.target.value); setApproval(null); setError(null); }} placeholder="config/private.env" autoComplete="off" spellCheck={false} /></label>
      {unsafePath && <p className="error-copy" role="alert">Use a relative path inside this workspace; absolute paths and “..” are not allowed.</p>}
      <label className="sensitive-acknowledgement"><input type="checkbox" checked={acknowledged} disabled={disabled || status === "granting"} onChange={(event) => setAcknowledged(event.target.checked)} /> I approve one model-visible read of this exact file and understand it may contain credentials or private data.</label>
      <div className="secret-approval-actions"><span role="status">{approval?.status === "ready" ? `Ready for one read · expires ${formatRelativeTime(approval.expiresAt)}` : error}</span><button type="button" className="secondary-button" disabled={disabled || !path || unsafePath || !acknowledged || status === "granting"} onClick={() => void grant()}>{status === "granting" ? "Approving…" : "Allow one read"}</button></div>
    </div>}
  </div>;
}
