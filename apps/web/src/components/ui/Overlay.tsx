import { X } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, type ButtonVariant } from "./Button";
import { useDialog } from "./hooks";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Pinned footer (actions). */
  footer?: ReactNode;
  children: ReactNode;
  /** Width in px on desktop (default 480). 100% on mobile. */
  width?: number;
  className?: string;
}

/**
 * Right drawer, 480 wide (100% on mobile), header 56 with title and close, optional footer. Escape closes, focus is
 * trapped and returns to the trigger. Used for New strategy, alert detail and the mobile nav.
 */
export function Drawer({ open, onClose, title, footer, children, width, className }: DrawerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useDialog(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <>
      <div className="backdrop" onClick={onClose} aria-hidden />
      <div ref={ref} className={cn("drawer", className)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={width ? { width } : undefined}>
        <div className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon={X} label="Close" onClick={onClose} style={{ marginLeft: "auto" }} />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Body text (secondary color) or any content. */
  children?: ReactNode;
  /** Footer actions, right aligned. Use `ConfirmModal` for the usual Cancel + confirm pair. */
  footer?: ReactNode;
}

/** 440 wide (max 100vw - 32), raised surface, radius 12, shadow-3. For destructive confirmations only. */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useDialog(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <>
      <div className="backdrop" onClick={onClose} aria-hidden />
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-body">
          <h3 id={titleId}>{title}</h3>
          {typeof children === "string" ? <p>{children}</p> : children}
        </div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

/**
 * Cancel (ghost) + confirm. `variant="danger"` for destructive actions.
 *   <ConfirmModal open title="Pause trading?" confirmLabel="Pause trading" confirmIcon={CirclePause} variant="danger" onConfirm={...} onClose={...}>
 *     Hermes stops sending new orders...
 *   </ConfirmModal>
 */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  confirmIcon,
  variant = "primary",
  loading,
  loadingLabel,
  cancelLabel = "Cancel",
}: Omit<ModalProps, "footer"> & {
  onConfirm: () => void;
  confirmLabel: string;
  confirmIcon?: LucideIcon;
  variant?: ButtonVariant;
  loading?: boolean;
  loadingLabel?: string;
  cancelLabel?: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={variant} icon={confirmIcon} loading={loading} loadingLabel={loadingLabel} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
