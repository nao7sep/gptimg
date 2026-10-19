// Records: what GptImg wrote to records.sqlite3, newest first. The app's own
// activity, each OpenAI call's outcome with its tokens, and the image
// engine's events; this launch or every launch; one chat or all. A row opens
// to the whole record. Event names and messages are diagnostic text and stay
// as recorded.
import { useCallback, useEffect, useState } from "react";
import { RECORD_KINDS, type RecordDetail, type RecordKind, type RecordRow } from "../../../shared/records.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Modal } from "./Modal.tsx";

interface RecordsModalProps {
  /** The open chat's lasting id, when a chat is open. */
  chatId: string | null;
  timeZone: string;
  onClose: () => void;
}

export function RecordsModal({ chatId, timeZone, onClose }: RecordsModalProps) {
  const { t, translator } = useI18n();
  const [kind, setKind] = useState<RecordKind>("log");
  const [scope, setScope] = useState<"launch" | "all">("launch");
  const [thisChat, setThisChat] = useState(false);
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [more, setMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState<RecordDetail | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    async (beforeId?: number) => {
      const page = await api.queryRecords({ kind, scope, ...(thisChat && chatId && { chatId }), ...(beforeId !== undefined && { beforeId }) });
      setUnavailable(page.unavailable);
      setMore(page.more);
      setRows((current) => (beforeId === undefined ? page.rows : [...current, ...page.rows]));
    },
    [kind, scope, thisChat, chatId],
  );

  useEffect(() => {
    setOpen(null);
    void load();
  }, [load]);

  const toggle = async (row: RecordRow) => {
    if (open?.id === row.id) {
      setOpen(null);
      return;
    }
    setCopied(false);
    setOpen(await api.recordDetail(kind, row.id));
  };

  const when = (iso: string) => translator.dateTime(iso, timeZone, { dateStyle: "short", timeStyle: "medium" });
  const detailText = open ? JSON.stringify({ ...open.columns, record: open.body }, null, 2) : "";

  return (
    <Modal title={t("records.title")} width={760} onClose={onClose} intro={t("records.intro")}>
      <div className="records-bar">
        <div className="segmented" role="radiogroup" aria-label={t("records.kind")}>
          {RECORD_KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {t(`records.kind.${k}`)}
            </button>
          ))}
        </div>
        <label className="records-scope">
          <span className="visually-hidden">{t("records.scope")}</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as "launch" | "all")}>
            <option value="launch">{t("records.scope.launch")}</option>
            <option value="all">{t("records.scope.all")}</option>
          </select>
        </label>
        {chatId && (
          <label className="check">
            <input type="checkbox" checked={thisChat} onChange={(e) => setThisChat(e.target.checked)} />
            <span>{t("records.thisChat")}</span>
          </label>
        )}
      </div>

      {unavailable && <p className="notice notice-warn">{t("records.unavailable")}</p>}
      {!unavailable && rows.length === 0 && <p className="muted">{t("records.empty")}</p>}

      <ol className="records-list">
        {rows.map((row) => (
          <li key={row.id} className={`record level-${row.level}${open?.id === row.id ? " open" : ""}`}>
            <button type="button" className="record-row" aria-expanded={open?.id === row.id} onClick={() => void toggle(row)}>
              <span className="record-time">{when(row.at)}</span>
              <span className="record-level">{row.level}</span>
              <span className="record-event">{row.event}</span>
              <span className="record-summary">
                {row.summary}
                {row.tokens && row.tokens.input !== null && (
                  <span className="record-tokens"> {t("records.tokens", { input: row.tokens.input, output: row.tokens.output ?? 0 })}</span>
                )}
              </span>
            </button>
            {open?.id === row.id && (
              <div className="record-detail">
                <div className="record-detail-bar">
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      void navigator.clipboard.writeText(detailText).then(() => setCopied(true));
                    }}
                  >
                    {t(copied ? "print.copied" : "records.copy")}
                  </button>
                </div>
                <pre>{detailText}</pre>
              </div>
            )}
          </li>
        ))}
      </ol>
      {more && (
        <button type="button" className="button records-more" onClick={() => void load(rows[rows.length - 1]?.id)}>
          {t("records.more")}
        </button>
      )}
    </Modal>
  );
}
