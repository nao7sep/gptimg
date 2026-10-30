// The main window: the session rail, the open conversation and its composer,
// and the one modal host. App is the single writer of the window's state; the
// panes receive what they show and report what the user did.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { PANES } from "../../shared/layout.ts";
import type { AppFailure, BootInfo, KeyStatus, MenuCommand, OpenedSession, TurnOutcome } from "../../shared/api.ts";
import { applySessionChange, type SessionSummary, type TurnOptions } from "../../shared/session.ts";
import type { Settings } from "../../shared/settings.ts";
import { commandFor } from "../../shared/shortcuts.ts";
import type { UiState } from "../../shared/ui-state.ts";
import { api } from "./api.ts";
import { Composer, type Draft, type Reference } from "./components/Composer.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { ImagesPane, paneImages, type PaneImage } from "./components/ImagesPane.tsx";
import { Rail } from "./components/Rail.tsx";
import { useI18n } from "./i18n.tsx";
import { requestTopModalClose } from "./modals/Modal.tsx";
import { SettingsModal } from "./modals/SettingsModal.tsx";
import { SetupModal } from "./modals/SetupModal.tsx";
import { AboutModal, ConfirmModal, RenameModal, ShortcutsModal } from "./modals/SmallModals.tsx";
import { ExportModal } from "./modals/ExportModal.tsx";
import { TaskStrip } from "./components/TaskStrip.tsx";
import { useExportTasks } from "./export-tasks.ts";
import { ViewerModal } from "./modals/ViewerModal.tsx";
import { MaskModal } from "./modals/MaskModal.tsx";
import { applyFonts } from "./fonts.ts";

// The pane minimums main hands the OS, given to the stylesheet so the layout uses the same numbers.
const paneSizes = {
  "--pane-conversation-min": `${PANES.conversation.minWidth}px`,
  "--pane-header": `${PANES.header.height}px`,
  "--pane-transcript-min": `${PANES.transcript.minHeight}px`,
} as CSSProperties;

type ModalSpec =
  | { kind: "settings" }
  | { kind: "setup" }
  | { kind: "about" }
  | { kind: "shortcuts" }
  | { kind: "rename"; id: string; title: string }
  | { kind: "trash"; id: string; title: string }
  | { kind: "viewer"; images: string[]; index: number }
  | { kind: "export"; path: string }
  | { kind: "mask"; reference: Reference };

export interface Running {
  startedAt: number;
  size: string;
  /** The latest draft of the image being drawn, when drafts are on. */
  draft?: string;
}

const NEW = "";

function editableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function App({ boot }: { boot: BootInfo }) {
  const { t } = useI18n();
  const mac = boot.platform === "darwin";
  const [settings, setSettings] = useState<Settings>(boot.settings);
  const [settingsProblem, setSettingsProblem] = useState(boot.settingsProblem);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(boot.key);
  const [ui, setUi] = useState<UiState>(boot.state);
  // The latest UI state, for a task that finishes after the render that started it.
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [listFailure, setListFailure] = useState<AppFailure | null>(null);
  const [currentId, setCurrentId] = useState<string>(NEW);
  const [opened, setOpened] = useState<OpenedSession | null>(null);
  const [openFailure, setOpenFailure] = useState<AppFailure | null>(null);
  const [running, setRunning] = useState<Record<string, Running>>({});
  const [failures, setFailures] = useState<Record<string, AppFailure>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [settingsDirty, setSettingsDirty] = useState(false);
  const windowDirty = settingsDirty || Object.values(drafts).some((draft) => draft.text.trim() !== "" || draft.references.length > 0 || !!draft.mask);
  useEffect(() => { api.setWindowDirty(windowDirty); }, [windowDirty]);
  useEffect(() => () => api.setWindowDirty(false), []);
  const [exported, setExported] = useState<{ path: string; count: number } | null>(null);
  const exportTasks = useExportTasks();
  const [modals, setModals] = useState<ModalSpec[]>(() =>
    boot.settings.sessionsDir === "" ? [{ kind: "setup" }] : [],
  );
  const pendingNew = useRef<{ requestId: string; running: Running } | null>(null);
  // Mirrors pendingNew for rendering: the new-session composer shows its turn as working.
  const [pendingRun, setPendingRun] = useState<Running | null>(null);
  const rootRef = useRef(settings.sessionsDir);
  rootRef.current = settings.sessionsDir;
  const restored = useRef(false);
  const listingGeneration = useRef(0);
  const openingGeneration = useRef(0);
  const submitted = useRef(new Map<string, { key: string; version: number }>());
  const draftVersions = useRef(new Map<string, number>());
  const currentRef = useRef(currentId);
  currentRef.current = currentId;
  const composerFocus = useRef<() => void>(() => {});
  const attachRef = useRef<() => void>(() => {});

  useEffect(() => applyFonts(settings), [settings]);

  const saveUi = useCallback((next: UiState) => {
    setUi(next);
    const before = uiRef.current;
    uiRef.current = next;
    const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => key !== "recordsListWidth" && value !== before[key as keyof UiState]));
    api.saveState(patch);
  }, []);

  // The whole listing is read only when the sessions folder changes (and at
  // startup); after that main sends each session's change on its own.
  const loadList = useCallback(async () => {
    const generation = ++listingGeneration.current;
    const root = rootRef.current;
    const outcome = await api.listSessions();
    if (root !== rootRef.current || generation !== listingGeneration.current) return;
    if (!outcome.ok) {
      setListFailure(outcome.failure);
      return;
    }
    setListFailure(null);
    setSessions(outcome.sessions);
    setUnreadable(outcome.unreadable);
  }, []);

  const openSession = useCallback(
    async (id: string) => {
      const generation = ++openingGeneration.current;
      const root = rootRef.current;
      currentRef.current = id;
      setCurrentId(id);
      setOpened(null);
      setOpenFailure(null);
      if (id === NEW) {
        setOpened(null);
        return;
      }
      const outcome = await api.openSession(id);
      if (currentRef.current !== id || root !== rootRef.current || generation !== openingGeneration.current) return;
      if (outcome.ok) {
        setOpened(outcome.session);
        saveUi({ ...uiRef.current, lastSessionId: id });
      } else {
        setOpened(null);
        setOpenFailure(outcome.failure);
      }
    },
    [saveUi, ui],
  );

  useEffect(() => {
    ++listingGeneration.current;
    ++openingGeneration.current;
    currentRef.current = NEW;
    setCurrentId(NEW);
    setOpened(null);
    setSessions([]);
    setFailures({});
    const root = settings.sessionsDir;
    const restoreId = !restored.current && root === boot.settings.sessionsDir ? boot.state.lastSessionId : null;
    restored.current = true;
    const selection = openingGeneration.current;
    void loadList().then(() => {
      if (restoreId && rootRef.current === root && openingGeneration.current === selection) void openSession(restoreId);
    });
  }, [settings.sessionsDir]);

  useEffect(
    () =>
      api.onSessionsChanged((change) => {
        if (change.kind === "entry") setSessions((list) => applySessionChange(list, change.id, change.session));
      }),
    [],
  );

  useEffect(
    () =>
      api.onTurnStarted(({ requestId, session }) => {
        const submission = submitted.current.get(requestId);
        if (submission) {
          submitted.current.delete(requestId);
          if ((draftVersions.current.get(submission.key) ?? 0) === submission.version) {
            setDrafts(({ [submission.key]: _accepted, ...rest }) => rest);
          }
        }
        const pending = pendingNew.current;
        if (pending?.requestId === requestId) {
          pendingNew.current = null;
          setPendingRun(null);
          setRunning((r) => ({ ...r, [session.id]: pending.running }));
          if (currentRef.current === NEW) {
            ++openingGeneration.current;
            currentRef.current = session.id;
            setCurrentId(session.id);
            setOpened(session);
          }
        } else if (currentRef.current === session.id) {
          setOpened(session);
        }
      }),
    [],
  );

  useEffect(
    () =>
      api.onTurnDraft(({ sessionId, path }) =>
        setRunning((r) => {
          const run = r[sessionId];
          if (!run) return r;
          const { draft: _old, ...rest } = run;
          return { ...r, [sessionId]: path ? { ...rest, draft: path } : rest };
        }),
      ),
    [],
  );

  const settle = useCallback(
    (sessionId: string | null, outcome: TurnOutcome) => {
      const id = outcome.session?.id ?? sessionId;
      if (id) {
        setRunning(({ [id]: _done, ...rest }) => rest);
        setFailures(({ [id]: _old, ...rest }) => (!outcome.ok && !outcome.cancelled ? { ...rest, [id]: outcome.failure } : rest));
        if (outcome.session && currentRef.current === id) setOpened(outcome.session);
      } else if (!outcome.ok) {
        // Nothing was saved (no key, no folder): the failure belongs to the new-session composer.
        setFailures((f) => ({ ...f, [NEW]: outcome.failure }));
      }
    },
    [],
  );

  const send = useCallback(
    async (draft: Draft, options: TurnOptions) => {
      if (currentId !== NEW && opened?.id !== currentId) return;
      const sessionId = currentId === NEW ? null : currentId;
      const requestId = crypto.randomUUID();
      const run: Running = { startedAt: performance.now(), size: options.size };
      if (sessionId) setRunning((r) => ({ ...r, [sessionId]: run }));
      else {
        pendingNew.current = { requestId, running: run };
        setPendingRun(run);
      }
      setFailures(({ [currentId]: _old, ...rest }) => rest);
      const key = `${rootRef.current}\0${currentId}`;
      submitted.current.set(requestId, { key, version: draftVersions.current.get(key) ?? 0 });
      saveUi({ ...ui, composer: options });
      const outcome = await api.send({ requestId, sessionId, text: draft.text, references: draft.references.map((r) => r.path), ...(draft.mask && { mask: draft.mask }), options });
      if (!sessionId && pendingNew.current?.requestId === requestId) {
        pendingNew.current = null;
        setPendingRun(null);
      }
      submitted.current.delete(requestId);
      settle(sessionId, outcome);
    },
    [currentId, opened, saveUi, settle, ui],
  );

  const retry = useCallback(
    async (sessionId: string) => {
      const lastUser = [...(opened?.doc.turns ?? [])].reverse().find((turn) => turn.role === "user");
      const size = lastUser?.role === "user" ? lastUser.options.size : "auto";
      setRunning((r) => ({ ...r, [sessionId]: { startedAt: performance.now(), size } }));
      setFailures(({ [sessionId]: _old, ...rest }) => rest);
      settle(sessionId, await api.retry(sessionId));
    },
    [opened, settle],
  );

  const pushModal = useCallback((spec: ModalSpec) => setModals((m) => [...m, spec]), []);
  const popModal = useCallback(() => setModals((m) => m.slice(0, -1)), []);

  const currentTitle = sessions.find((s) => s.id === currentId)?.title ?? opened?.doc.title ?? "";

  const runCommand = useCallback(
    (command: MenuCommand) => {
      if (command === "close") {
        if (modals.length > 0) requestTopModalClose();
        else api.closeWindow();
        return;
      }
      if (modals.length > 0 && command !== "shortcuts" && command !== "settings") return;
      switch (command) {
        case "newSession":
          void openSession(NEW);
          setTimeout(() => composerFocus.current(), 0);
          break;
        case "settings":
          if (!modals.some((m) => m.kind === "settings")) pushModal({ kind: "settings" });
          break;
        case "shortcuts":
          if (!modals.some((m) => m.kind === "shortcuts")) pushModal({ kind: "shortcuts" });
          break;
        case "about":
          pushModal({ kind: "about" });
          break;
        case "records":
          api.openRecords();
          break;
        case "attach":
          attachRef.current();
          break;
        case "rename":
          if (currentId !== NEW) pushModal({ kind: "rename", id: currentId, title: currentTitle });
          break;
        case "reveal":
          if (currentId !== NEW) api.revealSession(currentId);
          break;
        case "trash":
          if (currentId !== NEW) pushModal({ kind: "trash", id: currentId, title: currentTitle });
          break;
      }
    },
    [currentId, currentTitle, modals, openSession, popModal, pushModal],
  );

  useEffect(() => api.onMenu(runCommand), [runCommand]);

  // The macOS Ctrl half of each shortcut (the menu owns the Cmd half), standing down in text.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (!mac || !event.ctrlKey || event.metaKey) return;
      const command = commandFor(event, mac, editableTarget(event.target));
      if (command) {
        event.preventDefault();
        runCommand(command);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac, runCommand]);

  // The invisible denial boundary: a file dropped anywhere but the composer is refused, never opened.
  useEffect(() => {
    const deny = (event: DragEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.("[data-drop-receiver]")) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      }
    };
    window.addEventListener("dragover", deny);
    window.addEventListener("drop", deny);
    return () => {
      window.removeEventListener("dragover", deny);
      window.removeEventListener("drop", deny);
    };
  }, []);

  const draftKey = `${settings.sessionsDir}\0${currentId}`;
  const storedDraft = drafts[draftKey] ?? { text: "", references: [] };
  const draft = { ...storedDraft, references: storedDraft.references.map((reference) => ({ ...reference, absolute: absoluteIn(opened, reference.path) })) };
  const setDraft = useCallback((next: Draft | ((current: Draft) => Draft)) => {
    draftVersions.current.set(draftKey, (draftVersions.current.get(draftKey) ?? 0) + 1);
    setDrafts((d) => ({ ...d, [draftKey]: typeof next === "function" ? next(d[draftKey] ?? { text: "", references: [] }) : next }));
  }, [draftKey]);

  const runningHere = currentId === NEW ? pendingRun : (running[currentId] ?? null);
  const composerOptions = useMemo(() => {
    const turns = opened?.doc.turns ?? [];
    const lastUser = [...turns].reverse().find((turn) => turn.role === "user");
    return lastUser?.role === "user" ? lastUser.options : ui.composer;
  }, [opened, ui.composer]);

  const front = modals[modals.length - 1];
  const images = useMemo(() => (currentId !== NEW && opened ? paneImages(opened) : []), [currentId, opened]);
  const chosen = useMemo(() => new Set(draft.references.map((r) => r.path)), [draft.references]);
  const toggleImage = (image: PaneImage) =>
    setDraft(
      chosen.has(image.path)
        ? { ...draft, references: draft.references.filter((r) => r.path !== image.path) }
        : { ...draft, references: [...draft.references, { path: image.path, absolute: image.absolute }] },
    );
  const paneShown = ui.imagesPane && currentId !== NEW && opened !== null;

  return (
    <div className="shell" style={paneSizes}>
      <Rail
        sessions={sessions}
        imagesPane={paneShown}
        currentId={currentId}
        running={running}
        unreadable={unreadable}
        failure={listFailure}
        sessionsDir={settings.sessionsDir}
        timeZone={settings.timeZone}
        width={ui.railWidth}
        onWidth={(railWidth) => saveUi({ ...ui, railWidth })}
        onNew={() => runCommand("newSession")}
        onOpen={(id) => void openSession(id)}
        onRename={(id, title) => pushModal({ kind: "rename", id, title })}
        onTrash={(id, title) => pushModal({ kind: "trash", id, title })}
        mac={mac}
        onMenu={(command) => (command === "chatsFolder" ? api.showChatsFolder() : runCommand(command))}
      />
      <main className="stage">
        <Conversation
          session={currentId === NEW ? null : opened}
          openFailure={openFailure}
          running={runningHere}
          failure={failures[currentId] ?? null}
          timeZone={settings.timeZone}
          onCancel={() => api.cancel(currentId !== NEW ? currentId : (pendingNew.current?.requestId ?? ""))}
          onRetry={() => currentId !== NEW && void retry(currentId)}
          onDismissFailure={() => setFailures(({ [currentId]: _gone, ...rest }) => rest)}
          onRename={() => runCommand("rename")}
          imagesPane={ui.imagesPane}
          onToggleImagesPane={() => saveUi({ ...ui, imagesPane: !ui.imagesPane })}
          onReveal={() => runCommand("reveal")}
          onView={(images, index) => pushModal({ kind: "viewer", images, index })}
          onExport={(path) => pushModal({ kind: "export", path })}
          exported={exported}
          onReuse={(path) => setDraft({ ...draft, references: [...draft.references.filter((r) => r.path !== path), { path, absolute: absoluteIn(opened, path) }] })}
        />
        {front?.kind !== "export" && <TaskStrip tasks={exportTasks} />}
        <Composer
          key={draftKey}
          disabled={currentId !== NEW && opened?.id !== currentId}
          draft={draft}
          onDraft={setDraft}
          options={composerOptions}
          imageModel={settings["openai.image"]}
          busy={runningHere !== null}
          keyMissing={keyStatus.source === "none"}
          sessionDir={opened?.dir ?? null}
          focusRef={composerFocus}
          attachRef={attachRef}
          onSend={(d, o) => void send(d, o)}
          onCancel={() => api.cancel(currentId !== NEW ? currentId : (pendingNew.current?.requestId ?? ""))}
          onOpenSettings={() => runCommand("settings")}
          onPaintMask={(reference) => pushModal({ kind: "mask", reference })}
        />
      </main>
      {paneShown && <ImagesPane images={images} chosen={chosen} onToggle={toggleImage} />}

      {front?.kind === "setup" && (
        <SetupModal
          boot={boot}
          settings={settings}
          keyStatus={keyStatus}
          onDone={(next, status) => {
            setSettings(next);
            setKeyStatus(status);
            popModal();
          }}
        />
      )}
      {front?.kind === "settings" && (
        <SettingsModal
          boot={boot}
          settings={settings}
          problem={settingsProblem}
          keyStatus={keyStatus}
          onClose={popModal}
          onDirtyChange={setSettingsDirty}
          onSaved={(next, status) => {
            const folderMoved = next.sessionsDir !== settings.sessionsDir;
            setSettings(next);
            setSettingsProblem(null);
            setKeyStatus(status);
            if (folderMoved) {
              setCurrentId(NEW);
              setOpened(null);
            }
          }}
        />
      )}
      {front?.kind === "about" && <AboutModal version={boot.version} onClose={popModal} />}
      {front?.kind === "shortcuts" && <ShortcutsModal mac={mac} onClose={popModal} />}
      {front?.kind === "rename" && (
        <RenameModal
          title={front.title}
          onClose={popModal}
          onRename={async (title) => {
            const outcome = await api.renameSession(front.id, title);
            if (!outcome.ok) {
              if (currentRef.current === front.id) await openSession(front.id);
              return outcome.failure;
            }
            popModal();
            if (currentRef.current === front.id) {
              setCurrentId(outcome.session.id);
              setOpened(outcome.session);
              saveUi({ ...ui, lastSessionId: outcome.session.id });
            }
            setDrafts(({ [`${settings.sessionsDir}\0${front.id}`]: moved, ...rest }) => (moved ? { ...rest, [`${settings.sessionsDir}\0${outcome.session.id}`]: moved } : rest));
            return null;
          }}
        />
      )}
      {front?.kind === "trash" && (
        <ConfirmModal
          title={t(mac ? "trash.titleMac" : "trash.titleOther")}
          body={t(mac ? "trash.bodyMac" : "trash.bodyOther", { title: front.title || t("rail.untitled") })}
          confirmLabel={t(mac ? "trash.confirmMac" : "trash.confirmOther")}
          onClose={popModal}
          onConfirm={async () => {
            const outcome = await api.trashSession(front.id);
            if (!outcome.ok) return outcome.failure;
            popModal();
            if (currentRef.current === front.id) void openSession(NEW);
            return null;
          }}
        />
      )}
      {front?.kind === "export" && (
        <ExportModal
          path={front.path}
          prefs={ui.export}
          tasks={exportTasks}
          onClose={popModal}
          onExported={(prefs, _savedTo, dir) => {
            saveUi({ ...uiRef.current, export: prefs, exportDir: dir ?? uiRef.current.exportDir });
            // The export may finish after its dialog was closed: close it only if it is still open.
            setModals((m) => (m[m.length - 1]?.kind === "export" ? m.slice(0, -1) : m));
            setExported((e) => ({ path: front.path, count: (e?.count ?? 0) + 1 }));
          }}
        />
      )}
      {front?.kind === "mask" && (
        <MaskModal
          absolute={front.reference.absolute}
          onClose={popModal}
          onDone={(mask) => {
            popModal();
            setDraft({ ...draft, mask: { image: front.reference.path, mask } });
          }}
        />
      )}
      {front?.kind === "viewer" && (
        <ViewerModal
          images={front.images}
          index={front.index}
          onClose={popModal}
          onExport={(path, index) => {
            // The viewer comes back where it was when the export dialog closes.
            setModals((m) => [...m.slice(0, -1), { kind: "viewer", images: front.images, index }, { kind: "export", path }]);
          }}
        />
      )}
    </div>
  );
}

function absoluteIn(session: OpenedSession | null, relative: string): string {
  if (!session) return relative;
  const sep = session.dir.includes("\\") ? "\\" : "/";
  return `${session.dir}${sep}${relative.split("/").join(sep)}`;
}
