// The Records window: everything GptImg recorded, newest first. A filter
// block (search, launch, chat, kind, level) over a keyboard-navigable list,
// a splitter, and the chosen record whole: its fields and its JSON.
//
// The list reads 100 records a page, newest first. The next page loads when
// what is left below the visible part is no taller than the visible part, and
// again while the list does not fill the window. New records appear only while
// the list is at its top (scroll offset under 1); scrolled away, nothing moves,
// including a newest page already being read, and they appear once the list
// is back at the top. The selection and its detail stay put meanwhile. Every
// measurement is the list's own scroll offset, visible height and content height.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const atTop = (el: HTMLElement) => el.scrollTop < 1;
const nearEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= el.clientHeight;

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
  // The list as the reads left it, for the next read to build on before React renders.
  const loaded = useRef<{ rows: RecordRow[]; next: RecordCursor | null }>({ rows: [], next: null });
  const show = useCallback((shown: RecordRow[], cursor: RecordCursor | null) => {
    loaded.current = { rows: shown, next: cursor };
    setRows(shown);
  }, []);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecordDetail | null | "loading" | "failed">(null);
  const [width, setWidth] = useState(boot.state.recordsListWidth ?? RECORDS_LIST_WIDTH.initial);
  const list = useRef<HTMLDivElement>(null);
  // The window's one reader runs its reads one at a time. IPC cannot be cancelled,
  // so a result checks the list token or the detail token it was asked under:
  // the list token changes when the filters replace the list or a page extends
  // it, the detail token when another record is chosen or the list is replaced.
  const reader = useRef<Promise<unknown>>(Promise.resolve());
  const listToken = useRef(0);
  const detailToken = useRef(0);
  // New records were stored while the list was away from its top.
  const waiting = useRef(false);
  const read = useCallback((job: () => Promise<void>) => {
    reader.current = reader.current.then(job, job);
  }, []);

  useEffect(() => {
    applyFonts(settings);
    document.title = t("records.title");
  }, [settings, t]);

  useEffect(() => api.onSettings(setSettings), []);

  useEffect(() => {
    const refreshChats = () => read(async () => {
      try {
        setChats(await api.recordChats());
      } catch {
        setState("failed");
      }
    });
    refreshChats();
    return api.onSessionsChanged(refreshChats);
  }, [read]);

  useEffect(() => {
    const refreshLaunches = () => read(async () => {
      try {
        setLaunches(await api.recordLaunches());
      } catch {
        setState("failed");
      }
    });
    refreshLaunches();
    return api.onRecordsChanged(refreshLaunches);
  }, [read]);

  // Search waits for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo(
    () => ({ ...(query.trim() && { search: query }), ...(launch && { launch }), ...(chatId && { chatId }), ...(kind && { kind }), ...(level && { level }) }),
    [query, launch, chatId, kind, level],
  );
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const choose = useCallback((row: RecordRow) => {
    const token = ++detailToken.current;
    setSelected(keyOf(row));
    setDetail("loading");
    read(async () => {
      if (token !== detailToken.current) return;
      try {
        const found = await api.recordDetail({ source: row.source, id: row.id });
        if (token === detailToken.current) setDetail(found ?? "failed");
      } catch {
        if (token === detailToken.current) setDetail("failed");
      }
    });
  }, [read]);

  // A failed query that still returned rows shows them beside the warning.
  const loadFirst = useCallback(() => {
    const token = ++listToken.current;
    read(async () => {
      if (token !== listToken.current) return;
      try {
        const page = await api.queryRecords(filters);
        if (token !== listToken.current) return;
        if (page.failed && page.rows.length === 0) {
          setState("failed");
          return;
        }
        show(page.rows, page.next);
        setState(page.failed ? "failed" : "ready");
      } catch {
        if (token === listToken.current) setState("failed");
      }
    });
  }, [filters, read, show]);

  useEffect(() => {
    ++detailToken.current;
    setSelected(null);
    setDetail(null);
    show([], null);
    setState("loading");
    waiting.current = false;
    if (list.current) list.current.scrollTop = 0;
    loadFirst();
    return () => {
      ++listToken.current;
      ++detailToken.current;
    };
  }, [loadFirst, show]);

  // The newest page joins the top. A page that shares no record with the list
  // while more lie beyond it may leave a gap, so it replaces the list instead.
  // It asks under the token current when it runs, so a page extending the list
  // meanwhile does not drop it; only a filter change does.
  const readNewest = useCallback(() => {
    read(async () => {
      if (filters !== filtersRef.current) return;
      const token = listToken.current;
      try {
        const page = await api.queryRecords(filters);
        if (token !== listToken.current) return;
        if (!list.current || !atTop(list.current)) {
          waiting.current = true;
          return;
        }
        const current = loaded.current;
        const shown = new Set(current.rows.map(keyOf));
        if (current.rows.length > 0 && page.next && !page.rows.some((row) => shown.has(keyOf(row)))) {
          ++listToken.current;
          show(page.rows, page.next);
        } else {
          const fresh = new Set(page.rows.map(keyOf));
          show([...page.rows, ...current.rows.filter((row) => !fresh.has(keyOf(row)))], current.next);
        }
        setState(page.failed ? "failed" : "ready");
      } catch {
        if (token === listToken.current) setState("failed");
      }
    });
  }, [filters, read, show]);

  useEffect(
    () =>
      api.onRecordsChanged(() => {
        if (list.current && atTop(list.current)) readNewest();
        else waiting.current = true;
      }),
    [readNewest],
  );

  // Scrolling asks for the next page many times; the first to run extends the list and the rest find their token old.
  const loadMore = useCallback(() => {
    const cursor = loaded.current.next;
    if (!cursor) return;
    const token = listToken.current;
    read(async () => {
      if (token !== listToken.current) return;
      try {
        const page = await api.queryRecords({ ...filters, cursor });
        if (token !== listToken.current) return;
        ++listToken.current;
        const fresh = new Set(page.rows.map(keyOf));
        show([...loaded.current.rows.filter((row) => !fresh.has(keyOf(row))), ...page.rows], page.next);
        setState(page.failed ? "failed" : "ready");
      } catch {
        if (token === listToken.current) setState("failed");
      }
    });
  }, [filters, read, show]);

  const onListScroll = () => {
    const el = list.current;
    if (!el) return;
    if (waiting.current && atTop(el)) {
      waiting.current = false;
      readNewest();
    }
    if (nearEnd(el)) loadMore();
  };

  // A page, or a taller window, that leaves the list short of filling it asks for the next.
  useEffect(() => {
    const fill = () => {
      if (state === "ready" && list.current && nearEnd(list.current)) loadMore();
    };
    fill();
    window.addEventListener("resize", fill);
    return () => window.removeEventListener("resize", fill);
  }, [rows, state, loadMore]);

  const index = rows.findIndex((row) => keyOf(row) === selected);
  const onListKey = (event: React.KeyboardEvent) => {
    const go = (i: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!row) return;
      event.preventDefault();
      choose(row);
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
  const when = useCallback(
    (iso: string) =>
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
      }),
    [translator, zone],
  );
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
          onScroll={onListScroll}
        >
          {state === "loading" && <p className="records-state">{t("records.loading")}</p>}
          {state === "failed" && <p role="alert" className="records-state problem">{t("records.failed")}</p>}
          {state === "ready" && rows.length === 0 && <p className="records-state">{t("records.empty")}</p>}
          {rows.map((row) => (
            <RecordCard key={keyOf(row)} row={row} selected={keyOf(row) === selected} when={when} onChoose={choose} />
          ))}
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

// A card renders again only when its own record, selection or time format changes,
// so a list of thousands stays cheap as new records join it.
const RecordCard = memo(function RecordCard(props: { row: RecordRow; selected: boolean; when: (iso: string) => string; onChoose: (row: RecordRow) => void }) {
  const { t } = useI18n();
  const { row, selected } = props;
  return (
    <div
      id={`record-${keyOf(row)}`}
      role="option"
      aria-selected={selected}
      className={`record-card${selected ? " selected" : ""}`}
      onClick={() => props.onChoose(row)}
    >
      <div className="record-line">
        <span className="record-time">{props.when(row.at)}</span>
        <span className={`pill level-${row.level}`}>{t(`records.level.${row.level}`)}</span>
        {row.kind === "call" && <span className="pill">{t("records.kind.call")}</span>}
      </div>
      <div className="record-title">{row.title}</div>
      {row.text && <div className="record-text">{row.text}</div>}
    </div>
  );
});

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
