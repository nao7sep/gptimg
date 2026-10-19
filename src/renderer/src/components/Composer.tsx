// The composer: reference prints above the field; Attach, shape and quality
// below; Send on the right. It is the window's one drop receiver, and pasting
// an image adds it. Enter sends, except while an input method is composing
// (text-input-ime-conventions); Shift+Enter starts a new line.
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { imageUrl } from "../../../shared/api.ts";
import type { TurnOptions } from "../../../shared/session.ts";
import { imageRow } from "../../../shared/settings.ts";
import { QUALITIES, SIZES } from "../../../shared/ui-state.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { ClipIcon, CloseIcon, SendIcon, ShapeGlyph, StopIcon } from "./icons.tsx";

export interface Reference {
  /** What is sent: an absolute path main registered, or a path relative to the session. */
  path: string;
  /** Where to load its preview from. */
  absolute: string;
}

export interface Draft {
  text: string;
  references: Reference[];
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
}

const MAX_ROWS = 10;

export function Composer(props: ComposerProps) {
  const { t } = useI18n();
  const { draft, onDraft } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [size, setSize] = useState(props.options.size);
  const [quality, setQuality] = useState(props.options.quality);
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The latest draft, for handlers that finish after an await.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    setSize(props.options.size);
    setQuality(props.options.quality);
  }, [props.options.size, props.options.quality]);

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

  const canSend = !props.busy && (draft.text.trim() !== "" || draft.references.length > 0);

  const send = () => {
    if (!canSend) return;
    setNotice(null);
    props.onSend({ text: draft.text.trim(), references: draft.references }, { size, quality });
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
              <li key={reference.path} className="chip">
                <img src={imageUrl(reference.absolute, 96)} alt="" draggable={false} />
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={t("composer.removeReference")}
                  onClick={() => onDraft({ ...draft, references: draft.references.filter((r) => r.path !== reference.path) })}
                >
                  <CloseIcon size={11} />
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
          </div>
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
