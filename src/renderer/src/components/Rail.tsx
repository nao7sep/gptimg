// The chat rail: a contact sheet. Each row leads with its latest print, so
// a chat is found by its picture. One tab stop: a listbox whose active row
// moves with the arrow keys (composite-control-conventions).
import { useEffect, useRef, useState } from "react";
import { imageUrl, type AppFailure, type MenuCommand } from "../../../shared/api.ts";
import { PANES, railWidth } from "../../../shared/layout.ts";
import type { ChatSummary } from "../../../shared/chat.ts";
import { RAIL_WIDTH } from "../../../shared/ui-state.ts";
import type { Running } from "../App.tsx";
import { useI18n } from "../i18n.tsx";
import { useSettledSave } from "../settled-save.ts";
import { AppMenu } from "./AppMenu.tsx";
import { FrameIcon, PlusIcon } from "./icons.tsx";
import { relativeDay } from "./time.ts";

interface RailProps {
  chats: ChatSummary[];
  currentId: string;
  running: Record<string, Running>;
  unreadable: number;
  failure: AppFailure | null;
  chatsDir: string;
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
  const { chats, currentId } = props;
  const list = useRef<HTMLDivElement>(null);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [drag, setDrag] = useState<number | null>(null);
  // Keyboard steps show at once and save once the stepping pauses.
  const [stepped, setStepped] = useState<number | null>(null);
  const steps = useSettledSave((next: number) => {
    props.onWidth(next);
    setStepped(null);
  });

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const width = railWidth(drag ?? stepped ?? props.width, windowWidth, props.imagesPane);
  const activeIndex = chats.findIndex((s) => s.id === currentId);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`chat-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (chats.length === 0) return;
    const move = (index: number) => {
      event.preventDefault();
      const next = chats[Math.max(0, Math.min(chats.length - 1, index))];
      if (next && next.id !== currentId) props.onOpen(next.id);
    };
    const current = chats[activeIndex];
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
        move(chats.length - 1);
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
    steps.flush();
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
      setStepped(next);
      steps.push(next);
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
          className="chat-list"
          role="listbox"
          tabIndex={0}
          aria-label={t("rail.chats")}
          aria-activedescendant={activeIndex >= 0 ? `chat-${activeIndex}` : undefined}
          onKeyDown={onKeyDown}
        >
          {chats.map((chat, index) => {
            const isRunning = !!props.running[chat.id];
            const cover = chat.cover ? `${props.chatsDir}/${chat.id}/${chat.cover}` : null;
            return (
              <div
                key={chat.id}
                id={`chat-${index}`}
                role="option"
                aria-selected={chat.id === currentId}
                className={`chat-row${chat.id === currentId ? " selected" : ""}`}
                onClick={() => props.onOpen(chat.id)}
                onDoubleClick={() => props.onRename(chat.id, chat.title)}
              >
                <span className="chat-cover" style={{ width: THUMB, height: THUMB }}>
                  {cover ? <img src={imageUrl(cover, THUMB * 2)} alt="" draggable={false} /> : <FrameIcon size={22} />}
                  {isRunning && <span className="chat-working" aria-hidden="true" />}
                </span>
                <span className="chat-text">
                  <span className="chat-title">{chat.title || t("rail.untitled")}</span>
                  <span className="chat-meta">
                    {isRunning
                      ? t("rail.working")
                      : chat.imageCount > 0
                        ? t("rail.meta", { when: relativeDay(chat.updatedAt, props.timeZone, translator), count: chat.imageCount })
                        : relativeDay(chat.updatedAt, props.timeZone, translator)}
                  </span>
                </span>
              </div>
            );
          })}
          {chats.length === 0 && !props.failure && <p className="rail-empty">{t("rail.empty")}</p>}
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
        onBlur={steps.flush}
      />
    </>
  );
}
