/**
 * Shared ONNX Runtime session creation for all local models (BiRefNet today,
 * the upscaler next). Owns the runtime tuning knobs and caches one session per
 * model path so multiple models coexist without evicting each other.
 *
 * Model-specific tensor pre/post-processing lives in each model's own module;
 * only the session lifecycle is shared here.
 */

import os from "node:os";
import * as ort from "onnxruntime-node";
import { LocalOpError } from "../../errors.js";

const ONNX_THREADS_ENV = "GPTIMG_ONNX_INTRA_OP_THREADS";
const ONNX_EP_ENV = "GPTIMG_ONNX_EP";

// One creation per model path: concurrent first callers await the same promise
// instead of each loading its own copy of the weights.
const sessions = new Map<string, Promise<ort.InferenceSession>>();

/**
 * Intra-op thread count per session. ONNX Runtime's CPU EP defaults to one
 * thread per core, which is fine for a single inference but pathological when
 * the same machine runs multiple GptImg processes — each grabs all cores and
 * they thrash the scheduler. Halving the core count keeps a single call fast
 * while letting parallel callers coexist. A single-core minimum keeps tiny VMs
 * working. `GPTIMG_ONNX_INTRA_OP_THREADS` overrides for explicit tuning.
 */
function intraOpThreadCount(): number {
  const override = process.env[ONNX_THREADS_ENV];
  if (override !== undefined && override.length > 0) {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 1) {
      throw new LocalOpError(
        "model.loadFailed",
        `${ONNX_THREADS_ENV} must be a positive integer; got "${override}".`,
      );
    }
    return n;
  }
  const cpus = os.cpus()?.length ?? 1;
  return Math.max(1, Math.floor(cpus / 2));
}

/**
 * Execution providers, priority-ordered. Defaults to CPU (the only EP
 * guaranteed present in onnxruntime-node). `GPTIMG_ONNX_EP` takes a
 * comma-separated list (e.g. `coreml,cpu`) for builds that ship an accelerated
 * EP; an unavailable EP fails loudly at session creation.
 */
function executionProviders(): string[] {
  const override = process.env[ONNX_EP_ENV];
  if (override === undefined) return ["cpu"];
  const eps = override
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return eps.length > 0 ? eps : ["cpu"];
}

/**
 * Create (or return a cached) ONNX inference session for `modelPath`. Sessions
 * are cached per path for the lifetime of the process, and a creation still in
 * flight is shared with every caller that asks meanwhile. A failed creation is
 * dropped from the cache so the next call tries again.
 */
export function loadSession(modelPath: string): Promise<ort.InferenceSession> {
  const cached = sessions.get(modelPath);
  if (cached) return cached;
  const created = createSession(modelPath);
  sessions.set(modelPath, created);
  created.catch(() => {
    if (sessions.get(modelPath) === created) sessions.delete(modelPath);
  });
  return created;
}

async function createSession(modelPath: string): Promise<ort.InferenceSession> {
  try {
    return await ort.InferenceSession.create(modelPath, {
      executionProviders: executionProviders(),
      intraOpNumThreads: intraOpThreadCount(),
      interOpNumThreads: 1,
      // ONNX Runtime otherwise writes optimizer warnings directly to stderr.
      // A library SDK must remain stream-silent; actual load/run failures still
      // surface as typed errors through the public call.
      logSeverityLevel: 3,
    });
  } catch (err) {
    throw new LocalOpError(
      "model.loadFailed",
      `Failed to load ONNX session for ${modelPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
