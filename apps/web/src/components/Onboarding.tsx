import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, BrainCircuit, Check, ChevronRight, Eye, EyeOff, FileKey2, GitBranch, HardDrive, KeyRound, Laptop, LockKeyhole, SearchCheck, ShieldCheck, Sparkles } from "lucide-react";

import { continuumApi } from "../lib/api-client";
import { Modal } from "./Primitives";

export function Onboarding({ open, onComplete }: { open: boolean; onComplete: (useDemo: boolean) => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [useDemo, setUseDemo] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const steps = ["Welcome", "Connect", "Privacy", "Provenance"];

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setApiKey("");
    setShowKey(false);
    setSavingKey(false);
    setKeyConfigured(false);
    setUseDemo(false);
    setCompleting(false);
    setSetupError(null);
  }, [open]);

  const next = async () => {
    setSetupError(null);
    try {
      if (step === 1 && apiKey.trim() && !keyConfigured) {
        setSavingKey(true);
        try { await continuumApi.configureApiKey(apiKey.trim()); setKeyConfigured(true); setApiKey(""); }
        finally { setSavingKey(false); }
      }
      if (step < steps.length - 1) setStep((value) => value + 1);
      else { setCompleting(true); try { await onComplete(useDemo); } finally { setCompleting(false); } }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Setup could not continue.");
    }
  };

  return <Modal open={open} title={steps[step]!} width="large" dismissible={false} onClose={() => undefined} footer={<div className="onboarding-footer"><button type="button" className="secondary-button" disabled={step === 0 || savingKey} onClick={() => setStep((value) => value - 1)}><ArrowLeft size={15} /> Back</button><span className="step-dots" aria-label={`Step ${step + 1} of ${steps.length}`}>{steps.map((label, index) => <i key={label} className={index === step ? "active" : index < step ? "complete" : ""} />)}</span><button type="button" className="primary-button" disabled={savingKey || completing} onClick={() => void next()}>{savingKey ? "Saving securely…" : completing ? "Preparing…" : step === steps.length - 1 ? "Enter Continuum" : "Continue"}<ArrowRight size={15} /></button></div>}>
    {step === 0 && <div className="onboarding-screen welcome-screen"><div className="welcome-graphic" aria-hidden="true"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="welcome-mark"><BrainCircuit size={30} /></span><i className="node n1" /><i className="node n2" /><i className="node n3" /></div><span className="onboarding-kicker">One conversation, without the handoffs</span><h3>Your history stays addressable.</h3><p>Continuum stores every retained turn verbatim, compiles source-linked memory, and retrieves only the evidence a finite-context model needs for each answer.</p><div className="welcome-points"><span><HardDrive size={16} /><strong>Local by default</strong><small>Your durable vault lives on this Mac.</small></span><span><SearchCheck size={16} /><strong>Exact history</strong><small>Summaries never replace original messages.</small></span><span><GitBranch size={16} /><strong>Inspectable memory</strong><small>Every claim can lead back to evidence.</small></span></div><div className="honesty-banner"><Sparkles size={16} /><p><strong>What “infinite context” means here</strong>The model does not read your entire history on every turn. Continuum pages relevant local evidence into its finite context window.</p></div></div>}
    {step === 1 && <div className="onboarding-screen connect-screen"><div className="setup-icon"><KeyRound size={25} /></div><h3>Connect OpenAI</h3><p>Continuum uses OpenAI for responses, memory extraction, and embeddings. Your key is stored in macOS Keychain and is never returned to this browser.</p><label className="api-key-field"><span>OpenAI API key</span><div><input type={showKey ? "text" : "password"} autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setKeyConfigured(false); setSetupError(null); }} placeholder={keyConfigured ? "Configured securely" : "sk-…"} /><button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>{keyConfigured && <div className="key-success"><Check size={15} /> API key saved to Keychain</div>}{setupError && <div className="setup-error" role="alert">{setupError}</div>}<div className="key-facts"><span><LockKeyhole size={16} /><p><strong>Keychain only</strong>No key in SQLite, logs, exports, or browser storage.</p></span><span><FileKey2 size={16} /><p><strong>$100 hard cap</strong>Continuum records model usage and blocks calls at the project cap.</p></span></div><button type="button" className="text-button skip-key" onClick={() => { setApiKey(""); setSetupError(null); setStep(2); }}>Set this up later</button></div>}
    {step === 2 && <div className="onboarding-screen privacy-screen"><div className="setup-icon"><ShieldCheck size={25} /></div><h3>Know where your data goes</h3><p>The vault is local, but selected content must leave your machine when you ask a cloud model to answer.</p><div className="data-boundary"><div className="boundary-side local-side"><span><Laptop size={20} /> This Mac</span><ul><li><Check size={13} /> Full transcript</li><li><Check size={13} /> Wiki and graph</li><li><Check size={13} /> Attachments</li><li><Check size={13} /> Search indexes</li></ul></div><div className="boundary-arrow"><ChevronRight size={21} /><small>selected per turn</small></div><div className="boundary-side provider-side"><span><Sparkles size={20} /> OpenAI</span><ul><li><Check size={13} /> Current request</li><li><Check size={13} /> Recent turns</li><li><Check size={13} /> Retrieved evidence</li><li><Check size={13} /> Tool instructions</li></ul></div></div><div className="privacy-list"><span><Check size={15} /><p><strong>Provider storage disabled</strong>Requests use <code>store: false</code>.</p></span><span><Check size={15} /><p><strong>No Continuum telemetry</strong>No analytics, crash reports, or remote product logs.</p></span><span><Check size={15} /><p><strong>You can inspect the packet</strong>The debug drawer shows exactly which sources were selected.</p></span></div></div>}
    {step === 3 && <div className="onboarding-screen provenance-screen"><div className="setup-icon"><GitBranch size={25} /></div><h3>Memory you can inspect and correct</h3><p>A remembered statement is useful only when you can see why Continuum believes it.</p><div className="provenance-demo"><div className="demo-answer"><Sparkles size={15} /><p>“Raw messages remain the source of truth.”</p></div><div className="provenance-link"><span /><small>compiled from</small></div><div className="demo-source"><FileKey2 size={15} /><span><strong>Original architecture decision</strong><small>You · exact transcript · two weeks ago</small></span></div></div><label className="demo-vault-option"><input type="checkbox" checked={useDemo} onChange={(event) => setUseDemo(event.target.checked)} /><span><strong>Open a temporary demo preview</strong><small>Explore a realistic graph and debug trace without API credit. The preview is immutable at the API boundary, and leaving it returns to your unchanged personal vault.</small></span></label>{setupError && <div className="setup-error" role="alert">{setupError}</div>}<p className="onboarding-fineprint">You can edit or delete compiled memory, trace claims to their sources, and permanently remove the vault from Settings.</p></div>}
  </Modal>;
}
