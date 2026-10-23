// The session rail: a contact sheet. Each row leads with its latest print, so
// a session is found by its picture. One tab stop: a listbox whose active row
// moves with the arrow keys (composite-control-conventions).
import { useEffect, useMemo, useRef, useState } from "react";
import { imageUrl, type AppFailure, type MenuCommand } from "../../../shared/api.ts";
import { PANES, railWidth } from "../../../shared/layout.ts";
import type { SessionSummary } from "../../../shared/session.ts";
import { RAIL_WIDTH } from "../../../shared/ui-state.ts";
import type { Running } from "../App.tsx";
import { useI18n } from "../i18n.tsx";
import { AppMenu } from "./AppMenu.tsx";
import { FrameIcon, PlusIcon } from "./icons.tsx";
import { relativeDay } from "./time.ts";
import { useWindowedItems } from "./use-windowed-items.ts";

interface RailProps {
  sessions: SessionSummary[];
  currentId: string;
  running: Record<string, Running>;
  unreadable: number;
  failure: AppFailure | null;
  sessionsDir: string;
  timeZone: string;
  width: number | null;
  imagesPane?: boolean;
  onWidth: (width: number) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTrash: (id: string, title: string) => void;
  mac: boolean;
  onMenu: (command: MenuCommand | "chatsFolder") => void;
}

const THUMB = 44;

export function Rail(props: RailProps) {
  const { t, of, translator } = useI18n();
  const { sessions, currentId } = props;
  const list = useRef<HTMLDivElement>(null);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [drag, setDrag] = useState<number | null>(null);
  const items = useMemo(() => sessions.map(({ id }) => ({ id, estimatedHeight: 68 })), [sessions]);
  const windowed = useWindowedItems(items, list, props.sessionsDir, true);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const width = railWidth(drag ?? props.width, windowWidth, props.imagesPane);
  const activeIndex = sessions.findIndex((s) => s.id === currentId);

  useEffect(() => {
    if (activeIndex < 0) return;
    windowed.scrollToIndex(activeIndex);
  }, [activeIndex, windowed.scrollToIndex]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (sessions.length === 0) return;
    const move = (index: number) => {
      event.preventDefault();
      const next = sessions[Math.max(0, Math.min(sessions.length - 1, index))];
      windowed.scrollToIndex(Math.max(0, Math.min(sessions.length - 1, index)));
      if (next && next.id !== currentId) props.onOpen(next.id);
    };
    const current = sessions[activeIndex];
    switch (event.key) {
      case "ArrowDown":
        move(activeIndex < 0 ? 0 : activeIndex + 1);
        break;
      case "ArrowUp":
        move(activeIndex < 0 ? 0 : activeIndex - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(sessions.length - 1);
        break;
      case "F2":
        if (current) {
          event.preventDefault();
          props.onRename(current.id, current.title);
        }
        break;
      case "Delete":
      case "Backspace":
        if (current && (event.key === "Delete" || event.metaKey)) {
          event.preventDefault();
          props.onTrash(current.id, current.title);
        }
        break;
    }
  };

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    let latest = startWidth;
    const onMove = (e: PointerEvent) => {
      latest = Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, startWidth + e.clientX - startX));
      setDrag(latest);
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      setDrag(null);
      // Only a drag saves, and it saves the intent, not a clamp the window imposed.
      if (latest !== startWidth) props.onWidth(latest);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };

  const onSplitterKey = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, width + (event.key === "ArrowRight" ? step : -step)));
      props.onWidth(next);
    }
  };

  return (
    <>
      <nav className="rail" style={{ width }} aria-label={t("rail.label")}>
        <div className="rail-top">
          <span className="app-name">GptImg</span>
          <button type="button" className="icon-button" onClick={props.onNew} aria-label={t("rail.new")} title={t("rail.new")}>
            <PlusIcon />
          </button>
          <AppMenu mac={props.mac} onCommand={props.onMenu} />
        </div>
        <div
          ref={list}
          className="session-list"
          role="listbox"
          tabIndex={0}
          aria-label={t("rail.sessions")}
          aria-activedescendant={activeIndex >= windowed.start && activeIndex < windowed.end ? `session-${activeIndex}` : undefined}
          onKeyDown={onKeyDown}
        >
          <div ref={windowed.startRef} aria-hidden="true" style={{ height: windowed.top }} />
          {sessions.slice(windowed.start, windowed.end).map((session, visibleIndex) => {
            const index = windowed.start + visibleIndex;
            const isRunning = !!props.running[session.id];
            const cover = session.cover ? `${props.sessionsDir}/${session.id}/${session.cover}` : null;
            return (
              <div
                key={session.id}
                ref={windowed.measureRef(session.id)}
                aria-setsize={sessions.length}
                aria-posinset={index + 1}
                id={`session-${index}`}
                role="option"
                aria-selected={session.id === currentId}
                className={`session-row${session.id === currentId ? " selected" : ""}`}
                onClick={() => props.onOpen(session.id)}
                onDoubleClick={() => props.onRename(session.id, session.title)}
              >
                <span className="session-cover" style={{ width: THUMB, height: THUMB }}>
                  {cover ? <img src={imageUrl(cover, THUMB * 2)} alt="" draggable={false} /> : <FrameIcon size={22} />}
                  {isRunning && <span className="session-working" aria-hidden="true" />}
                </span>
                <span className="session-text">
                  <span className="session-title">{session.title || t("rail.untitled")}</span>
                  <span className="session-meta">
                    {isRunning
                      ? t("rail.working")
                      : session.imageCount > 0
                        ? t("rail.meta", { when: relativeDay(session.updatedAt, props.timeZone, translator), count: session.imageCount })
                        : relativeDay(session.updatedAt, props.timeZone, translator)}
                  </span>
                </span>
              </div>
            );
          })}
          <div aria-hidden="true" style={{ height: windowed.bottom }} />
          {sessions.length === 0 && !props.failure && <p className="rail-empty">{t("rail.empty")}</p>}
          {props.failure && <p className="rail-problem" role="alert">{of(props.failure.message)}</p>}
          {props.unreadable > 0 && <p className="rail-note">{t("rail.unreadable", { count: props.unreadable })}</p>}
        </div>
      </nav>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={RAIL_WIDTH.min}
        aria-valuemax={RAIL_WIDTH.max}
        aria-valuenow={width}
        aria-label={t("rail.resize")}
        tabIndex={0}
        style={{ width: PANES.splitter.width }}
        onPointerDown={startDrag}
        onKeyDown={onSplitterKey}
      />
    </>
  );
}
