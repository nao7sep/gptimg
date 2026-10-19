// The small dialogs: About, Shortcuts, Rename and a confirmation. Each is the
// shared shell with its own body.
import { useState } from "react";
import type { AppFailure } from "../../../shared/api.ts";
import { LOCAL_KEYS, SHORTCUTS, displayKeys } from "../../../shared/shortcuts.ts";
import { useI18n } from "../i18n.tsx";
import iconUrl from "../assets/icon.png";
import { Modal } from "./Modal.tsx";

export function AboutModal({ version, onClose }: { version: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t("about.title")} width={380} onClose={onClose}>
      <div className="about">
        <img className="about-icon" src={iconUrl} alt="" width={88} height={88} draggable={false} />
        <p className="about-name">GptImg</p>
        <p className="about-version">{t("about.version", { version })}</p>
        <p>{t("about.description")}</p>
        <p className="about-licence">{t("about.licence")}</p>
        <p className="about-copyright">© Yoshinao Inoguchi</p>
      </div>
    </Modal>
  );
}

function Keys({ keys }: { keys: readonly string[] }) {
  const { t } = useI18n();
  return (
    <span className="keys">
      {keys.map((key) => (
        <kbd key={key}>{keyName(key, t)}</kbd>
      ))}
    </span>
  );
}

const KEY_NAMES = ["Cmd", "Ctrl", "Shift", "Enter", "Escape", "Up", "Down", "Comma", "Slash"] as const;

function keyName(key: string, t: ReturnType<typeof useI18n>["t"]): string {
  return (KEY_NAMES as readonly string[]).includes(key) ? t(`keys.${key as (typeof KEY_NAMES)[number]}`) : key;
}

export function ShortcutsModal({ mac, onClose }: { mac: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t("shortcuts.title")} width={440} onClose={onClose}>
      <dl className="shortcut-list">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.command} className="shortcut-row">
            <dt>{t(shortcut.label)}</dt>
            <dd>
              <Keys keys={displayKeys(shortcut.accelerator, mac)} />
            </dd>
          </div>
        ))}
        {LOCAL_KEYS.map((entry) => (
          <div key={entry.label} className="shortcut-row">
            <dt>{t(entry.label)}</dt>
            <dd>
              <Keys keys={entry.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

export function RenameModal({
  title,
  onClose,
  onRename,
}: {
  title: string;
  onClose: () => void;
  onRename: (title: string) => Promise<AppFailure | null>;
}) {
  const { t, of } = useI18n();
  const [value, setValue] = useState(title);
  const [failure, setFailure] = useState<AppFailure | null>(null);
  const [working, setWorking] = useState(false);
  const submit = async () => {
    if (!value.trim() || working) return;
    setWorking(true);
    setFailure(await onRename(value.trim()));
    setWorking(false);
  };
  return (
    <Modal
      title={t("rename.title")}
      width={420}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button primary" disabled={!value.trim() || working} onClick={() => void submit()}>
            {t("rename.confirm")}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{t("rename.label")}</span>
        <input
          data-autofocus="true"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) void submit();
          }}
        />
        <span className="field-help">{t("rename.help")}</span>
      </label>
      {failure && (
        <p className="field-error" role="alert">
          {of(failure.message)}
        </p>
      )}
    </Modal>
  );
}

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<AppFailure | null>;
}) {
  const { t, of } = useI18n();
  const [failure, setFailure] = useState<AppFailure | null>(null);
  const [working, setWorking] = useState(false);
  return (
    <Modal
      title={title}
      width={420}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" data-autofocus="true" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="button danger"
            data-destructive="true"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              setFailure(await onConfirm());
              setWorking(false);
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{body}</p>
      {failure && (
        <p className="field-error" role="alert">
          {of(failure.message)}
        </p>
      )}
    </Modal>
  );
}
