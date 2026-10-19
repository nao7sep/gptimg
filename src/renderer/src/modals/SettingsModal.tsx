// Settings: a draft of every set, saved together, in tabs (General, Chats,
// OpenAI) with appearance and fonts first. Save is offered once something
// changed; closing with changes asks first. Fields show the effective values
// as real text; Reset fills a group with its built-ins and saves nothing until
// Save (config-sets-conventions). The key field holds only a new key: the
// saved one is never shown, and clearing it is its own action
// (api-key-storage-conventions).
import { useEffect, useMemo, useState } from "react";
import type { BootInfo, KeyStatus } from "../../../shared/api.ts";
import { LANGUAGES, OWN_NAMES, type LanguagePreference } from "../../../shared/i18n/languages.ts";
import type { Message } from "../../../shared/i18n/translator.ts";
import {
  builtInSettings,
  chatRow,
  CONTENT_LINE_HEIGHT,
  CONTENT_SIZE,
  DRAFT_COUNTS,
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
import { ConfirmModal } from "./SmallModals.tsx";

interface SettingsModalProps {
  boot: BootInfo;
  settings: Settings;
  problem: Message | null;
  keyStatus: KeyStatus;
  onClose: () => void;
  onSaved: (settings: Settings, key: KeyStatus) => void;
}

const TABS = ["general", "chats", "openai"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL = { general: "settings.general", chats: "settings.sessions", openai: "settings.openai" } as const;

export function SettingsModal(props: SettingsModalProps) {
  const { t, of, info } = useI18n();
  const [tab, setTab] = useState<Tab>("general");
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [lastRow, setLastRow] = useState<string | null>(chatRow(props.settings["openai.chat"])?.id ?? null);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [failure, setFailure] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    void api.peekKey().then((value) => setHasStoredKey(value !== null));
  }, []);

  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const row = chatRow(draft["openai.chat"]);
  const invalid = SET_KEYS.filter((key) => validateSet(key, draft[key]) !== null);
  const keyChanged = newKey.trim() !== "" || clearKey;
  const dirty = keyChanged || JSON.stringify(draft) !== JSON.stringify(props.settings);
  const builtIn = builtInSettings();

  const requestClose = () => (dirty ? setConfirmDiscard(true) : props.onClose());

  const save = async () => {
    if (invalid.length > 0 || saving || !dirty) return;
    setSaving(true);
    setFailure(null);
    const outcome = await api.saveSettings(draft);
    if (!outcome.ok) {
      setFailure(outcome.failure.message);
      setSaving(false);
      return;
    }
    let status = props.keyStatus;
    if (keyChanged) {
      const keyOutcome = newKey.trim() ? await api.setKey(newKey) : await api.clearKey();
      if (!keyOutcome.ok) {
        setFailure(keyOutcome.failure.message);
        setSaving(false);
        return;
      }
      status = keyOutcome.status;
    }
    props.onSaved(outcome.settings, status);
  };

  const onTabKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const i = TABS.indexOf(tab);
    const next = TABS[(i + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  };

  const tabs = (
    <div className="tab-strip" role="tablist" aria-label={t("settings.title")} onKeyDown={onTabKey}>
      {TABS.map((id) => (
        <button
          key={id}
          id={`settings-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={tab === id}
          aria-controls={`settings-panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          className={tab === id ? "on" : ""}
          onClick={() => setTab(id)}
        >
          {t(TAB_LABEL[id])}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <Modal
        title={t("settings.title")}
        width={640}
        onClose={requestClose}
        band={tabs}
        footer={
          <>
            <span className="spacer" />
            <button type="button" className="button" onClick={requestClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className="button primary" disabled={!dirty || invalid.length > 0 || saving || props.boot.settingsLocked} onClick={() => void save()}>
              {t("common.save")}
            </button>
          </>
        }
      >
        {props.problem && <p className="notice notice-warn">{of(props.problem)}</p>}
        {failure && (
          <p className="notice notice-error" role="alert">
            {of(failure)}
          </p>
        )}

        <div id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
          {tab === "general" && (
            <>
              <section className="settings-group">
                <h3 className="group-label">{t("settings.group.appearance")}</h3>
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
              </section>

              <section className="settings-group">
                <div className="group-head">
                  <h3 className="group-label">{t("settings.fonts")}</h3>
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
                  <input type="text" value={draft.contentFont.family} onChange={(e) => set("contentFont", { ...draft.contentFont, family: e.target.value })} spellCheck={false} />
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

              <section className="settings-group">
                <h3 className="group-label">{t("settings.group.region")}</h3>
                <label className="field">
                  <span className="field-label">{t("settings.language")}</span>
                  <select value={draft.language} onChange={(e) => set("language", e.target.value as LanguagePreference)}>
                    <option value="system">{t("settings.system", { value: OWN_NAMES[info.systemLanguage] })}</option>
                    {LANGUAGES.map((language) => (
                      <option key={language} value={language}>
                        {OWN_NAMES[language]}
                      </option>
                    ))}
                  </select>
                </label>
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
            </>
          )}

          {tab === "chats" && (
            <section className="settings-group">
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
          )}

          {tab === "openai" && (
            <>
              <p className="section-note">{t("settings.openaiOnly")}</p>
              <section className="settings-group">
                <h3 className="group-label">{t("settings.group.connection")}</h3>
                <label className="field">
                  <span className="field-label">{t("settings.endpoint")}</span>
                  <input type="text" value={draft["openai.endpoint"]} spellCheck={false} onChange={(e) => set("openai.endpoint", e.target.value)} />
                  <span className="field-help">{t("settings.endpointHelp")}</span>
                  {validateSet("openai.endpoint", draft["openai.endpoint"]) && <span className="field-error">{t("settings.error.endpoint")}</span>}
                </label>
                <div className="field">
                  <label className="field-label" htmlFor="settings-key">
                    {t("settings.apiKey")}
                  </label>
                  <div className="key-row">
                    <input
                      id="settings-key"
                      type={showKey ? "text" : "password"}
                      value={newKey}
                      disabled={clearKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={hasStoredKey ? t("settings.keySaved") : t("settings.apiKeyPlaceholder")}
                    />
                    <button type="button" className="icon-button" aria-pressed={showKey} aria-label={t("settings.showKey")} title={t("settings.showKey")} onClick={() => setShowKey((v) => !v)}>
                      <EyeIcon />
                    </button>
                  </div>
                  <span className="field-help">{props.keyStatus.source === "env" ? t("settings.keyFromEnv") : t("settings.keyHelp")}</span>
                  {clearKey && <span className="field-warn">{t("settings.keyWillClear")}</span>}
                  {hasStoredKey && (
                    <div>
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => {
                          setClearKey((v) => !v);
                          setNewKey("");
                        }}
                      >
                        {t(clearKey ? "settings.keepKey" : "settings.clearKey")}
                      </button>
                    </div>
                  )}
                  {props.keyStatus.problem && <span className="field-error">{of(props.keyStatus.problem)}</span>}
                </div>
              </section>
              <section className="settings-group">
                <h3 className="group-label">{t("settings.group.models")}</h3>
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
                    <select
                      value={row.thinking.includes(draft["openai.thinking.chat"]) ? draft["openai.thinking.chat"] : row.defaultThinking}
                      onChange={(e) => set("openai.thinking.chat", e.target.value)}
                    >
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
                <label className="field">
                  <span className="field-label">{t("settings.drafts")}</span>
                  <select value={draft["openai.drafts"]} onChange={(e) => set("openai.drafts", Number(e.target.value))}>
                    {DRAFT_COUNTS.map((count) => (
                      <option key={count} value={count}>
                        {t(`settings.drafts.${count}`)}
                      </option>
                    ))}
                  </select>
                  <span className="field-help">{t("settings.draftsHelp")}</span>
                </label>
              </section>
            </>
          )}
        </div>
      </Modal>
      {confirmDiscard && (
        <ConfirmModal
          title={t("discard.title")}
          body={t("discard.body")}
          cancelLabel={t("discard.keep")}
          confirmLabel={t("discard.confirm")}
          onClose={() => setConfirmDiscard(false)}
          onConfirm={async () => {
            props.onClose();
            return null;
          }}
        />
      )}
    </>
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
