// A print at full size: the window darkens and the image fits it; the arrow
// keys move through the session's prints; a click on the image toggles
// between fitting and actual pixels.
import { useEffect, useState } from "react";
import { imageUrl } from "../../../shared/api.ts";
import type { ImageInfo } from "../../../shared/export.ts";
import type { Message } from "../../../shared/i18n/translator.ts";
import { api } from "../api.ts";
import { CloseIcon, CopyIcon, ExportIcon } from "../components/icons.tsx";
import { useI18n } from "../i18n.tsx";
import { useModalBoundary } from "./Modal.tsx";

interface ViewerProps {
  images: string[];
  index: number;
  onClose: () => void;
  /** Opens the export dialog on this image; the viewer returns when it closes. */
  onExport: (path: string, index: number) => void;
}

export function ViewerModal({ images, index, onClose, onExport }: ViewerProps) {
  const { t, of, translator } = useI18n();
  const panel = useModalBoundary(onClose);
  const [at, setAt] = useState(Math.max(0, index));
  const [actual, setActual] = useState(false);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [status, setStatus] = useState<Message | null>(null);
  const path = images[at];

  useEffect(() => {
    setInfo(null);
    setStatus(null);
    if (path) void api.inspectImage(path).then((outcome) => outcome.ok && setInfo(outcome.info));
  }, [path]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowRight" && at < images.length - 1) {
      event.preventDefault();
      setAt(at + 1);
      setActual(false);
    } else if (event.key === "ArrowLeft" && at > 0) {
      event.preventDefault();
      setAt(at - 1);
      setActual(false);
    }
  };

  if (!path) return null;
  return (
    <div ref={panel} tabIndex={-1} onKeyDown={onKeyDown} className="viewer" role="dialog" aria-modal="true" aria-label={t("viewer.label")}>
      <div className={`viewer-stage${actual ? " actual" : ""}`} onClick={(event) => event.target === event.currentTarget && onClose()}>
        <img
          src={imageUrl(path)}
          alt=""
          draggable={false}
          onClick={() => setActual((value) => !value)}
          title={t(actual ? "viewer.fit" : "viewer.actual")}
        />
      </div>
      <div className="viewer-bar">
        {images.length > 1 && <span className="viewer-count">{t("viewer.count", { index: at + 1, total: images.length })}</span>}
        {info && (
          <span className="viewer-info">
            {t("viewer.info", {
              width: String(info.width),
              height: String(info.height),
              format: info.format.toUpperCase(),
              size: translator.number(info.fileBytes / 1_000_000, { maximumFractionDigits: 1 }),
            })}
          </span>
        )}
        {status && (
          <span className="viewer-info" role="status">
            {of(status)}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="quiet-button on-dark"
          onClick={async () => {
            const outcome = await api.copyImage(path);
            setStatus(outcome.ok ? { key: "print.copied" } : outcome.failure.message);
          }}
        >
          <CopyIcon size={15} />
          <span>{t("print.copy")}</span>
        </button>
        <button type="button" className="quiet-button on-dark" onClick={() => onExport(path, at)}>
          <ExportIcon size={15} />
          <span>{t("print.export")}</span>
        </button>
        <button type="button" className="icon-button on-dark" data-autofocus="true" onClick={onClose} aria-label={t("common.close")}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
