// One branch per supported model id, holding exactly what that model needs beyond the plain
// request of its endpoint (ai-model-routing-conventions). An id with no branch gets the plain
// request, and OpenAI's answer at call time is the verdict on it.

type RequestBranch = (request: Record<string, unknown>) => Record<string, unknown>;

const plain: RequestBranch = (request) => request;

/** Branches for `images.generate` and `images.edit`. */
export const IMAGE_REQUEST_BRANCHES: Readonly<Record<string, RequestBranch>> = {
  // Quality low through max, transparent backgrounds; needs nothing beyond the plain request.
  "gpt-image-2.5-flare": plain,
  // Same parameters as flare; needs nothing beyond the plain request.
  "gpt-image-2.5-sunburst": plain,
  // Quality caps at high and a transparent background is in preview; the caller's values pass
  // through and OpenAI judges them, so it needs nothing beyond the plain request.
  "gpt-image-2": plain,
};

/** Branches for the vision check's `chat.completions.create`. */
export const VISION_REQUEST_BRANCHES: Readonly<Record<string, RequestBranch>> = {
  // Reasoning models: no temperature is sent, the verdict uses no output ceiling, and `detail`
  // passes through as the caller set it, so each needs nothing beyond the plain request.
  "gpt-6-luna": plain,
  "gpt-6.1-sol": plain,
  "gpt-6-astra": plain,
  "gpt-5.6-luna": plain,
  "gpt-5.6-terra": plain,
  "gpt-5.6-sol": plain,
};

export function buildImageRequest(model: string, request: Record<string, unknown>): Record<string, unknown> {
  return (IMAGE_REQUEST_BRANCHES[model] ?? plain)(request);
}

export function buildVisionRequest(model: string, request: Record<string, unknown>): Record<string, unknown> {
  return (VISION_REQUEST_BRANCHES[model] ?? plain)(request);
}
