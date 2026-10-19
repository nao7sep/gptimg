// A print at full size: the window darkens and the image fits it; the arrow
// keys move through the session's prints; a click on the image toggles
// between fitting and actual pixels.
import { useEffect, useState } from "react";
import { imageUrl } from "../../../shared/api.ts";
import { CloseIcon } from "../components/icons.tsx";
import { useI18n } from "../i18n.tsx";

export function ViewerModal({ images, index, onClose }: { images: string[]; index: number; onClose: () => void }) {
  const { t } = useI18n();
  const [at, setAt] = useState(Math.max(0, index));
  const [actual, setActual] = useState(false);
  const path = images[at];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowRight" && at < images.length - 1) {
        setAt(at + 1);
        setActual(false);
      } else if (event.key === "ArrowLeft" && at > 0) {
        setAt(at - 1);
        setActual(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, images.length, onClose]);

  if (!path) return null;
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={t("viewer.label")}>
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
        <span className="spacer" />
        <button type="button" className="icon-button on-dark" autoFocus onClick={onClose} aria-label={t("common.close")}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
