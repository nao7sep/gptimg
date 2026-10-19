// A generated image on its mat, with its actions always beneath it at low
// emphasis and reachable by Tab. An action's result shows on the print it
// concerns (operation-result-conventions): a short confirmation fades, a
// failure stays until dismissed.
import { useEffect, useState } from "react";
import { imageUrl } from "../../../shared/api.ts";
import type { Message } from "../../../shared/i18n/translator.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { CloseIcon, CopyIcon, ExpandIcon, ExportIcon, FolderIcon, ReuseIcon } from "./icons.tsx";

/** Prints are decoded at the column's width at 2x, never at full size. */
const PRINT_DECODE_WIDTH = 1600;

export function Print({ path, onOpen, onReuse }: { path: string; onOpen: () => void; onReuse: () => void }) {
  const { t, of } = useI18n();
  const [done, setDone] = useState<Message | null>(null);
  const [failure, setFailure] = useState<Message | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 2200);
    return () => clearTimeout(timer);
  }, [done]);

  const copy = async () => {
    const outcome = await api.copyImage(path);
    if (outcome.ok) setDone({ key: "print.copied" });
    else setFailure(outcome.failure.message);
  };
  const exportIt = async () => {
    const outcome = await api.exportImage(path);
    if (!outcome.ok) setFailure(outcome.failure.message);
    else if (outcome.savedTo) setDone({ key: "print.exported" });
  };

  return (
    <figure className="print">
      <button type="button" className="print-mat" onClick={onOpen} aria-label={t("print.open")}>
        {broken ? (
          <span className="print-missing">{t("print.missing")}</span>
        ) : (
          <img src={imageUrl(path, PRINT_DECODE_WIDTH)} alt="" draggable={false} onError={() => setBroken(true)} />
        )}
      </button>
      <figcaption className="print-actions">
        <button type="button" className="quiet-button" onClick={onOpen}>
          <ExpandIcon size={15} />
          <span>{t("print.openShort")}</span>
        </button>
        <button type="button" className="quiet-button" onClick={() => void copy()}>
          <CopyIcon size={15} />
          <span>{t("print.copy")}</span>
        </button>
        <button type="button" className="quiet-button" onClick={() => void exportIt()}>
          <ExportIcon size={15} />
          <span>{t("print.export")}</span>
        </button>
        <button type="button" className="quiet-button" onClick={onReuse}>
          <ReuseIcon size={15} />
          <span>{t("print.reuse")}</span>
        </button>
        <button type="button" className="quiet-button icon-only" onClick={() => api.showInFolder(path)} aria-label={t("print.reveal")} title={t("print.reveal")}>
          <FolderIcon size={15} />
        </button>
        {done && (
          <span className="print-status" role="status">
            {of(done)}
          </span>
        )}
        {failure && (
          <span className="print-failure" role="alert">
            {of(failure)}
            <button type="button" className="icon-button tiny" onClick={() => setFailure(null)} aria-label={t("common.dismiss")}>
              <CloseIcon size={12} />
            </button>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
