import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LogEntry, LogHandle, LogLevel, LogStage, LogVerb, ProgressUpdate } from "../types.ts";
import { maskCredentials } from "./mask.ts";

// Credentials registered for a handle (`Logger.addCredential`). Every record is
// masked against them before any sink receives it, so a key echoed anywhere in a
// request, response or error chain never reaches the file or `onEvent`.
const credentialsByHandle = new WeakMap<LogHandle, Set<string>>();

// Each handle's file writes, chained so lines land in order. Logging is a
// diagnostic sink: a verb never waits for it, so a slow or stalled log disk cannot
// delay a result, a paid image's publication or a cancellation
// (logging-conventions). `closeLog` waits a bounded time for the chain.
const pendingWrites = new WeakMap<LogHandle, Promise<void>>();

// Long enough for an ordinary disk to finish a verb's last lines; short enough
// that a stalled one costs the caller little.
const CLOSE_WAIT_MS = 2_000;

/**
 * Mask string values before serialization. Replacing substrings in serialized
 * JSON can corrupt numbers, booleans or escape syntax when a URL query value
 * happens to contain the same text. Field names and non-string values stay intact.
 */
function serialize(handle: LogHandle, entry: LogEntry): string {
  const credentials = credentialsByHandle.get(handle);
  return JSON.stringify(entry, (_key, value: unknown) =>
    typeof value === "string" && credentials?.size
      ? maskCredentials(value, credentials)
      : value,
  ) + "\n";
}

/**
 * Call a hook immediately, containing sync and async failures: a hook's failure
 * never breaks the verb and is never reported through the hook that failed
 * (sdk-conventions, *Events, progress and cancellation*).
 */
function dispatchHook<T>(hook: ((value: T) => unknown) | undefined, value: T): void {
  if (!hook) return;
  try {
    // Callers may return a promise despite the void callback type. Observe its
    // rejection without making callback settlement a logging wait.
    void Promise.resolve(hook(value)).catch(() => {
      // A failing observer must never disrupt an operation or its peers.
    });
  } catch {
    // The same best-effort boundary owns synchronous callback failures.
  }
}

function enqueueWrite(handle: LogHandle & { path: string }, line: string, onEvent?: (entry: LogEntry) => void): Promise<void> {
  const next = (pendingWrites.get(handle) ?? Promise.resolve())
    .then(() => appendFile(handle.path, line, { encoding: "utf-8", mode: 0o600 }))
    .catch((err: unknown) => announceLogFailure(handle, err, onEvent));
  pendingWrites.set(handle, next);
  return next;
}

// Handles for which a file-logging failure has already been surfaced. The notice
// goes through the caller's progress sink (`onEvent`) exactly ONCE per session, not
// on every line — and never to a standard stream: an SDK prints nothing, ever
// (sdk-conventions, *Logging*). With no sink the SDK is silent; the live event
// stream, which is independent of the file, already carries every event. Module-
// private (a WeakSet, not a field) so the public LogHandle stays a plain `{path, verb}`.
const failureAnnounced = new WeakSet<LogHandle>();

/**
 * Surface a log-file failure once per handle, the SDK way: never crash, never
 * print. The notice is one warn-level record forwarded through the caller's
 * progress sink (`onEvent`) — the same envelope a normal line uses — so a watcher
 * learns the on-disk log is unavailable. With no sink the SDK stays silent
 * (sdk-conventions, *Logging*); the live event stream already carries every
 * event, so the file failing loses no part of the contract.
 */
function announceLogFailure(handle: LogHandle, err: unknown, onEvent?: (entry: LogEntry) => void): void {
  if (failureAnnounced.has(handle)) return;
  failureAnnounced.add(handle);
  if (!onEvent) return;
  const notice: LogEntry = {
    time: new Date().toISOString(),
    level: "warn",
    message: "log file unavailable",
    verb: handle.verb,
    stage: "log",
    data: { path: handle.path, error: err instanceof Error ? err.message : String(err) },
  };
  dispatchHook(onEvent, notice);
}

async function openLog(
  filePath: string | null,
  verb: LogVerb,
  onEvent?: (entry: LogEntry) => void,
): Promise<LogHandle> {
  const handle: LogHandle = { path: filePath, verb };
  if (filePath === null) return handle;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (err) {
    // Can't create the log directory — surface once through the sink and let appends
    // fall through to the same handling, rather than failing the verb the logger
    // only observes.
    announceLogFailure(handle, err, onEvent);
  }
  return handle;
}

async function appendLog(
  handle: LogHandle,
  debug: boolean,
  entry: {
    level: LogLevel;
    stage: LogStage;
    message: string;
    data?: Record<string, unknown>;
  },
  onEvent?: (entry: LogEntry) => void,
): Promise<void> {
  const final: LogEntry = {
    time: new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    verb: handle.verb,
    stage: entry.stage,
  };
  if (entry.data) final.data = entry.data;
  let line: string;
  let event: LogEntry;
  try {
    line = serialize(handle, final);
    // Every sink gets the same masked diagnostic copy.
    event = JSON.parse(line) as LogEntry;
  } catch (err) {
    // Unserializable data (a cycle, a BigInt) loses this line, never the verb.
    announceLogFailure(handle, err, onEvent);
    return;
  }

  // Every event reaches the caller's `onEvent` before the file write, so a
  // watcher sees it at once, error and debug levels included; the debug switch
  // governs only what the file keeps.
  dispatchHook(onEvent, event);

  if (handle.path === null) return;
  // The developer-only firehose reaches the file only when the caller's log
  // option asks for debug lines (logging-conventions).
  if (final.level === "debug" && !debug) return;

  // Logging must never crash the operation it observes: a failed write is
  // surfaced once (through the sink), and later lines keep trying the file so a
  // transient failure self-heals. The returned promise settles when this line is
  // written or has failed; the verb logger does not wait for it.
  await enqueueWrite(handle as LogHandle & { path: string }, line, onEvent);
}

/** Mask `credential` in every later record of this handle. */
function addLogCredential(handle: LogHandle, credential: string): void {
  if (credential.length === 0) return;
  const credentials = credentialsByHandle.get(handle) ?? new Set<string>();
  credentials.add(credential);
  credentialsByHandle.set(handle, credentials);
}

/**
 * Wait for the handle's pending writes, at most `CLOSE_WAIT_MS`, so a caller
 * that reads the log after a verb returns finds its lines, while a stalled log
 * disk cannot hold the verb. Each write opens, appends and closes the file, so
 * there is no descriptor to release.
 */
async function closeLog(handle: LogHandle): Promise<void> {
  const pending = pendingWrites.get(handle);
  if (!pending) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_WAIT_MS);
    timer.unref();
  });
  await Promise.race([pending, timeout]);
  clearTimeout(timer);
}

/**
 * A verb's logger. Each record reaches `onEvent` at once and is queued for the
 * file in order; the returned promises settle without waiting for the disk, and
 * `close` waits a bounded time for the queue.
 */
export interface Logger {
  readonly handle: LogHandle;
  info(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  warn(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  error(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  debug(stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void>;
  /**
   * Report countable work to the caller's `onProgress`, throttled to one update
   * per 100 ms plus the final count. Only real counts are reported: bytes of a
   * download or hash, tiles, inputs, renditions, passes.
   */
  progress(stage: LogStage, done: number, total: number, unit: ProgressUpdate["unit"], subject?: string): void;
  /** Mask `credential` (an API key) in every later record, file and `onEvent` alike. */
  addCredential(credential: string): void;
  close(): Promise<void>;
}

const PROGRESS_INTERVAL_MS = 100;

export async function createLogger(
  filePath: string | null,
  verb: LogVerb,
  opts: {
    onEvent?: ((entry: LogEntry) => void) | undefined;
    onProgress?: ((update: ProgressUpdate) => void) | undefined;
    debug?: boolean | undefined;
  } = {},
): Promise<Logger> {
  const { onEvent, onProgress } = opts;
  const debug = opts.debug ?? false;
  const handle = await openLog(filePath, verb, onEvent);
  const record = (level: LogLevel, stage: LogStage, message: string, data?: Record<string, unknown>): Promise<void> => {
    void appendLog(handle, debug, { level, stage, message, data }, onEvent);
    return Promise.resolve();
  };
  let lastProgress = 0;
  return {
    handle,
    info: (stage, message, data) => record("info", stage, message, data),
    warn: (stage, message, data) => record("warn", stage, message, data),
    error: (stage, message, data) => record("error", stage, message, data),
    debug: (stage, message, data) => record("debug", stage, message, data),
    progress: (stage, done, total, unit, subject) => {
      if (!onProgress) return;
      const now = Date.now();
      if (done < total && now - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = now;
      dispatchHook(onProgress, { verb, stage, done, total, unit, ...(subject !== undefined && { subject }) });
    },
    addCredential: (credential) => addLogCredential(handle, credential),
    close: () => closeLog(handle),
  };
}
