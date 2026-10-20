/**
 * Model registry. One entry per AI model gptimgsdk can install.
 *
 * Each entry pins:
 *   name      — cache filename. Bump the suffix when changing models.
 *   url       — single source of truth, fetched by `model.install`. Prefer
 *               commit-pinned HuggingFace URLs (`/resolve/<commit-sha>/...`)
 *               over `/resolve/main/...`.
 *   inputSize — square spatial dimension the model expects.
 *   byteSize  — exact artifact length, enforced before and during acquisition.
 *   sha256    — independently pinned digest verified before publication.
 */

/**
 * Sourcing decision (managed-runtime-dependencies-conventions).
 *
 * Both models are fetched from the `onnx-community` HuggingFace org — a
 * third-party ONNX re-export, not the model authors (who publish PyTorch only)
 * and not a fleet-owned build. This is a deliberately accepted third-party
 * source, not an oversight: no official ONNX of these models exists; the
 * upstream authors are MIT/Apache and reputable; `onnx-community` is an
 * established HuggingFace organization, not a single-maintainer host; and every
 * entry below is pinned to an immutable commit and verified by SHA-256 after
 * download, so a changed or tampered file fails the install. Revisit if an
 * author-published ONNX or a fleet-owned export becomes available.
 *
 * Whether these are the best models for matting and upscaling is open; changing
 * one is gated on re-validating output against the test images, not on novelty.
 */

export interface ModelEntry {
  name: string;
  url: string;
  inputSize: number;
  /** Exact artifact bytes, enforced before and during acquisition. */
  byteSize: number;
  /** Pinned content hash, verified before publication. */
  sha256: string;
}

/**
 * BiRefNet (general) ONNX. Community-exported ONNX of the MIT-licensed
 * upstream BiRefNet (https://huggingface.co/ZhengPeng7/BiRefNet). FP16
 * variant, half the size of FP32 with quality close to it for matting work.
 *
 * Pinned to an immutable commit so the download is reproducible. To adopt a
 * new revision, bump `name` and repin `url`, `byteSize` and `sha256`.
 */
export const BIREFNET: ModelEntry = {
  name: "birefnet-general-fp16-v1.onnx",
  url: "https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67/onnx/model_fp16.onnx",
  inputSize: 1024,
  byteSize: 489_666_272,
  sha256: "3654c741eb80bd926ada8fed1713b506ccf8d30eb1f6487e87eb9f234f33df09",
};

/**
 * Swin2SR real-world ×4 super-resolution ONNX. Apache-2.0, auto-exported from
 * the upstream `caidas/swin2SR-realworld-sr-x4-64-bsrgan-psnr` by the same
 * `onnx-community` org we already trust for BiRefNet. The "-psnr" (distortion-
 * optimized) variant is chosen deliberately: it enlarges faithfully and does
 * not hallucinate texture the way a perceptual GAN (e.g. Real-ESRGAN x4plus)
 * does — the right trade for clean icon/logo/illustration content.
 *
 * Pinned to an immutable commit so the download is reproducible. To adopt a
 * new revision, bump `name` and repin `url`, `byteSize` and `sha256`, then
 * re-validate output quality.
 *
 * `inputSize` is 0: the graph has dynamic spatial dims. It only requires H and
 * W to be multiples of window_size (8); the upscale wrapper reflect-pads to /8
 * and crops back, and tiles large inputs to bound memory.
 */
export const SWIN2SR_X4: ModelEntry = {
  name: "swin2sr-realworld-x4-bsrgan-psnr-v1.onnx",
  url: "https://huggingface.co/onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX/resolve/9b3baf051f6708d0b697580489e4415b64c7378e/onnx/model.onnx",
  inputSize: 0,
  byteSize: 53_827_735,
  sha256: "987d88b356554161cbb8f67b7a8f4162cad6dc147839c344e3d5142140f25d6f",
};

/**
 * Registry of installable models, keyed by short name. `model.install(key)`
 * and `model.list()` resolve against this map; add a `ModelEntry` here (with its
 * pinned `url` and `sha256`) to make a new model installable.
 */
export const MODELS = {
  birefnet: BIREFNET,
  swin2sr: SWIN2SR_X4,
} as const;

export type ModelKey = keyof typeof MODELS;
