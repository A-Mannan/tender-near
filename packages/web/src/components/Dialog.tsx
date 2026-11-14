import { useEffect, useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";

export function Dialog({
  open,
  title,
  eyebrow,
  onClose,
  children,
  width = "760px",
}: {
  open: boolean;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = originalOverflow;
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={panelRef}
        role="dialog"
        data-testid="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="dialog-panel"
        style={{ width }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-5 py-4">
          <div className="min-w-0">
            {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
            <h2 className="mt-0.5 truncate text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  help,
  error,
  children,
  htmlFor,
}: {
  label: string;
  help?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : help ? (
        <p className="field-help">{help}</p>
      ) : null}
    </div>
  );
}

export function TxLink({ hash, network }: { hash: string; network: string }) {
  const host = network === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";
  return (
    <a
      className="btn btn-sm btn-secondary"
      href={`https://${host}/txns/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      View transaction
    </a>
  );
}
