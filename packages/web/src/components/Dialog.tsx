import { useEffect, useRef, type ReactNode } from "react";
import { ArrowSquareOut, X } from "@phosphor-icons/react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DIALOG_STACK: symbol[] = [];

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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialogId = Symbol("dialog");
    DIALOG_STACK.push(dialogId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (DIALOG_STACK[DIALOG_STACK.length - 1] !== dialogId) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab" && panelRef.current) {
        const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const stackIndex = DIALOG_STACK.indexOf(dialogId);
      if (stackIndex >= 0) DIALOG_STACK.splice(stackIndex, 1);
      document.body.style.overflow = originalOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        data-testid="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="dialog-panel scroll-thin"
        style={{ width: "100%", maxWidth: width }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-5 py-3.5">
          <div className="min-w-0">
            {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
            <h2 className="mt-0.5 truncate text-[15px] font-semibold tracking-[-0.015em]">{title}</h2>
          </div>
          <button type="button" className="icon-btn shrink-0" onClick={onClose} aria-label="Close dialog">
            <X size={15} />
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
      <ArrowSquareOut size={12} />
    </a>
  );
}
