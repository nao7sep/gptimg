import type { ResolvedProfile, VisionVerdict } from "../types.js";

export interface ProviderImageResult {
  /** Raw response from the provider, suitable for sidecar capture. */
  raw: unknown;
  /**
   * Image bytes in response order. `data` is `null` for any item that
   * failed to materialize (e.g., missing both b64 and url, or URL fetch
   * failed). The array length matches `response.data.length` so positional
   * mapping to file indices is preserved.
   */
  images: Array<{ data: Uint8Array | null; error?: string }>;
}

export interface ProviderVisionResult {
  raw: unknown;
  verdict: VisionVerdict;
}

export interface GenerateProviderArgs {
  prompt: string;
  params: Record<string, unknown>;
  profile: ResolvedProfile;
}

export interface EditProviderArgs {
  prompt: string;
  imagePath: string;
  maskPath?: string;
  params: Record<string, unknown>;
  profile: ResolvedProfile;
}

export interface VisionProviderArgs {
  check: string;
  images: Array<{ data: Uint8Array; format: string }>;
  params: Record<string, unknown>;
  profile: ResolvedProfile;
}

export interface Provider {
  readonly name: string;
  generate(args: GenerateProviderArgs): Promise<ProviderImageResult>;
  edit(args: EditProviderArgs): Promise<ProviderImageResult>;
  vision(args: VisionProviderArgs): Promise<ProviderVisionResult>;
}
