/**
 * Shared ONNX Runtime session creation and execution for local models.
 * Owns the runtime tuning (from the caller's `policy.onnx`, never the
 * environment) and caches one session per model path and tuning, so several
 * models and several models folders coexist without evicting each other.
 *
 * Model-specific tensor pre/post-processing lives in each model's own module;
 * only the native session lifecycle and failure boundary are shared here.
 */

import os from "node:os";
import type * as Ort from "onnxruntime-node";
import { GptImgError, cancelledError } from "../../errors.ts";
import { isAbortError } from "../../network/failure.ts";
import type { InferenceRecord, OnnxPolicy } from "../../types.ts";
import { ONNX_DEFAULTS } from "../../defaults.ts";

// One creation per model path and tuning: concurrent first callers await the
// same promise instead of each loading its own copy of the weights.
interface SessionEntry {
  modelPath: string;
  pending: Promise<Ort.InferenceSession>;
  borrowers: number;
  idle: Promise<void>;
  signalIdle: () => void;
  disposal?: Promise<boolean> | undefined;
}
const sessions = new Map<string, SessionEntry>();
// Retired entries stay owned until disposal succeeds, including after a failed release.
const retired = new Set<SessionEntry>();

let runtime: Promise<typeof Ort> | null = null;

/**
 * ONNX Runtime, loaded on the first inference rather than with the SDK, so a
 * consumer that never runs a local model (an app that only chats, a script
 * that only generates) neither loads nor has to ship its native binaries. A
 * failed load is not cached, so installing the runtime and calling again works.
 */
export function onnxRuntime(): Promise<typeof Ort> {
  runtime ??= import("onnxruntime-node").catch((err: unknown) => {
    runtime = null;
    throw new GptImgError("model.loadFailed", `ONNX Runtime could not be loaded: ${(err as Error)?.message ?? String(err)}`, { cause: err });
  });
  return runtime;
}

/** A float32 tensor for a model's input. */
export async function float32Tensor(data: Float32Array, dims: number[]): Promise<Ort.Tensor> {
  const ort = await onnxRuntime();
  return new ort.Tensor("float32", data, dims);
}

/**
 * Intra-op thread count per session. ONNX Runtime's CPU EP defaults to one
 * thread per core, which is fine for a single inference but pathological when
 * the same machine runs several GptImg processes — each grabs all cores and
 * they thrash the scheduler. Half the cores keeps a single call fast while
 * letting parallel callers coexist; one thread at least keeps tiny VMs
 * working. `policy.onnx.intraOpThreads` overrides it.
 */
function intraOpThreadCount(onnx: OnnxPolicy | undefined): number {
  if (onnx?.intraOpThreads !== undefined) return onnx.intraOpThreads;
  const cpus = os.cpus()?.length ?? 1;
  return Math.max(1, Math.floor(cpus / 2));
}

/**
 * Execution providers, priority-ordered. Default CPU, the only one guaranteed
 * present in onnxruntime-node; `policy.onnx.executionProviders` lists others
 * (e.g. `["coreml", "cpu"]`) for builds that ship them, and an unavailable one
 * fails at session creation.
 */
function executionProviders(onnx: OnnxPolicy | undefined): string[] {
  return onnx?.executionProviders ?? [...ONNX_DEFAULTS.executionProviders];
}

/** What an inference with `model` and this tuning depends on, for the result that reports it. */
export async function inferenceRecord(model: { key: string; name: string; sha256?: string | undefined }, onnx?: OnnxPolicy): Promise<InferenceRecord> {
  const ort = await onnxRuntime();
  return {
    model: { key: model.key, name: model.name, sha256: model.sha256 ?? null },
    runtime: { name: "onnxruntime-node", version: ort.env.versions.common ?? "unknown" },
    executionProviders: executionProviders(onnx),
    intraOpThreads: intraOpThreadCount(onnx),
  };
}

/**
 * Borrow a shared session for the entire model operation, including asynchronous
 * preprocessing and gaps between native runs. Admission is synchronous, before
 * creation is awaited, so release also waits for borrowers of a loading model.
 */
export async function withSession<T>(
  modelPath: string,
  onnx: OnnxPolicy | undefined,
  operation: (session: Ort.InferenceSession) => Promise<T>,
): Promise<T> {
  const providers = executionProviders(onnx);
  const threads = intraOpThreadCount(onnx);
  const key = `${modelPath}\0${providers.join(",")}\0${threads}`;
  let entry = sessions.get(key);
  if (!entry) {
    const created: SessionEntry = {
      modelPath,
      pending: createSession(modelPath, providers, threads),
      borrowers: 0,
      idle: Promise.resolve(),
      signalIdle: () => {},
    };
    sessions.set(key, created);
    created.pending.catch(() => {
      if (sessions.get(key) === created) sessions.delete(key);
    });
    entry = created;
  }
  if (entry.borrowers++ === 0) {
    entry.idle = new Promise<void>((resolve) => { entry.signalIdle = resolve; });
  }
  try {
    return await operation(await entry.pending);
  } finally {
    if (--entry.borrowers === 0) entry.signalIdle();
  }
}

/**
 * Await actual native settlement and classify run failures for every model.
 * A per-call failure does not invalidate the shared session. Already typed
 * failures and cancellation retain their identity for the caller's owner.
 */
export async function runSession(
  session: Ort.InferenceSession,
  feeds: Ort.InferenceSession.FeedsType,
): Promise<Ort.InferenceSession.ReturnType> {
  try {
    return await session.run(feeds);
  } catch (err) {
    if (err instanceof GptImgError) throw err;
    // A native abort leaves the SDK as its own cancellation, with the original as cause.
    if (isAbortError(err)) throw cancelledError(err);
    throw new GptImgError(
      "model.runFailed",
      `ONNX inference failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Retire the current cache, then release it once all admitted operations settle.
 * New callers can load and use a fresh generation independently. Concurrent
 * releases share disposal; failed disposal stays owned for a later retry.
 */
export async function releaseSessions(): Promise<number> {
  for (const entry of sessions.values()) retired.add(entry);
  sessions.clear();
  const outcomes = await Promise.allSettled([...retired].map(disposeSession));
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value).length;
}

function disposeSession(entry: SessionEntry): Promise<boolean> {
  entry.disposal ??= (async () => {
    await entry.idle;
    let session: Ort.InferenceSession;
    try {
      session = await entry.pending;
    } catch {
      // Failed creation owns no native session to dispose.
      retired.delete(entry);
      return false;
    }
    try {
      await session.release();
    } catch (cause) {
      throw new GptImgError("internal.unexpected", `Failed to release ONNX session for ${entry.modelPath}.`, {
        cause,
        // A rejecting native disposer may already have freed part of its resources.
        effect: "unknown",
        subject: entry.modelPath,
      });
    }
    retired.delete(entry);
    return true;
  })().finally(() => { entry.disposal = undefined; });
  return entry.disposal;
}

async function createSession(modelPath: string, providers: string[], threads: number): Promise<Ort.InferenceSession> {
  const ort = await onnxRuntime();
  try {
    return await ort.InferenceSession.create(modelPath, {
      executionProviders: providers,
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      // ONNX Runtime otherwise writes optimizer warnings directly to stderr.
      // A library SDK must remain stream-silent; actual load/run failures still
      // surface as typed errors through the public call.
      logSeverityLevel: 3,
    });
  } catch (err) {
    throw new GptImgError(
      "model.loadFailed",
      `Failed to load ONNX session for ${modelPath}: ${(err as Error).message}`,
      { cause: err, subject: modelPath },
    );
  }
}
