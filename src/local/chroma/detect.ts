import path from "node:path";
import { LocalOpError, toAbortError } from "../../errors.js";
import { loadRawRGBA } from "../../image/bridge.js";
import { readSidecar } from "../../sidecar/read.js";
import type {
  ChromaArgs,
  ChromaRegionSummary,
  ChromaStats,
  InspectArgs,
} from "../../types.js";
import {
  distanceMap,
  rgbaBufferToLab,
  type GaussianModel,
} from "./backgroundModel.js";
import {
  buildLabelMask,
  computeComponentProps,
  connectedComponents,
} from "./components.js";
import {
  resolveAutoKey,
  resolveExplicitKey,
  type KeyResolution,
} from "./detectKey.js";
import { CHROMA_DEFAULTS } from "./defaults.js";
import { close } from "./morphology.js";
import { scoreRegions } from "./scoreRegions.js";

export { CHROMA_DEFAULTS } from "./defaults.js";

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}

export interface DetectionInput {
  in: string;
  preserveInterior?: boolean;
  key?: ChromaArgs["key"];
  innerThreshold?: number;
  metric?: ChromaArgs["metric"];
  borderSample?: number;
  fillHoles?: boolean;
  strictConfidence?: number;
}

export interface DetectionResult {
  width: number;
  height: number;
  /** Original RGBA buffer (unchanged by detection). */
  rgba: Uint8Array;
  /** Per-pixel Mahalanobis distance to the background model. */
  distance: Float32Array;
  /** Binary mask (0/255) of the accepted-as-background pixels. */
  accepted: Uint8Array;
  keyResolution: KeyResolution;
  stats: ChromaStats;
}

function isChromaArgsInput(x: DetectionInput | InspectArgs): x is DetectionInput {
  return true;
}

async function loadKeyFromSidecar(inputPath: string): Promise<string> {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath);
  const dot = base.lastIndexOf(".");
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  // Strip trailing -NN if present (multi-output naming).
  const stem = rawStem.replace(/-\d+$/, "");
  const stemFull = path.join(dir, stem);
  const sidecar = await readSidecar(stemFull);
  const req = sidecar.request as Record<string, unknown> | undefined;
  const chroma = req?.chroma as { color?: string } | undefined;
  if (!chroma || typeof chroma.color !== "string") {
    throw new LocalOpError(
      "image.formatUnknown",
      `Sidecar at ${stemFull}.json does not contain request.chroma.color`,
    );
  }
  return chroma.color;
}

async function resolveKey(
  args: DetectionInput,
  rgba: Uint8Array,
  width: number,
  height: number,
  lab: Float32Array,
  borderDepth: number,
): Promise<KeyResolution> {
  const keyArg = args.key ?? CHROMA_DEFAULTS.key;
  if (keyArg === "auto") {
    return resolveAutoKey(rgba, width, height, lab, borderDepth);
  }
  if (keyArg === "from-sidecar") {
    const hex = await loadKeyFromSidecar(args.in);
    return resolveExplicitKey(hex, "sidecar");
  }
  return resolveExplicitKey(keyArg, "explicit");
}

function detectNoKey(model: GaussianModel, source: KeyResolution["source"]): boolean {
  if (source !== "auto") return false;
  if (model.sampleCount === 0) return false;
  const stds = [
    Math.sqrt(model.cov[0]),
    Math.sqrt(model.cov[3]),
    Math.sqrt(model.cov[5]),
  ];
  return stds.some((s) => s > 25);
}

function detectSubjectCollision(
  distance: Float32Array,
  acceptedMask: Uint8Array,
  innerThreshold: number,
): boolean {
  let totalRejected = 0;
  let nearKeyButRejected = 0;
  for (let i = 0; i < acceptedMask.length; i++) {
    if (acceptedMask[i]! === 0) {
      totalRejected++;
      if (distance[i]! < innerThreshold) {
        nearKeyButRejected++;
      }
    }
  }
  if (totalRejected === 0) return false;
  return nearKeyButRejected / totalRejected > 0.05;
}

export async function detect(
  args: DetectionInput,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<DetectionResult> {
  const { signal } = opts;
  if (!isChromaArgsInput(args)) {
    throw new LocalOpError("image.formatUnknown", "Invalid detection input");
  }
  const preserveInterior = args.preserveInterior ?? CHROMA_DEFAULTS.preserveInterior;
  const innerThreshold = args.innerThreshold ?? CHROMA_DEFAULTS.innerThreshold;
  const borderSample = args.borderSample ?? CHROMA_DEFAULTS.borderSample;
  const fillHoles = args.fillHoles ?? CHROMA_DEFAULTS.fillHoles;

  throwIfAborted(signal);
  const { data: rgba, width, height } = await loadRawRGBA(args.in);
  const totalPixels = width * height;
  throwIfAborted(signal);
  const lab = rgbaBufferToLab(rgba, width, height);
  const keyRes = await resolveKey(args, rgba, width, height, lab, borderSample);
  throwIfAborted(signal);
  const distance = distanceMap(lab, keyRes.model);

  const candidate = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    candidate[i] = distance[i]! <= innerThreshold ? 255 : 0;
  }
  const candidateClosed = fillHoles ? close(candidate, width, height, 1) : candidate;

  throwIfAborted(signal);
  const { labels, numComponents } = connectedComponents(
    candidateClosed,
    width,
    height,
  );
  const props = computeComponentProps(labels, numComponents, width, height, distance);
  const scored = scoreRegions(props, {
    preserveInterior,
    totalPixels,
    innerThreshold,
    strictConfidence: args.strictConfidence,
  });

  const acceptedLabels = new Set<number>();
  for (const s of scored) {
    if (s.accepted) acceptedLabels.add(s.props.label);
  }
  const accepted = buildLabelMask(labels, acceptedLabels);

  let removedPixels = 0;
  for (let p = 0; p < totalPixels; p++) {
    if (accepted[p]! > 0) removedPixels++;
  }
  const removedFraction = totalPixels > 0 ? removedPixels / totalPixels : 0;

  const regionsRemoved: ChromaRegionSummary[] = scored
    .filter((s) => s.accepted)
    .map((s) => ({
      area: s.props.area,
      meanConfidence: s.confidence,
      touchesBorder: s.props.touchesBorder,
    }));
  const meanConfidence =
    regionsRemoved.length > 0
      ? regionsRemoved.reduce((acc, r) => acc + r.meanConfidence, 0) /
        regionsRemoved.length
      : 0;

  const stats: ChromaStats = {
    key: keyRes.hex,
    keySource: keyRes.source,
    preserveInterior,
    removedPixels,
    removedFraction,
    regionsRemoved,
    meanConfidence,
    noKeyDetected: detectNoKey(keyRes.model, keyRes.source),
    subjectKeyCollisionRisk: detectSubjectCollision(distance, accepted, innerThreshold),
    bgModel: {
      meanLab: keyRes.model.mean,
      covEigs: keyRes.model.eigenvalues,
    },
  };

  return {
    width,
    height,
    rgba,
    distance,
    accepted,
    keyResolution: keyRes,
    stats,
  };
}
