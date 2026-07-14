import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Info, X } from "lucide-react";

export function IconButton({ label, className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function StatusDot({ status }: { status: "ready" | "working" | "warning" | "failed" | "paused" }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state">{icon}<h3>{title}</h3><p>{description}</p>{action}</div>;
}

export type ToastItem = { id: string; tone: "success" | "info" | "warning" | "danger"; title: string; message?: string };

export function ToastRegion({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  const icons = { success: <Check size={16} />, info: <Info size={16} />, warning: <AlertTriangle size={16} />, danger: <AlertTriangle size={16} /> };
  return <div className="toast-region" aria-live="polite" aria-label="Notifications">
    {items.map((item) => <div className={`toast toast-${item.tone}`} key={item.id} role="status">
      <div className="toast-icon">{icons[item.tone]}</div>
      <div><strong>{item.title}</strong>{item.message && <p>{item.message}</p>}</div>
      <IconButton label="Dismiss notification" className="toast-close" onClick={() => onDismiss(item.id)}><X size={15} /></IconButton>
    </div>)}
  </div>;
}

const modalStack: HTMLElement[] = [];
const backgroundState = new Map<Element, { inert: boolean; ariaHidden: string | null }>();

function synchronizeModalIsolation(): void {
  const top = modalStack.at(-1) ?? null;
  if (!top) {
    for (const [element, state] of backgroundState) {
      (element as HTMLElement).inert = state.inert;
      if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", state.ariaHidden);
    }
    backgroundState.clear();
    document.body.classList.remove("modal-open");
    return;
  }
  document.body.classList.add("modal-open");
  for (const element of Array.from(document.body.children)) {
    if (!backgroundState.has(element)) backgroundState.set(element, { inert: (element as HTMLElement).inert, ariaHidden: element.getAttribute("aria-hidden") });
    const active = element === top;
    (element as HTMLElement).inert = !active;
    if (active) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", "true");
  }
}

export function Modal({ open, title, description, width = "medium", onClose, children, footer, dismissible = true }: {
  open: boolean;
  title: string;
  description?: string;
  width?: "small" | "medium" | "large" | "wide";
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [portalElement, setPortalElement] = useState<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const portal = document.createElement("div");
    portal.dataset.continuumModalRoot = "true";
    document.body.append(portal);
    setPortalElement(portal);
    modalStack.push(portal);
    synchronizeModalIsolation();
    const previous = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== portal) return;
      if (event.key === "Escape" && dismissible) { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(focusTimer);
      const index = modalStack.lastIndexOf(portal);
      if (index >= 0) modalStack.splice(index, 1);
      portal.remove();
      setPortalElement(null);
      synchronizeModalIsolation();
      if (modalStack.length > 0) {
        window.setTimeout(() => modalStack.at(-1)?.querySelector<HTMLElement>('[role="dialog"]')?.focus(), 0);
      } else if (previous?.isConnected) previous.focus();
    };
  }, [dismissible, open]);
  if (!open || !portalElement) return null;
  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} className={`modal-panel modal-${width}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
      <header className="modal-header">
        <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
        {dismissible && <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>}
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </div>
  </div>, portalElement);
}

export function SegmentedControl<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return <div className="segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => <button type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? "active" : ""} key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

export function Switch({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return <label className={`switch-row ${disabled ? "disabled" : ""}`}>
    <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={`switch ${checked ? "checked" : ""}`} onClick={() => onChange(!checked)}><span /></button>
  </label>;
}

export function formatRelativeTime(timestamp: string | null | undefined) {
  if (!timestamp) return "";
  const delta = new Date(timestamp).getTime() - Date.now();
  const abs = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return formatter.format(Math.round(delta / 60_000), "minute");
  if (abs < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
  if (abs < 2_592_000_000) return formatter.format(Math.round(delta / 86_400_000), "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp));
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB"][unit]}`;
}
