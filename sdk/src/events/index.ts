import type { EventLevel, EventStage, ProgressUpdate, SdkEvent, SdkEventBody, SdkEventName, VerbName } from "../types.ts";
import { maskCredentials } from "./mask.ts";

/**
 * The SDK's events (sdk-conventions, *Logging*): it writes no log. Each event
 * is a complete record, its message fixed by its name, handed to the caller's
 * `onEvent`, which stores it with its own records. Debug events reach the hook
 * only when the instance was built with `debug: true`. Every string an event
 * carries is masked against the call's credentials first.
 */
const MESSAGES: Readonly<Record<SdkEventName, string>> = {
  "sdk.start": "gptimgsdk started",
  "verb.start": "verb started",
  "verb.done": "verb finished",
  "verb.refused": "verb refused",
  "verb.failed": "verb failed",
  "verb.cancelled": "verb cancelled",
  "provider.call": "calling the provider",
  "provider.returned": "the provider returned",
  "attempt.succeeded": "request attempt succeeded",
  "attempt.failed": "request attempt failed",
  "attempt.retrying": "retrying the request",
  "attempt.cancelled": "request attempt cancelled",
  "image.short": "the provider returned fewer images than requested",
  "image.missing": "the provider returned no image for an item",
  "image.undecodable": "a returned image could not be decoded",
  "image.unpublished": "an image could not be published",
  "image.published": "image published",
  "sidecar.published": "record published",
  "sidecar.unpublished": "a record could not be published",
  "slots.leftover": "an earlier run's files could not be removed",
  "vision.input": "vision input prepared",
  "vision.refusal": "the vision model refused",
  "vision.noVerdict": "the vision response yielded no verdict",
  "chat.resend": "the previous response is gone; resending the conversation",
  "chat.historyImage": "an earlier turn's image was fitted for resending",
  "chat.historyImageSkipped": "an earlier turn's image could not be read and was left out",
  "model.download.needed": "the model is not on disk; downloading it",
  "model.download.start": "model download started",
  "model.download.done": "model download finished",
  "model.infer.start": "model inference started",
  "model.infer.done": "model inference finished",
  "model.verify.start": "model verification started",
  "model.verify.done": "model verification finished",
};

/**
 * Call a hook immediately, containing sync and async failures: a hook's failure
 * never breaks the verb and is never reported through the hook that failed
 * (sdk-conventions, *Events, progress and cancellation*).
 */
export function dispatchHook<T>(hook: ((value: T) => unknown) | undefined, value: T): void {
  if (!hook) return;
  try {
    // Callers may return a promise despite the void callback type; observe its rejection.
    void Promise.resolve(hook(value)).catch(() => {});
  } catch {
    // A failing observer must never disrupt an operation or its peers.
  }
}

/** A verb's event and progress sink. */
export interface Logger {
  readonly verb: VerbName;
  /** Hand one event to the caller's `onEvent`, stamped, masked and gated on `debug`. */
  emit(level: EventLevel, stage: EventStage, body: SdkEventBody): void;
  /**
   * Report countable work to the caller's `onProgress`, throttled to one update
   * per 100 ms plus the final count. Only real counts are reported: bytes of a
   * download or hash, tiles, inputs, renditions, passes.
   */
  progress(stage: EventStage, done: number, total: number, unit: ProgressUpdate["unit"], subject?: string): void;
  /** Mask `credential` (an API key) in every later event. */
  addCredential(credential: string): void;
}

const PROGRESS_INTERVAL_MS = 100;

export function createLogger(
  verb: VerbName,
  opts: {
    onEvent?: ((event: SdkEvent) => void) | undefined;
    onProgress?: ((update: ProgressUpdate) => void) | undefined;
    debug?: boolean | undefined;
  } = {},
): Logger {
  const { onEvent, onProgress } = opts;
  const debug = opts.debug ?? false;
  const credentials = new Set<string>();
  let lastProgress = 0;
  return {
    verb,
    emit(level, stage, body) {
      if (!onEvent) return;
      if (level === "debug" && !debug) return;
      const stamped = { time: new Date().toISOString(), level, stage, verb, message: MESSAGES[body.event], ...body } as SdkEvent;
      let masked: SdkEvent;
      try {
        // Masking string values, not the serialized text, keeps numbers, booleans and escapes intact;
        // the round trip also gives the caller a plain copy it may keep.
        masked = JSON.parse(
          JSON.stringify(stamped, (_key, value: unknown) =>
            typeof value === "string" && credentials.size > 0 ? maskCredentials(value, credentials) : value,
          ),
        ) as SdkEvent;
      } catch {
        // Unserializable fields (a cycle, a BigInt) lose this event, never the verb.
        return;
      }
      dispatchHook(onEvent, masked);
    },
    progress(stage, done, total, unit, subject) {
      if (!onProgress) return;
      const now = Date.now();
      if (done < total && now - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = now;
      dispatchHook(onProgress, { verb, stage, done, total, unit, ...(subject !== undefined && { subject }) });
    },
    addCredential(credential) {
      if (credential.length > 0) credentials.add(credential);
    },
  };
}

const INPUT_KEYS = ["input", "in", "inputs", "base"];
const OUTPUT_KEYS = ["out", "output", "path", "outDir"];

function split(fields: Record<string, unknown>, inputKeys: readonly string[], outputKeys: readonly string[]) {
  const rest = { ...fields };
  const take = (keys: readonly string[]): unknown => {
    for (const key of keys) {
      if (rest[key] !== undefined) {
        const value = rest[key];
        delete rest[key];
        return value;
      }
    }
    return null;
  };
  return { input: take(inputKeys), output: take(outputKeys), rest };
}

/** A verb's `verb.start` body: its input and output paths as typed fields, the settings it resolved beside them. */
export function verbStart(fields: Record<string, unknown>): SdkEventBody {
  const { input, output, rest } = split(fields, INPUT_KEYS, OUTPUT_KEYS);
  return { event: "verb.start", input: input as string | string[] | null, output: output as string | null, settings: rest };
}

/** A verb's `verb.done` body: the output it wrote, and what it measured or settled. */
export function verbDone(fields: Record<string, unknown>): SdkEventBody {
  const { output, rest } = split(fields, [], OUTPUT_KEYS);
  return { event: "verb.done", output: output as string | null, stats: rest };
}
