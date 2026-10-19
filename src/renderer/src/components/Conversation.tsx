// The open session: a compact header, and the transcript as text and prints.
// No bubbles: the user's turns carry a persimmon margin rule; the assistant's
// text reads in the content font with its prints at column width.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { imageUrl, type AppFailure, type OpenedSession } from "../../../shared/api.ts";
import { sessionTotals, type AssistantTurn, type UserTurn } from "../../../shared/session.ts";
import type { Running } from "../App.tsx";
import { useI18n } from "../i18n.tsx";
import { CloseIcon, FolderIcon, PencilIcon, RetryIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { Print } from "./Print.tsx";
import { elapsed, relativeDay } from "./time.ts";

interface ConversationProps {
  session: OpenedSession | null;
  openFailure: AppFailure | null;
  running: Running | null;
  failure: AppFailure | null;
  timeZone: string;
  onCancel: () => void;
  onRetry: () => void;
  onDismissFailure: () => void;
  onRename: () => void;
  onReveal: () => void;
  onView: (images: string[], index: number) => void;
  onReuse: (relativePath: string) => void;
  onExport: (path: string) => void;
  /** The print just exported, and a count that changes with each export. */
  exported: { path: string; count: number } | null;
}

export function Conversation(props: ConversationProps) {
  const { t, of, translator } = useI18n();
  const { session, running } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // Whether the reader is at the end; prints load after layout, so the end moves.
  const pinned = useRef(true);
  const turns = session?.doc.turns ?? [];
  const totals = sessionTotals(turns);
  const absolute = (rel: string) => (session ? `${session.dir}/${rel}` : rel);
  const allImages = turns.flatMap((turn) => (turn.role === "assistant" ? turn.images.map(absolute) : []));
  const last = turns[turns.length - 1];
  const unanswered = last?.role === "user" && !running;

  // Follow the conversation: a new turn or the working card scrolls into view,
  // and the view stays at the end while prints load, unless the reader scrolled up.
  useLayoutEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, running !== null, session?.id]);

  useEffect(() => {
    const el = scroller.current;
    const inner = column.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="conversation" aria-label={t("conversation.label")}>
      <header className="conversation-head">
        {session ? (
          <>
            <button type="button" className="title-button" onClick={props.onRename} title={t("conversation.rename")}>
              <span className="title-text">{session.doc.title || t("rail.untitled")}</span>
              <PencilIcon size={14} />
            </button>
            {totals.tokens > 0 && (
              <span className="head-meta">{t("conversation.totals", { count: totals.images, tokens: totals.tokens })}</span>
            )}
            <button type="button" className="icon-button" onClick={props.onReveal} aria-label={t("conversation.reveal")} title={t("conversation.reveal")}>
              <FolderIcon />
            </button>
          </>
        ) : (
          <span className="title-text muted">{t("conversation.newTitle")}</span>
        )}
      </header>

      <div
        className="transcript"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <div className="column" ref={column}>
          {props.openFailure && (
            <div className="notice notice-error" role="alert">
              {of(props.openFailure.message)}
            </div>
          )}
          {!session && !props.openFailure && !running && (
            <div className="empty-state">
              <p className="empty-line">{t("conversation.empty")}</p>
            </div>
          )}
          {turns.map((turn, index) =>
            turn.role === "user" ? (
              <UserTurnView key={turn.id} turn={turn} absolute={absolute} timeZone={props.timeZone} onView={props.onView} />
            ) : (
              <AssistantTurnView
                key={turn.id}
                turn={turn}
                absolute={absolute}
                allImages={allImages}
                onView={props.onView}
                onReuse={props.onReuse}
                onExport={props.onExport}
                exported={props.exported}
                first={index === 0}
              />
            ),
          )}
          {running && <Developing running={running} onCancel={props.onCancel} />}
          {(unanswered || (!session && props.failure)) && (
            <div className={`no-reply${props.failure ? " has-failure" : ""}`} role={props.failure ? "alert" : undefined}>
              <div className="no-reply-text">
                <p>{props.failure ? of(props.failure.message) : t("conversation.noReply")}</p>
                {props.failure?.reason && (
                  <p className="provider-reason">
                    <span className="provider-label">{t("conversation.providerSaid")}</span> {props.failure.reason}
                  </p>
                )}
              </div>
              <div className="no-reply-actions">
                {unanswered && (
                  <button type="button" className="button" onClick={props.onRetry}>
                    <RetryIcon size={15} />
                    <span>{t("conversation.retry")}</span>
                  </button>
                )}
                {props.failure && (
                  <button type="button" className="icon-button" onClick={props.onDismissFailure} aria-label={t("common.dismiss")} title={t("common.dismiss")}>
                    <CloseIcon size={15} />
                  </button>
                )}
              </div>
            </div>
          )}
          {session && turns.length > 0 && (
            <p className="session-foot">{t("conversation.started", { when: relativeDay(session.doc.createdAt, props.timeZone, translator) })}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function UserTurnView({
  turn,
  absolute,
  onView,
}: {
  turn: UserTurn;
  absolute: (rel: string) => string;
  timeZone: string;
  onView: (images: string[], index: number) => void;
}) {
  const { t } = useI18n();
  const images = turn.images.map(absolute);
  return (
    <article className="turn turn-user" aria-label={t("conversation.you")}>
      {turn.text && <p className="turn-text">{turn.text}</p>}
      {images.length > 0 && (
        <div className="references">
          {images.map((path, index) => (
            <button key={path} type="button" className="reference-print" onClick={() => onView(images, index)} aria-label={t("conversation.viewReference")}>
              <img src={imageUrl(path, 160)} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function AssistantTurnView({
  turn,
  absolute,
  allImages,
  onView,
  onReuse,
  onExport,
  exported,
}: {
  turn: AssistantTurn;
  absolute: (rel: string) => string;
  allImages: string[];
  onView: (images: string[], index: number) => void;
  onReuse: (rel: string) => void;
  onExport: (path: string) => void;
  exported: { path: string; count: number } | null;
  first: boolean;
}) {
  const { t } = useI18n();
  return (
    <article className="turn turn-assistant" aria-label={t("conversation.assistant")}>
      {turn.text && (
        <div className="turn-text reading markdown">
          <Markdown text={turn.text} />
        </div>
      )}
      {turn.images.map((rel) => {
        const path = absolute(rel);
        return (
          <Print
            key={rel}
            path={path}
            onOpen={() => onView(allImages, allImages.indexOf(path))}
            onReuse={() => onReuse(rel)}
            onExport={() => onExport(path)}
            exported={exported?.path === path ? exported.count : 0}
          />
        );
      })}
      {turn.failedImages > 0 && <p className="turn-note">{t("conversation.failedImages", { count: turn.failedImages })}</p>}
      {turn.incomplete && <p className="turn-note">{t("conversation.incomplete")}</p>}
      <p className="token-line">
        {turn.usage ? t("conversation.tokens", { input: turn.usage.input, output: turn.usage.output }) : t("conversation.tokensUnknown")}
      </p>
      {turn.usage?.imageInput !== undefined && (
        <p className="token-line">{t("conversation.imageTokens", { input: turn.usage.imageInput, output: turn.usage.imageOutput ?? 0 })}</p>
      )}
      {turn.resumed === "resent" && <p className="token-line">{t("conversation.resent")}</p>}
    </article>
  );
}

/** The working card: a placeholder of the requested shape that slowly develops, with a counter and Cancel. */
function Developing({ running, onCancel }: { running: Running; onCancel: () => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [w, h] = running.size === "auto" ? [1, 1] : running.size.split("x").map(Number);
  return (
    <div className="turn turn-assistant" aria-live="polite">
      <div className="developing" style={{ aspectRatio: `${w} / ${h}` }}>
        <div className="developing-sheen" aria-hidden="true" />
        <div className="developing-label">
          <span>{t("conversation.working")}</span>
          <span className="developing-time">{elapsed(now - running.startedAt)}</span>
        </div>
      </div>
      <div className="print-actions">
        <button type="button" className="button" onClick={onCancel}>
          {t("conversation.cancel")}
        </button>
      </div>
    </div>
  );
}

