/**
 * Model registry. One entry per AI artifact gptimg can lazily fetch.
 *
 * Each entry pins:
 *   name      — cache filename. Bump the suffix when changing models so old
 *               and new can coexist for rollback.
 *   url       — single source of truth, fetched on first use. Prefer
 *               commit-pinned HuggingFace URLs (`/resolve/<commit-sha>/...`)
 *               over `/resolve/main/...`. The commit pin is how we get
 *               reproducible downloads without maintaining a SHA-256 by hand.
 *   inputSize — square spatial dimension the model expects.
 */

/**
 * Sourcing decision (managed-runtime-dependencies convention).
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
 * Pin currency: as of 2026-06-27 both entries were confirmed to sit on their
 * repo's latest commit (checked against the HuggingFace API), so neither is a
 * stale mid-history pin. What remains open is model *selection* quality — whether
 * these are the best models for matting/upscale versus newer alternatives — which
 * is gated on re-validating output against the test images, not on a commit bump
 * (see each entry's note).
 */

export interface ModelEntry {
  name: string;
  url: string;
  inputSize: number;
  /**
   * Pinned content hash, verified after download. Optional so ad-hoc entries
   * (e.g. tests) can omit it; every shipped model sets it.
   */
  sha256?: string;
}

/**
 * BiRefNet (general) ONNX. Community-exported ONNX of the MIT-licensed
 * upstream BiRefNet (https://huggingface.co/ZhengPeng7/BiRefNet). FP16
 * variant — about 490 MB, quality close to FP32 for matting work.
 *
 * Pinned to an immutable commit so the download is reproducible. The file at
 * this commit is sha256
 * 3654c741eb80bd926ada8fed1713b506ccf8d30eb1f6487e87eb9f234f33df09
 * (489,666,272 bytes) — verified byte-identical to the version this build was
 * validated against. To adopt a new revision, bump `name` and repin `url` to
 * the new commit.
 *
 * This is the model we have verified, not necessarily the best one available.
 * Newer BiRefNet exports (or other matting models entirely) may give better
 * cutouts; treat swapping it as an open option, but re-validate against the
 * test images before changing the pin — output quality is the gate, not
 * novelty.
 */
export const BIREFNET: ModelEntry = {
  name: "birefnet-general-fp16-v1.onnx",
  url: "https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67/onnx/model_fp16.onnx",
  inputSize: 1024,
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
 * Pinned to an immutable commit so the download is reproducible. The fp32 file
 * at this commit is sha256
 * 987d88b356554161cbb8f67b7a8f4162cad6dc147839c344e3d5142140f25d6f
 * (53,827,735 bytes) — verified here against the version the upscaler was
 * built and seam-tested against. To adopt a new revision, bump `name` and
 * repin `url` to the new commit, then re-validate output quality.
 *
 * `inputSize` is 0: the graph has dynamic spatial dims. It only requires H and
 * W to be multiples of window_size (8); the upscale wrapper reflect-pads to /8
 * and crops back, and tiles large inputs to bound memory.
 */
export const SWIN2SR_X4: ModelEntry = {
  name: "swin2sr-realworld-x4-bsrgan-psnr-v1.onnx",
  url: "https://huggingface.co/onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX/resolve/9b3baf051f6708d0b697580489e4415b64c7378e/onnx/model.onnx",
  inputSize: 0,
  sha256: "987d88b356554161cbb8f67b7a8f4162cad6dc147839c344e3d5142140f25d6f",
};

/**
 * Registry of installable models, keyed by short name. `model install <name>`
 * and `model list` resolve against this map; add a `ModelEntry` here (with its
 * pinned `url` and `sha256`) to make a new model installable.
 */
export const MODELS = {
  birefnet: BIREFNET,
  swin2sr: SWIN2SR_X4,
} as const;

export type ModelKey = keyof typeof MODELS;
