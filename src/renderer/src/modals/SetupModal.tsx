// First run, in order: the OpenAI key, then the folder chats live in. Each
// step asks one thing; a skipped step writes nothing, and both stay
// changeable in Settings (config-sets-conventions, first-run setup).
import { useState } from "react";
import type { BootInfo, KeyStatus } from "../../../shared/api.ts";
import type { Message } from "../../../shared/i18n/translator.ts";
import type { Settings } from "../../../shared/settings.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Modal } from "./Modal.tsx";

interface SetupModalProps {
  boot: BootInfo;
  settings: Settings;
  keyStatus: KeyStatus;
  onDone: (settings: Settings, key: KeyStatus) => void;
}

export function SetupModal(props: SetupModalProps) {
  const { t, of } = useI18n();
  const [step, setStep] = useState<"key" | "folder">("key");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState(props.keyStatus);
  const [folder, setFolder] = useState(props.settings.chatsDir || props.boot.suggestedChatsDir);
  const [failure, setFailure] = useState<Message | null>(null);
  const [working, setWorking] = useState(false);

  const saveKey = async () => {
    setWorking(true);
    setFailure(null);
    const outcome = await api.setKey(key);
    setWorking(false);
    if (!outcome.ok) {
      setFailure(outcome.failure.message);
      return;
    }
    setStatus(outcome.status);
    setStep("folder");
  };

  const saveFolder = async () => {
    setWorking(true);
    setFailure(null);
    const next = { ...props.settings, chatsDir: folder };
    const outcome = await api.saveSettings(next);
    setWorking(false);
    if (!outcome.ok) {
      setFailure(outcome.failure.message);
      return;
    }
    props.onDone(outcome.settings, status);
  };

  const skip = () => props.onDone(props.settings, status);

  if (step === "key") {
    const fromEnv = status.source === "env";
    return (
      <Modal
        title={t("setup.keyTitle")}
        width={480}
        onClose={skip}
        intro={t("setup.intro")}
        footer={
          <>
            <span className="step-count">{t("setup.step", { index: 1, total: 2 })}</span>
            <span className="spacer" />
            {fromEnv ? (
              <button type="button" className="button primary" data-autofocus="true" onClick={() => setStep("folder")}>
                {t("setup.next")}
              </button>
            ) : (
              <>
                <button type="button" className="button" onClick={() => setStep("folder")}>
                  {t("setup.skip")}
                </button>
                <button type="button" className="button primary" disabled={!key.trim() || working} onClick={() => void saveKey()}>
                  {t("setup.saveKey")}
                </button>
              </>
            )}
          </>
        }
      >
        {fromEnv ? (
          <p>{t("setup.keyFromEnv")}</p>
        ) : (
          <label className="field">
            <span className="field-label">{t("settings.apiKey")}</span>
            <input data-autofocus="true" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder={t("settings.apiKeyPlaceholder")} />
            <span className="field-help">{t("setup.keyHelp")}</span>
          </label>
        )}
        {failure && <p className="field-error" role="alert">{of(failure)}</p>}
      </Modal>
    );
  }

  return (
    <Modal
      title={t("setup.folderTitle")}
      width={480}
      onClose={skip}
      footer={
        <>
          <span className="step-count">{t("setup.step", { index: 2, total: 2 })}</span>
          <span className="spacer" />
          <button type="button" className="button" onClick={() => setStep("key")}>
            {t("setup.back")}
          </button>
          <button type="button" className="button primary" data-autofocus="true" disabled={!folder || working} onClick={() => void saveFolder()}>
            {t("setup.useFolder")}
          </button>
        </>
      }
    >
      <p>{t("setup.folderBody")}</p>
      <div className="path-row">
        <span className="path-value" title={folder}>
          <bdi dir="ltr">{folder}</bdi>
        </span>
        <button
          type="button"
          className="button"
          onClick={async () => {
            const picked = await api.pickFolder(folder);
            if (picked) setFolder(picked);
          }}
        >
          {t("settings.choose")}
        </button>
      </div>
      {failure && <p className="field-error" role="alert">{of(failure)}</p>}
    </Modal>
  );
}
