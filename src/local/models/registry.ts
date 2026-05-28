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
 * The URL targets `main`. Swap `main` for a `<commit-sha>` after the first
 * verified download to lock the version.
 */
export const BIREFNET: ModelEntry = {
  name: "birefnet-general-fp16-v1.onnx",
  url: "https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model_fp16.onnx",
  inputSize: 1024,
};
