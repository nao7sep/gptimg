// Settings: a draft of every set, saved together. Fields show the effective
// values as real text; Reset fills a group with its built-ins and saves
// nothing until Save (config-sets-conventions). The OpenAI key is edited as
// stored, never as the environment shadows it (api-key-storage-conventions).
import { useEffect, useMemo, useState } from "react";
import type { BootInfo, KeyStatus } from "../../../shared/api.ts";
import { LANGUAGES, OWN_NAMES, type LanguagePreference } from "../../../shared/i18n/languages.ts";
import type { Message } from "../../../shared/i18n/translator.ts";
import {
  builtInSettings,
  chatRow,
  CONTENT_LINE_HEIGHT,
  CONTENT_SIZE,
  imageRow,
  SET_KEYS,
  THEMES,
  thinkingAfterModelChange,
  validateSet,
  type Settings,
  type Theme,
} from "../../../shared/settings.ts";
import { api } from "../api.ts";
import { EyeIcon } from "../components/icons.tsx";
import { useI18n } from "../i18n.tsx";
import { Modal } from "./Modal.tsx";

interface SettingsModalProps {
  boot: BootInfo;
  settings: Settings;
  problem: Message | null;
  keyStatus: KeyStatus;
  onClose: () => void;
  onSaved: (settings: Settings, key: KeyStatus) => void;
}

export function SettingsModal(props: SettingsModalProps) {
  const { t, of, info } = useI18n();
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [lastRow, setLastRow] = useState<string | null>(chatRow(props.settings["openai.chat"])?.id ?? null);
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [failure, setFailure] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.peekKey().then((value) => {
      setStoredKey(value);
      setKeyDraft(value ?? "");
    });
  }, []);

  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const row = chatRow(draft["openai.chat"]);
  const invalid = SET_KEYS.filter((key) => validateSet(key, draft[key]) !== null);

  const save = async () => {
    if (invalid.length > 0 || saving) return;
    setSaving(true);
    setFailure(null);
    const outcome = await api.saveSettings(draft);
    if (!outcome.ok) {
      setFailure(outcome.failure.message);
      setSaving(false);
      return;
    }
    let status = props.keyStatus;
    if (keyDraft.trim() !== (storedKey ?? "")) {
      const keyOutcome = keyDraft.trim() ? await api.setKey(keyDraft) : await api.clearKey();
      if (!keyOutcome.ok) {
        setFailure(keyOutcome.failure.message);
        setSaving(false);
        return;
      }
      status = keyOutcome.status;
    }
    props.onSaved(outcome.settings, status);
  };

  const builtIn = builtInSettings();

  return (
    <Modal
      title={t("settings.title")}
      width={640}
      onClose={props.onClose}
      footer={
        <>
          {failure && (
            <span className="foot-error" role="alert">
              {of(failure)}
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button primary" disabled={invalid.length > 0 || saving || props.boot.settingsLocked} onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      {props.problem && <p className="notice notice-warn">{of(props.problem)}</p>}

      <section className="settings-section">
        <h3>{t("settings.general")}</h3>
        <label className="field">
          <span className="field-label">{t("settings.language")}</span>
          <select data-autofocus="true" value={draft.language} onChange={(e) => set("language", e.target.value as LanguagePreference)}>
            <option value="system">{t("settings.system", { value: OWN_NAMES[info.systemLanguage] })}</option>
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {OWN_NAMES[language]}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label" id="theme-label">
            {t("settings.theme")}
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="theme-label">
            {THEMES.map((theme: Theme) => (
              <button key={theme} type="button" role="radio" aria-checked={draft.theme === theme} className={draft.theme === theme ? "on" : ""} onClick={() => set("theme", theme)}>
                {t(`settings.theme.${theme}`)}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">{t("settings.timeZone")}</span>
          <select value={draft.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
            <option value="system">{t("settings.system", { value: props.boot.systemTimeZone })}</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>{t("settings.fonts")}</h3>
          <button type="button" className="quiet-button" onClick={() => setDraft((d) => ({ ...d, uiFont: builtIn.uiFont, contentFont: builtIn.contentFont }))}>
            {t("settings.resetFonts")}
          </button>
        </div>
        <label className="field">
          <span className="field-label">{t("settings.uiFont")}</span>
          <input type="text" value={draft.uiFont} onChange={(e) => set("uiFont", e.target.value)} spellCheck={false} />
          {validateSet("uiFont", draft.uiFont) && <span className="field-error">{t("settings.error.required")}</span>}
        </label>
        <label className="field">
          <span className="field-label">{t("settings.contentFont")}</span>
          <input
            type="text"
            value={draft.contentFont.family}
            onChange={(e) => set("contentFont", { ...draft.contentFont, family: e.target.value })}
            spellCheck={false}
          />
          <span className="field-help">{t("settings.contentFontHelp")}</span>
        </label>
        <div className="field-row">
          <NumberField
            label={t("settings.readingSize")}
            value={draft.contentFont.readingSize}
            min={CONTENT_SIZE.min}
            max={CONTENT_SIZE.max}
            step={1}
            onChange={(readingSize) => set("contentFont", { ...draft.contentFont, readingSize })}
          />
          <NumberField
            label={t("settings.writingSize")}
            value={draft.contentFont.writingSize}
            min={CONTENT_SIZE.min}
            max={CONTENT_SIZE.max}
            step={1}
            onChange={(writingSize) => set("contentFont", { ...draft.contentFont, writingSize })}
          />
          <NumberField
            label={t("settings.lineHeight")}
            value={draft.contentFont.lineHeight}
            min={CONTENT_LINE_HEIGHT.min}
            max={CONTENT_LINE_HEIGHT.max}
            step={0.05}
            onChange={(lineHeight) => set("contentFont", { ...draft.contentFont, lineHeight })}
          />
        </div>
        {validateSet("contentFont", draft.contentFont) && <span className="field-error">{t(validateSet("contentFont", draft.contentFont) as never)}</span>}
      </section>

      <section className="settings-section">
        <h3>{t("settings.sessions")}</h3>
        <div className="field">
          <span className="field-label">{t("settings.sessionsFolder")}</span>
          <div className="path-row">
            <span className="path-value" title={draft.sessionsDir}>
              <bdi dir="ltr">{draft.sessionsDir || t("settings.notChosen")}</bdi>
            </span>
            <button
              type="button"
              className="button"
              onClick={async () => {
                const picked = await api.pickFolder(draft.sessionsDir);
                if (picked) set("sessionsDir", picked);
              }}
            >
              {t("settings.choose")}
            </button>
          </div>
          <span className="field-help">{t("settings.sessionsHelp")}</span>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t("settings.openai")}</h3>
        <p className="section-note">{t("settings.openaiOnly")}</p>
        <label className="field">
          <span className="field-label">{t("settings.endpoint")}</span>
          <input type="text" value={draft["openai.endpoint"]} spellCheck={false} onChange={(e) => set("openai.endpoint", e.target.value)} />
          <span className="field-help">{t("settings.endpointHelp")}</span>
          {validateSet("openai.endpoint", draft["openai.endpoint"]) && <span className="field-error">{t("settings.error.endpoint")}</span>}
        </label>
        <label className="field">
          <span className="field-label">{t("settings.apiKey")}</span>
          <div className="key-row">
            <input
              type={showKey ? "text" : "password"}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("settings.apiKeyPlaceholder")}
            />
            <button type="button" className="icon-button" aria-pressed={showKey} aria-label={t("settings.showKey")} title={t("settings.showKey")} onClick={() => setShowKey((v) => !v)}>
              <EyeIcon />
            </button>
          </div>
          <span className="field-help">
            {props.keyStatus.source === "env" ? t("settings.keyFromEnv") : t("settings.keyHelp")}
          </span>
          {props.keyStatus.problem && <span className="field-error">{of(props.keyStatus.problem)}</span>}
        </label>
        <label className="field">
          <span className="field-label">{t("settings.chatModel")}</span>
          <input
            type="text"
            value={draft["openai.chat"]}
            spellCheck={false}
            onChange={(e) => {
              const next = e.target.value;
              const moved = thinkingAfterModelChange(lastRow, next, draft["openai.thinking.chat"]);
              setLastRow(moved.lastRow);
              setDraft((d) => ({ ...d, "openai.chat": next, "openai.thinking.chat": moved.thinking }));
            }}
          />
          <span className="field-help">{t("settings.chatModelHelp")}</span>
          {!row && draft["openai.chat"].trim() !== "" && <span className="field-warn">{t("settings.unsupportedModel")}</span>}
        </label>
        {row && row.thinking.length > 1 && (
          <label className="field">
            <span className="field-label">{t("settings.thinking")}</span>
            <select value={row.thinking.includes(draft["openai.thinking.chat"]) ? draft["openai.thinking.chat"] : row.defaultThinking} onChange={(e) => set("openai.thinking.chat", e.target.value)}>
              {row.thinking.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <span className="field-help">{t("settings.thinkingHelp")}</span>
          </label>
        )}
        <label className="field">
          <span className="field-label">{t("settings.imageModel")}</span>
          <input type="text" value={draft["openai.image"]} spellCheck={false} onChange={(e) => set("openai.image", e.target.value)} />
          <span className="field-help">{t("settings.imageModelHelp")}</span>
          {!imageRow(draft["openai.image"]) && draft["openai.image"].trim() !== "" && <span className="field-warn">{t("settings.unsupportedModel")}</span>}
        </label>
      </section>
    </Modal>
  );
}

function NumberField(props: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  return (
    <label className="field compact">
      <span className="field-label">{props.label}</span>
      <input
        type="number"
        value={text}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => {
          setText(e.target.value);
          const value = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(value)) props.onChange(value);
        }}
      />
    </label>
  );
}
