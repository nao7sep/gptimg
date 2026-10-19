// The one modal shell (modal-dialog-conventions): header, scrolling body and
// footer bands; a scrim; focus kept inside and returned on close; Escape and
// the close button close it. Every dialog in the app is drawn by this shell.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "../components/icons.tsx";
import { useI18n } from "../i18n.tsx";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  title: string;
  onClose: () => void;
  /** Width in px, inside the fleet range for the dialog's kind. */
  width: number;
  footer?: ReactNode;
  children: ReactNode;
  /** Shown above the body, below the title: one line of what this is for. */
  intro?: string;
}

export function Modal({ title, onClose, width, footer, children, intro }: ModalProps) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current!;
    const preferred = root.querySelector<HTMLElement>("[data-autofocus]");
    const first = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => !el.dataset.destructive && !el.dataset.close);
    (preferred ?? first ?? root).focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...panel.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        tabIndex={-1}
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button modal-close" data-close="true" aria-label={t("common.close")} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="modal-body">
          {intro && <p className="modal-intro">{intro}</p>}
          {children}
        </div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
