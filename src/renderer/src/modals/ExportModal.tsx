// Export: save a print as PNG, JPEG or WebP, at its own size, at a chosen
// longest side, or upscaled 2× or 4× by the SDK's local model, with
// transparency kept or filled. The choices are remembered for next time.
// The export and the upscaler download belong to the window (export-tasks.ts):
// closing the dialog, by any path, hides it and leaves a running task running.
import { useEffect, useRef, useState } from "react";
import { imageUrl, type AppFailure, type UpscalerStatus } from "../../../shared/api.ts";
import {
  DEFAULT_FILL,
  EXPORT_FORMATS,
  exportName,
  fillFor,
  LONG_SIDE,
  outputSize,
  QUALITY_RANGE,
  UPSCALE_FACTORS,
  validLongSide,
  type ExportPrefs,
  type ExportSize,
  type ImageInfo,
} from "../../../shared/export.ts";
import { api } from "../api.ts";
import type { ExportTasks } from "../export-tasks.ts";
import { useI18n } from "../i18n.tsx";
import { Modal } from "./Modal.tsx";

interface ExportModalProps {
  path: string;
  prefs: ExportPrefs;
  /** The window's export and download, which outlive the dialog. */
  tasks: ExportTasks;
  onClose: () => void;
  onExported: (prefs: ExportPrefs, savedTo: string, dir: string | null) => void;
}

type SizeKind = ExportSize["kind"] | "upscale2" | "upscale4";

function sizeKind(size: ExportSize): SizeKind {
  return size.kind === "upscale" ? (size.factor === 2 ? "upscale2" : "upscale4") : size.kind;
}

export function ExportModal({ path, prefs: initial, tasks, onClose, onExported }: ExportModalProps) {
  const { t, of, translator } = useI18n();
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [failure, setFailure] = useState<AppFailure | null>(null);
  const [prefs, setPrefs] = useState<ExportPrefs>(initial);
  const [longSide, setLongSide] = useState(initial.size.kind === "longSide" ? String(initial.size.px) : "");
  const [upscaler, setUpscaler] = useState<UpscalerStatus | null>(null);
  const { task, progress, outcome } = tasks;

  useEffect(() => {
    void api.inspectImage(path).then((outcome) => {
      if (outcome.ok) {
        setInfo(outcome.info);
        if (!longSide) setLongSide(String(Math.max(outcome.info.width, outcome.info.height)));
      } else setFailure(outcome.failure);
    });
    void api.upscalerStatus().then(setUpscaler);
    // Loads once per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // A download that ends, here or while the dialog was closed, changes what Export can do.
  const wasInstalling = useRef(task?.kind === "install");
  useEffect(() => {
    if (wasInstalling.current && task === null) void api.upscalerStatus().then(setUpscaler);
    wasInstalling.current = task?.kind === "install";
  }, [task]);

  // An outcome shown here needs no repeat in the task strip.
  const { markSeen } = tasks;
  useEffect(() => {
    if (outcome && !outcome.seen) markSeen();
  }, [outcome, markSeen]);
  const taskFailure = outcome && !outcome.stopped ? outcome.failure : null;
  const shownFailure = failure ?? taskFailure;

  const set = (next: Partial<ExportPrefs>) => setPrefs((p) => ({ ...p, ...next }));
  const upscaling = prefs.size.kind === "upscale";
  const longSideValue = Number(longSide);
  const longSideOk = prefs.size.kind !== "longSide" || validLongSide(longSideValue);
  const size: ExportSize = prefs.size.kind === "longSide" ? { kind: "longSide", px: longSideOk ? longSideValue : 0 } : prefs.size;
  const out = info && longSideOk ? outputSize(info.width, info.height, size) : null;
  const lossy = prefs.format === "jpeg" || (prefs.format === "webp" && !prefs.lossless);
  const fill = info ? fillFor(prefs, info.transparent) : null;
  const canExport = !!info && !!out && longSideOk && task === null && (!upscaling || upscaler?.installed === true);

  const chooseSize = (kind: SizeKind) => {
    if (kind === "original") set({ size: { kind: "original" } });
    else if (kind === "longSide") set({ size: { kind: "longSide", px: validLongSide(longSideValue) ? longSideValue : LONG_SIDE.min } });
    else set({ size: { kind: "upscale", factor: kind === "upscale2" ? 2 : 4 } });
  };

  const run = () => {
    if (!info || !out) return;
    const final: ExportPrefs = { ...prefs, size };
    void tasks.exportImage({ ...final, path }, exportName(path, final, out, info), upscaling, (savedTo, dir) => onExported(final, savedTo, dir));
  };

  // Every close path ends here: it hides the dialog and never stops the task, which has its own Stop.
  const close = () => onClose();

  const megabytes = (bytes: number) => translator.number(bytes / 1_000_000, { maximumFractionDigits: 1 });
  // Pixel sizes read as plain digits ("2048 × 2048"), never with thousands separators.
  const dims = (w: number, h: number) => t("export.dimensions", { width: String(w), height: String(h) });
  const progressText = progress && progress.total > 0 ? t("export.progress", { done: progress.done, total: progress.total }) : null;

  return (
    <Modal
      title={t("export.title")}
      width={540}
      onClose={close}
      footer={
        <>
          {task && (
            <>
              <span className="task-status" role="status">
                {t(task.kind === "export" ? (task.upscaling ? "export.upscaling" : "export.working") : "export.downloading")}
                {progressText && ` ${progressText}`}
              </span>
              <button type="button" className="button" onClick={tasks.stop}>
                {t("export.stop")}
              </button>
            </>
          )}
          {shownFailure && !task && (
            <span className="foot-error" role="alert">
              {of(shownFailure.message)}
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={close}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button primary" disabled={!canExport} onClick={run}>
            {t("export.confirm")}
          </button>
        </>
      }
    >
      <div className="export-head">
        <img className="export-preview" src={imageUrl(path, 192)} alt="" draggable={false} />
        <div className="export-facts">
          {info ? (
            <>
              <span>{dims(info.width, info.height)}</span>
              <span>{t("export.source", { format: info.format.toUpperCase(), size: megabytes(info.fileBytes) })}</span>
              {info.transparent && <span>{t("export.hasTransparency")}</span>}
            </>
          ) : (
            !failure && <span className="muted">{t("export.reading")}</span>
          )}
        </div>
      </div>

      <fieldset className="field" disabled={task !== null}>
        <legend className="field-label">{t("export.format")}</legend>
        <div className="segmented" role="radiogroup" aria-label={t("export.format")}>
          {EXPORT_FORMATS.map((format) => (
            <button key={format} type="button" role="radio" aria-checked={prefs.format === format} className={prefs.format === format ? "on" : ""} onClick={() => set({ format })}>
              {t(`export.format.${format}`)}
            </button>
          ))}
        </div>
        <span className="field-help">{t(`export.formatHelp.${prefs.format}`)}</span>
      </fieldset>

      {prefs.format === "webp" && (
        <label className="check" aria-disabled={task !== null}>
          <input type="checkbox" checked={prefs.lossless} disabled={task !== null} onChange={(e) => set({ lossless: e.target.checked })} />
          <span>{t("export.lossless")}</span>
        </label>
      )}

      {lossy && (
        <label className="field">
          <span className="field-label">{t("export.quality", { value: prefs.quality })}</span>
          <input
            type="range"
            min={QUALITY_RANGE.min}
            max={QUALITY_RANGE.max}
            value={prefs.quality}
            disabled={task !== null}
            onChange={(e) => set({ quality: Number(e.target.value) })}
          />
        </label>
      )}

      <fieldset className="field" disabled={task !== null}>
        <legend className="field-label">{t("export.size")}</legend>
        <div className="choice-list" role="radiogroup" aria-label={t("export.size")}>
          <Choice checked={sizeKind(prefs.size) === "original"} onChoose={() => chooseSize("original")}>
            {t("export.size.original")}
            {info && <span className="choice-note">{dims(info.width, info.height)}</span>}
          </Choice>
          <Choice checked={sizeKind(prefs.size) === "longSide"} onChoose={() => chooseSize("longSide")}>
            {t("export.size.longSide")}
            <input
              className="inline-number"
              type="number"
              min={LONG_SIDE.min}
              max={LONG_SIDE.max}
              value={longSide}
              aria-label={t("export.size.longSidePixels")}
              onFocus={() => chooseSize("longSide")}
              onChange={(e) => {
                setLongSide(e.target.value);
                const px = Number(e.target.value);
                if (validLongSide(px)) set({ size: { kind: "longSide", px } });
              }}
            />
            <span className="choice-note">{t("export.pixels")}</span>
          </Choice>
          {UPSCALE_FACTORS.map((factor) => (
            <Choice key={factor} checked={sizeKind(prefs.size) === `upscale${factor}`} onChoose={() => chooseSize(factor === 2 ? "upscale2" : "upscale4")}>
              {t("export.size.upscale", { factor })}
              {info && <span className="choice-note">{dims(info.width * factor, info.height * factor)}</span>}
            </Choice>
          ))}
        </div>
        {!longSideOk && <span className="field-error">{t("export.longSideRange", { min: LONG_SIDE.min, max: LONG_SIDE.max })}</span>}
        {upscaling && upscaler && !upscaler.installed && (
          <div className="inline-notice">
            <span>
              {upscaler.downloadBytes
                ? t("export.upscalerNeeded", { size: megabytes(upscaler.downloadBytes) })
                : t("export.upscalerNeededUnknown")}
            </span>
            <button type="button" className="button" disabled={task !== null} onClick={() => void tasks.download()}>
              {t("export.download")}
            </button>
          </div>
        )}
        {upscaling && <span className="field-help">{t("export.upscaleHelp")}</span>}
      </fieldset>

      {info?.transparent && (
        <fieldset className="field" disabled={task !== null}>
          <legend className="field-label">{t("export.transparency")}</legend>
          <div className="choice-list" role="radiogroup" aria-label={t("export.transparency")}>
            <Choice checked={fill === null} disabled={prefs.format === "jpeg"} onChoose={() => set({ fill: null })}>
              {t("export.keepTransparency")}
            </Choice>
            <Choice checked={fill !== null} onChoose={() => set({ fill: prefs.fill ?? DEFAULT_FILL })}>
              {t("export.fill")}
              <input
                className="colour"
                type="color"
                value={fill ?? prefs.fill ?? DEFAULT_FILL}
                aria-label={t("export.fillColour")}
                onChange={(e) => set({ fill: e.target.value })}
              />
            </Choice>
          </div>
          {prefs.format === "jpeg" && <span className="field-help">{t("export.jpegNoTransparency")}</span>}
        </fieldset>
      )}
    </Modal>
  );
}

function Choice({ checked, disabled, onChoose, children }: { checked: boolean; disabled?: boolean; onChoose: () => void; children: React.ReactNode }) {
  return (
    <div
      className={`choice${checked ? " on" : ""}${disabled ? " disabled" : ""}`}
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onChoose()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === " " || e.key === "Enter") && e.target === e.currentTarget) {
          e.preventDefault();
          onChoose();
        }
      }}
    >
      <span className="choice-dot" aria-hidden="true" />
      {children}
    </div>
  );
}
