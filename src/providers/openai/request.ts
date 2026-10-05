// One branch per supported model id, holding exactly what that model needs beyond the plain
// request of its endpoint (ai-model-routing-conventions). An id with no branch gets the plain
// request, and OpenAI's answer at call time is the verdict on it.

type ImageBranch = (request: Record<string, unknown>) => Record<string, unknown>;
type VisionBranch = (request: Record<string, unknown>, reasoning: string | undefined) => Record<string, unknown>;

const plainImage: ImageBranch = (request) => request;

/** Branches for `images.generate` and `images.edit`. */
export const IMAGE_REQUEST_BRANCHES: Readonly<Record<string, ImageBranch>> = {
  // Its values are checked against its row before the call and sent as chosen; it needs
  // nothing beyond the plain request.
  "gpt-image-2.5-flare": plainImage,
  // Same parameters as flare; needs nothing beyond the plain request.
  "gpt-image-2.5-sunburst": plainImage,
  // Quality caps at high, which its row's list holds; needs nothing beyond the plain request.
  "gpt-image-2": plainImage,
};

// Reasoning models: no temperature is sent, the verdict uses no output ceiling, and `detail`
// passes through as the caller set it. The chosen effort, the row's default when the recipe
// sets none, is sent as `reasoning_effort`.
const effort: VisionBranch = (request, reasoning) => ({ ...request, reasoning_effort: reasoning });

/** Branches for the vision check's `chat.completions.create`. */
export const VISION_REQUEST_BRANCHES: Readonly<Record<string, VisionBranch>> = {
  "gpt-6-astra": effort,
  "gpt-6.1-sol": effort,
  "gpt-5.6-terra": effort,
  "gpt-6-luna": effort,
};

export function buildImageRequest(model: string, request: Record<string, unknown>): Record<string, unknown> {
  return (IMAGE_REQUEST_BRANCHES[model] ?? plainImage)(request);
}

/** An id with no branch sends the caller's effort only when the caller set one. */
export function buildVisionRequest(
  model: string,
  request: Record<string, unknown>,
  reasoning: string | undefined,
): Record<string, unknown> {
  const branch = VISION_REQUEST_BRANCHES[model];
  if (branch) return branch(request, reasoning);
  return reasoning === undefined ? request : { ...request, reasoning_effort: reasoning };
}
