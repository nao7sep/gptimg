// The one modal shell (modal-dialog-conventions): header, scrolling body and
// footer bands; a scrim; focus kept inside and returned on close; Escape and
// the close button close it. Every dialog in the app is drawn by this shell.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "../components/icons.tsx";
import { useI18n } from "../i18n.tsx";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalBoundary { root: HTMLElement; close: () => void }
const modalStack: ModalBoundary[] = [];
let backgroundOverflow = "";

/** Menu dismissal uses the same guard as the topmost dialog's own controls. */
export function requestTopModalClose(): boolean {
  const top = modalStack.at(-1);
  if (!top) return false;
  top.close();
  return true;
}

/** Shared behavior also serves the viewer, which has its own image surface. */
export function useModalBoundary(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current;
    if (!root) return;
    const boundary = { root, close: () => closeRef.current() };
    if (modalStack.length === 0) backgroundOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modalStack.push(boundary);
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && !el.closest("[hidden]"));
    const initial = () => root.querySelector<HTMLElement>("[data-autofocus]") ?? items().find((el) => !el.dataset.destructive && !el.dataset.close) ?? root;
    const isTop = () => modalStack.at(-1) === boundary;
    const keepFocus = (event: FocusEvent) => {
      if (isTop() && !root.contains(event.target as Node)) initial().focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!isTop()) return;
      event.stopPropagation();
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        boundary.close();
      } else if (event.key === "Tab") {
        const controls = items();
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) { event.preventDefault(); root.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", onKey);
    initial().focus();
    return () => {
      const wasTop = isTop();
      modalStack.splice(modalStack.indexOf(boundary), 1);
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", onKey);
      if (modalStack.length === 0) document.body.style.overflow = backgroundOverflow;
      if (wasTop) {
        if (previous?.isConnected && previous.matches(FOCUSABLE) && !root.contains(previous)) previous.focus();
        else {
          const remaining = modalStack.at(-1)?.root;
          const fallback = [...(remaining ?? document).querySelectorAll<HTMLElement>(FOCUSABLE)]
            .find((el) => !root.contains(el) && !el.hidden && !el.closest("[hidden]"));
          (fallback ?? remaining)?.focus();
        }
      }
    };
  }, []);
  return panel;
}

export interface ModalProps {
  title: string;
  onClose: () => void;
  /** Width in px, inside the fleet range for the dialog's kind. */
  width: number;
  footer?: ReactNode;
  children: ReactNode;
  /** Shown above the body, below the title: one line of what this is for. */
  intro?: string;
  /** A band under the title that stays while the body scrolls, such as a tab strip. */
  band?: ReactNode;
  /** A surface that works on an image: 85% of the window both ways (modal-dialog-conventions). */
  large?: boolean;
}

export function Modal({ title, onClose, width, footer, children, intro, band, large }: ModalProps) {
  const { t } = useI18n();
  const panel = useModalBoundary(onClose);
  const titleId = useId();

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${large ? " modal-large" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        tabIndex={-1}
        style={large ? undefined : { width }}
      >
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button modal-close" data-close="true" aria-label={t("common.close")} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </header>
        {band && <div className="modal-band">{band}</div>}
        <div className="modal-body">
          {intro && <p className="modal-intro">{intro}</p>}
          {children}
        </div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
