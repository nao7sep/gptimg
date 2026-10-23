// The Records window: everything GptImg recorded, newest first. A filter
// block (search, launch, chat, kind, level) over a keyboard-navigable list,
// a splitter, and the chosen record whole: its fields and its JSON. New
// records arrive while the list is at the top; scrolled away, they wait.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BootInfo } from "../../../shared/api.ts";
import {
  RECORD_KINDS,
  RECORD_LEVELS,
  type LaunchEntry,
  type RecordCursor,
  type RecordDetail,
  type RecordKind,
  type RecordLevel,
  type RecordRow,
} from "../../../shared/records.ts";
import { RECORDS_LIST_WIDTH } from "../../../shared/ui-state.ts";
import { api } from "../api.ts";
import { applyFonts } from "../fonts.ts";
import { useI18n } from "../i18n.tsx";

type LevelFilter = RecordLevel | "attention" | "";

const keyOf = (row: { source: string; id: number }) => `${row.source}:${row.id}`;

export function RecordsWindow({ boot }: { boot: BootInfo }) {
  const { t, translator } = useI18n();
  const [settings, setSettings] = useState(boot.settings);
  const zone = settings.timeZone;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [launch, setLaunch] = useState("");
  const [chatId, setChatId] = useState("");
  const [kind, setKind] = useState<RecordKind | "">("");
  const [level, setLevel] = useState<LevelFilter>("");
  const [launches, setLaunches] = useState<LaunchEntry[]>([]);
  const [chats, setChats] = useState<{ id: string; title: string }[]>([]);
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [cursors, setCursors] = useState<Array<RecordCursor | undefined>>([undefined]);
  const [next, setNext] = useState<RecordCursor | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecordDetail | null | "loading" | "failed">(null);
  const [width, setWidth] = useState(boot.state.recordsListWidth ?? RECORDS_LIST_WIDTH.initial);
  const list = useRef<HTMLDivElement>(null);
  const queryGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    applyFonts(settings);
    document.title = t("records.title");
  }, [settings, t]);

  useEffect(() => api.onSettings(setSettings), []);

  useEffect(() => {
    let active = true;
    let chatsGeneration = 0;
    const refreshChats = async () => {
      const generation = ++chatsGeneration;
      try {
        const found = await api.recordChats();
        if (active && generation === chatsGeneration) setChats(found);
      } catch {
        if (active && generation === chatsGeneration) setState("failed");
      }
    };
    void refreshChats();
    const unsubscribe = api.onSessionsChanged(() => void refreshChats());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let launchesGeneration = 0;
    const refreshLaunches = async () => {
      const generation = ++launchesGeneration;
      try {
        const found = await api.recordLaunches();
        if (active && generation === launchesGeneration) setLaunches(found);
      } catch {
        if (active && generation === launchesGeneration) setState("failed");
      }
    };
    void refreshLaunches();
    const unsubscribe = api.onRecordsChanged(() => void refreshLaunches());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Search waits for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo(
    () => ({ ...(query.trim() && { search: query }), ...(launch && { launch }), ...(chatId && { chatId }), ...(kind && { kind }), ...(level && { level }) }),
    [query, launch, chatId, kind, level],
  );

  const choose = useCallback(async (row: RecordRow) => {
    const generation = ++detailGeneration.current;
    const pageGeneration = queryGeneration.current;
    const key = keyOf(row);
    selectedRef.current = key;
    setSelected(key);
    setDetail("loading");
    try {
      const found = await api.recordDetail({ source: row.source, id: row.id });
      if (generation === detailGeneration.current && pageGeneration === queryGeneration.current) setDetail(found ?? "failed");
    } catch {
      if (generation === detailGeneration.current && pageGeneration === queryGeneration.current) setDetail("failed");
    }
  }, []);

  const loadPage = useCallback(async (stack: Array<RecordCursor | undefined>, reset = false) => {
    const generation = ++queryGeneration.current;
    ++detailGeneration.current;
    setDetail(null);
    if (reset) {
      selectedRef.current = null;
      setSelected(null);
    }
    setState("loading");
    try {
      const cursor = stack[stack.length - 1];
      const page = await api.queryRecords({ ...filters, ...(cursor && { cursor }) });
      if (generation !== queryGeneration.current) return;
      if (page.failed && page.rows.length === 0) {
        setState("failed");
        return;
      }
      setRows(page.rows);
      setNext(page.next);
      setCursors(stack);
      setState(page.failed ? "failed" : "ready");
      const kept = page.rows.find((row) => keyOf(row) === selectedRef.current);
      if (kept) void choose(kept);
      else {
        ++detailGeneration.current;
        selectedRef.current = null;
        setSelected(null);
        setDetail(null);
      }
    } catch {
      if (generation === queryGeneration.current) setState("failed");
    }
  }, [filters, choose]);

  useEffect(() => {
    setRows([]);
    setNext(null);
    setCursors([undefined]);
    if (list.current) list.current.scrollTop = 0;
    void loadPage([undefined], true);
    return () => {
      ++queryGeneration.current;
      ++detailGeneration.current;
    };
  }, [loadPage]);

  // Only the first page follows live records, and only while the reader is at its top.
  useEffect(() => api.onRecordsChanged(() => {
    if (cursors.length !== 1 || (list.current?.scrollTop ?? 0) > 8) return;
    void loadPage([undefined]);
  }), [cursors.length, loadPage]);

  const browse = (stack: Array<RecordCursor | undefined>) => {
    if (list.current) list.current.scrollTop = 0;
    void loadPage(stack, true);
  };

  const index = rows.findIndex((row) => keyOf(row) === selected);
  const onListKey = (event: React.KeyboardEvent) => {
    const go = (i: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!row) return;
      event.preventDefault();
      void choose(row);
      document.getElementById(`record-${keyOf(row)}`)?.scrollIntoView?.({ block: "nearest" });
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(rows.length - 1);
    else if (event.key === "PageDown") go(index + 10);
    else if (event.key === "PageUp") go(index - 10);
  };

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const start = width;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    let latest = start;
    const move = (e: PointerEvent) => {
      latest = Math.max(RECORDS_LIST_WIDTH.min, Math.min(RECORDS_LIST_WIDTH.max, start + e.clientX - startX));
      setWidth(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (latest !== start) api.saveRecordsLayout(latest);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  // Times to the millisecond; Intl takes either the style options or the fields, never both.
  const when = (iso: string) =>
    translator.dateTime(iso, zone, {
      dateStyle: undefined,
      timeStyle: undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
  const launchLabel = (entry: LaunchEntry) =>
    entry.current ? t("records.launch.current", { time: when(entry.startedAt) }) : t("records.launch.entry", { time: when(entry.startedAt) });
  const chatTitle = (id: string | null) => (id ? (chats.find((c) => c.id === id)?.title ?? id) : null);

  return (
    <div className="records-shell">
      <aside className="records-pane" style={{ width }}>
        <div className="records-filters">
          <input type="search" value={search} placeholder={t("records.search")} aria-label={t("records.search")} onChange={(e) => setSearch(e.target.value)} />
          <div className="records-filter-row">
            <select value={launch} aria-label={t("records.field.launch")} onChange={(e) => setLaunch(e.target.value)}>
              <option value="">{t("records.launch.all")}</option>
              {launches.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {launchLabel(entry)}
                </option>
              ))}
            </select>
            <select value={chatId} aria-label={t("records.field.chat")} onChange={(e) => setChatId(e.target.value)}>
              <option value="">{t("records.chat.all")}</option>
              {chats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chat.title || t("rail.untitled")}
                </option>
              ))}
            </select>
          </div>
          <div className="records-filter-row">
            <select value={kind} aria-label={t("records.field.kind")} onChange={(e) => setKind(e.target.value as RecordKind | "")}>
              <option value="">{t("records.kind.all")}</option>
              {RECORD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`records.kind.${k}`)}
                </option>
              ))}
            </select>
            <select value={level} aria-label={t("records.field.level")} onChange={(e) => setLevel(e.target.value as LevelFilter)}>
              <option value="">{t("records.level.all")}</option>
              <option value="attention">{t("records.level.attention")}</option>
              {RECORD_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {t(`records.level.${l}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div
          ref={list}
          className="records-rows"
          role="listbox"
          tabIndex={0}
          aria-label={t("records.title")}
          aria-activedescendant={selected ? `record-${selected}` : undefined}
          onKeyDown={onListKey}
        >
          {state === "loading" && <p className="records-state">{t("records.loading")}</p>}
          {state === "failed" && <p role="alert" className="records-state problem">{t("records.failed")}</p>}
          {state === "ready" && rows.length === 0 && <p className="records-state">{t("records.empty")}</p>}
          {rows.map((row) => (
              <div
                key={keyOf(row)}
                id={`record-${keyOf(row)}`}
                role="option"
                aria-selected={keyOf(row) === selected}
                className={`record-card${keyOf(row) === selected ? " selected" : ""}`}
                onClick={() => void choose(row)}
              >
                <div className="record-line">
                  <span className="record-time">{when(row.at)}</span>
                  <span className={`pill level-${row.level}`}>{t(`records.level.${row.level}`)}</span>
                  {row.kind === "call" && <span className="pill">{t("records.kind.call")}</span>}
                </div>
                <div className="record-title">{row.title}</div>
                {row.text && <div className="record-text">{row.text}</div>}
              </div>
            ))}
        </div>
        <div className="records-pagination">
          <button type="button" disabled={state === "loading" || cursors.length === 1} onClick={() => browse(cursors.slice(0, -1))}>{t("records.newer")}</button>
          <button type="button" disabled={state === "loading" || next === null} onClick={() => next && browse([...cursors, next])}>{t("records.older")}</button>
          <button type="button" disabled={state === "loading"} onClick={() => void loadPage(cursors)}>{t("records.refresh")}</button>
        </div>
      </aside>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("records.resize")}
        aria-valuemin={RECORDS_LIST_WIDTH.min}
        aria-valuemax={RECORDS_LIST_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const next = Math.max(RECORDS_LIST_WIDTH.min, Math.min(RECORDS_LIST_WIDTH.max, width + (e.key === "ArrowRight" ? 16 : -16)));
          setWidth(next);
          api.saveRecordsLayout(next);
        }}
      />
      <section className="records-detail">
        {detail === null && <p className="records-state">{t("records.select")}</p>}
        {detail === "loading" && <p className="records-state">{t("records.loading")}</p>}
        {detail === "failed" && <p className="records-state problem">{t("records.detailFailed")}</p>}
        {detail && detail !== "failed" && detail !== "loading" && (
          <>
            <header className="records-detail-head">
              <h1>{detail.kind === "call" ? detail.title : detail.text || detail.title}</h1>
              <span className={`pill level-${detail.level}`}>{t(`records.level.${detail.level}`)}</span>
              <span className="pill">{t(`records.kind.${detail.kind}`)}</span>
            </header>
            <dl className="records-fields">
              <dt>{t("records.field.time")}</dt>
              <dd>{when(detail.at)}</dd>
              {detail.fields.map((field) => (
                <FieldRow key={field.label} label={t(`records.field.${field.label}`)} value={String(field.value)} />
              ))}
              {detail.chatId && <FieldRow label={t("records.field.chat")} value={chatTitle(detail.chatId) ?? ""} />}
              <FieldRow
                label={t("records.field.launch")}
                value={(() => {
                  const entry = launches.find((l) => l.id === detail.launchId);
                  return entry ? launchLabel(entry) : detail.launchId;
                })()}
              />
            </dl>
            {detail.blocks.map((block) => (
              <div key={block.label} className="records-block">
                <h2>{t(`records.block.${block.label}`)}</h2>
                <pre>{block.text}</pre>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
