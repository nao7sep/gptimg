// The composer: reference prints above the field; Attach, shape and quality
// below; Send on the right. It is the window's one drop receiver, and pasting
// an image adds it. Enter sends, except while an input method is composing
// (text-input-ime-conventions); Shift+Enter starts a new line.
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { imageUrl } from "../../../shared/api.ts";
import { DEFAULT_SIZE_RULE, parseSize, sizeProblem, sizeRuleOf } from "../../../shared/image-size.ts";
import { BACKGROUNDS, backgroundOf, type Background, type TurnOptions } from "../../../shared/session.ts";
import { imageRow } from "../../../shared/settings.ts";
import { QUALITIES, SIZES } from "../../../shared/ui-state.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { BrushIcon, ClipIcon, CloseIcon, SendIcon, ShapeGlyph, StopIcon } from "./icons.tsx";

export interface Reference {
  /** What is sent: an absolute path main registered, or a path relative to the session. */
  path: string;
  /** Where to load its preview from. */
  absolute: string;
}

export interface Draft {
  text: string;
  references: Reference[];
  /** A painted mask for one reference: its `path`, and the staged mask file. */
  mask?: { image: string; mask: string };
}

interface ComposerProps {
  draft: Draft;
  onDraft: (draft: Draft) => void;
  options: TurnOptions;
  imageModel: string;
  busy: boolean;
  keyMissing: boolean;
  sessionDir: string | null;
  focusRef: MutableRefObject<() => void>;
  attachRef: MutableRefObject<() => void>;
  onSend: (draft: Draft, options: TurnOptions) => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  /** Opens the mask painter for one attached image. */
  onPaintMask: (reference: Reference) => void;
}

const MAX_ROWS = 10;

export function Composer(props: ComposerProps) {
  const { t } = useI18n();
  const { draft, onDraft } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [size, setSize] = useState(props.options.size);
  const [quality, setQuality] = useState(props.options.quality);
  const [background, setBackground] = useState<Background>(backgroundOf(props.options));
  const [sizing, setSizing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The latest draft, for handlers that finish after an await.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    setSize(props.options.size);
    setQuality(props.options.quality);
    setBackground(backgroundOf(props.options));
  }, [props.options]);

  const qualities = imageRow(props.imageModel)?.image.qualities ?? QUALITIES;

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    const padding = el.offsetHeight - el.clientHeight + Number.parseFloat(getComputedStyle(el).paddingTop) * 2;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS + padding)}px`;
  }, [draft.text]);

  props.focusRef.current = () => field.current?.focus();

  const addPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    const accepted = await api.registerFiles(paths);
    if (accepted.length < paths.length) setNotice(t("composer.notImages"));
    const current = draftRef.current;
    const existing = new Set(current.references.map((r) => r.path));
    const added = accepted.filter((p) => !existing.has(p)).map((p) => ({ path: p, absolute: p }));
    if (added.length > 0) onDraft({ ...current, references: [...current.references, ...added] });
  };

  const attach = async () => {
    const picked = await api.pickImages();
    const current = draftRef.current;
    const existing = new Set(current.references.map((r) => r.path));
    const added = picked.filter((p) => !existing.has(p)).map((p) => ({ path: p, absolute: p }));
    if (added.length > 0) onDraft({ ...current, references: [...current.references, ...added] });
    field.current?.focus();
  };
  props.attachRef.current = () => void attach();

  const custom = !(SIZES as readonly string[]).includes(size);
  const canSend = !props.busy && (draft.text.trim() !== "" || draft.references.length > 0);

  const send = () => {
    if (!canSend) return;
    setNotice(null);
    props.onSend({ text: draft.text.trim(), references: draft.references, ...(draft.mask && { mask: draft.mask }) }, { size, quality, ...(background !== "auto" && { background }) });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const onPaste = async (event: React.ClipboardEvent) => {
    const hasImage = [...event.clipboardData.items].some((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (!hasImage) return;
    event.preventDefault();
    const files = [...event.clipboardData.files];
    const withPaths = files.map((file) => api.pathForFile(file)).filter((p) => p !== "");
    if (withPaths.length > 0) {
      await addPaths(withPaths);
      return;
    }
    const staged = await api.pasteImage();
    if (staged) {
      const current = draftRef.current;
      onDraft({ ...current, references: [...current.references, { path: staged, absolute: staged }] });
    }
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDropping(false);
    const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter((p) => p !== "");
    void addPaths(paths);
    field.current?.focus();
  };

  return (
    <div
      className={`composer-wrap${dropping ? " dropping" : ""}`}
      data-drop-receiver="true"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <div className="composer">
        {props.keyMissing && (
          <p className="composer-banner">
            {t("composer.keyMissing")}{" "}
            <button type="button" className="link-button" onClick={props.onOpenSettings}>
              {t("composer.openSettings")}
            </button>
          </p>
        )}
        {draft.references.length > 0 && (
          <ul className="chips" aria-label={t("composer.references")}>
            {draft.references.map((reference) => (
              <li key={reference.path} className={`chip${draft.mask?.image === reference.path ? " masked" : ""}`}>
                <img src={imageUrl(reference.absolute, 96)} alt="" draggable={false} />
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={t("composer.removeReference")}
                  onClick={() => {
                    const { mask, ...rest } = draft;
                    const references = draft.references.filter((r) => r.path !== reference.path);
                    onDraft(mask && mask.image !== reference.path ? { ...rest, mask, references } : { ...rest, references });
                  }}
                >
                  <CloseIcon size={11} />
                </button>
                <button
                  type="button"
                  className="chip-mask"
                  aria-pressed={draft.mask?.image === reference.path}
                  aria-label={t("composer.paintMask")}
                  title={t(draft.mask?.image === reference.path ? "composer.masked" : "composer.paintMask")}
                  onClick={() => props.onPaintMask(reference)}
                >
                  <BrushIcon size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={field}
          className="composer-field"
          rows={1}
          value={draft.text}
          placeholder={t("composer.placeholder")}
          aria-label={t("composer.label")}
          onChange={(event) => onDraft({ ...draft, text: event.target.value })}
          onKeyDown={onKeyDown}
          onPaste={(event) => void onPaste(event)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            // Some engines deliver the confirming Enter after compositionend: wait one frame.
            requestAnimationFrame(() => {
              composing.current = false;
            });
          }}
        />
        <div className="composer-controls">
          <button type="button" className="icon-button" onClick={() => void attach()} aria-label={t("composer.attach")} title={t("composer.attach")}>
            <ClipIcon />
          </button>
          <div className="shape-picker" role="radiogroup" aria-label={t("composer.shape")}>
            {SIZES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={size === value}
                className={`shape${size === value ? " on" : ""}`}
                title={t(`composer.size.${sizeKey(value)}`)}
                aria-label={t(`composer.size.${sizeKey(value)}`)}
                onClick={() => setSize(value)}
              >
                <ShapeGlyph shape={value} />
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={custom}
              className={`shape custom-size${custom ? " on" : ""}`}
              title={t("composer.size.custom")}
              aria-label={t("composer.size.custom")}
              onClick={() => setSizing(true)}
            >
              {custom ? size.replace("x", "\u00d7") : <span aria-hidden="true">{t("composer.size.customShort")}</span>}
            </button>
          </div>
          {sizing && (
            <SizePopover
              initial={parseSize(size) ?? { width: 1024, height: 1024 }}
              model={props.imageModel}
              onClose={() => setSizing(false)}
              onApply={(width, height) => {
                setSize(`${width}x${height}`);
                setSizing(false);
              }}
            />
          )}
          <label className="quality">
            <span className="visually-hidden">{t("composer.qualityLabel")}</span>
            <select value={qualities.includes(quality) ? quality : (qualities[0] ?? "auto")} onChange={(event) => setQuality(event.target.value)}>
              {qualities.map((value) => (
                <option key={value} value={value}>
                  {qualityLabel(value, t)}
                </option>
              ))}
            </select>
          </label>
          <label className="background">
            <span className="visually-hidden">{t("composer.background")}</span>
            <select value={background} onChange={(event) => setBackground(event.target.value as Background)} title={t("composer.background")}>
              {BACKGROUNDS.map((value) => (
                <option key={value} value={value}>
                  {t(`composer.background.${value}`)}
                </option>
              ))}
            </select>
          </label>
          {notice && <span className="composer-notice">{notice}</span>}
          <span className="spacer" />
          {props.busy ? (
            <button type="button" className="send-button stop" onClick={props.onCancel} aria-label={t("composer.cancel")} title={t("composer.cancel")}>
              <StopIcon size={16} />
            </button>
          ) : (
            <button type="button" className="send-button" disabled={!canSend} onClick={send} aria-label={t("composer.send")} title={t("composer.send")}>
              <SendIcon size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function sizeKey(value: string): "auto" | "square" | "portrait" | "landscape" {
  if (value === "1024x1024") return "square";
  if (value === "1024x1536") return "portrait";
  if (value === "1536x1024") return "landscape";
  return "auto";
}

const QUALITY_KEYS = ["auto", "low", "medium", "high", "xhigh", "max"] as const;

function qualityLabel(value: string, t: ReturnType<typeof useI18n>["t"]): string {
  return (QUALITY_KEYS as readonly string[]).includes(value) ? t(`composer.quality.${value as (typeof QUALITY_KEYS)[number]}`) : value;
}


/** Exact dimensions, checked against the image model's rule as they are typed. */
function SizePopover({
  initial,
  model,
  onClose,
  onApply,
}: {
  initial: { width: number; height: number };
  model: string;
  onClose: () => void;
  onApply: (width: number, height: number) => void;
}) {
  const { t, translator } = useI18n();
  const megapixels = (pixels: number) => translator.number(pixels / 1_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const [width, setWidth] = useState(String(initial.width));
  const [height, setHeight] = useState(String(initial.height));
  const panel = useRef<HTMLDivElement>(null);
  const rule = sizeRuleOf(model);
  // A model the app does not list is checked by OpenAI; the fields still step as the default model's do.
  const shown = rule ?? DEFAULT_SIZE_RULE;
  const w = Number(width);
  const h = Number(height);
  const problem = sizeProblem(w, h, rule);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Once on opening: the width ready to type over, and a click outside closes.
  useEffect(() => {
    const first = panel.current?.querySelector("input");
    first?.focus();
    first?.select();
    const onDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) closeRef.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const apply = () => {
    if (!problem) onApply(w, h);
  };

  return (
    <div
      ref={panel}
      className="size-popover"
      role="dialog"
      aria-label={t("composer.size.custom")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          apply();
        }
      }}
    >
      <div className="size-fields">
        <label>
          <span>{t("composer.size.width")}</span>
          <input type="number" inputMode="numeric" min={shown.multipleOf} step={shown.multipleOf} value={width} onChange={(e) => setWidth(e.target.value)} />
        </label>
        <span className="size-times" aria-hidden="true">
          {"\u00d7"}
        </span>
        <label>
          <span>{t("composer.size.height")}</span>
          <input type="number" inputMode="numeric" min={shown.multipleOf} step={shown.multipleOf} value={height} onChange={(e) => setHeight(e.target.value)} />
        </label>
      </div>
      <p className={`size-rule${problem ? " problem" : ""}`} role={problem ? "alert" : undefined}>
        {problem
          ? t(`composer.size.problem.${problem}`, {
              multiple: shown.multipleOf,
              ratio: shown.maxRatio,
              min: megapixels(shown.minPixels),
              max: megapixels(shown.maxPixels),
            })
          : t("composer.size.ok", { megapixels: megapixels(w * h) })}
      </p>
      <div className="size-actions">
        <button type="button" className="button" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="button primary" disabled={problem !== null} onClick={apply}>
          {t("composer.size.apply")}
        </button>
      </div>
    </div>
  );
}
