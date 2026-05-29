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

export interface ModelEntry {
  name: string;
  url: string;
  inputSize: number;
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
};
