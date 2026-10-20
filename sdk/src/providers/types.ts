import type { Logger } from "../events/index.ts";
import type { NetworkBudget } from "../network/defaults.ts";
import type { Credentials, VisionDetail, VisionVerdict } from "../types.ts";

export interface ProviderImageResult {
  /** Raw response from the provider, suitable for sidecar capture. */
  raw: unknown;
  /**
   * Image bytes in response order. `data` is `null` for any item that
   * failed to materialize (e.g., missing both b64 and url, or URL fetch
   * failed). The array length matches `response.data.length` so positional
   * mapping to file indices is preserved. `code` marks an item the
   * provider's moderation blocked, as against one that went missing.
   */
  images: Array<{ data: Uint8Array | null; error?: string; code?: "provider.moderationBlocked"; safeReason?: string | null }>;
}

export interface ProviderVisionResult {
  raw: unknown;
  verdict: VisionVerdict;
}

export interface ProviderNetworkCtx {
  /** Budget for the primary AI call. */
  primary: NetworkBudget;
  /** Budget for any image-URL downloads triggered by the response. */
  download: NetworkBudget;
  logger?: Logger | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerateProviderArgs {
  prompt: string;
  params: Record<string, unknown>;
  credentials: Credentials;
  network: ProviderNetworkCtx;
}

export interface EditProviderArgs {
  prompt: string;
  imagePath: string;
  maskPath?: string | undefined;
  params: Record<string, unknown>;
  credentials: Credentials;
  network: ProviderNetworkCtx;
}

export interface VisionProviderArgs {
  check: string;
  images: Array<{ data: Uint8Array; format: string; detail?: VisionDetail }>;
  params: Record<string, unknown>;
  credentials: Credentials;
  network: ProviderNetworkCtx;
}

/** An image sent to a chat: its name (for the records, never the bytes), its bytes and their format. */
export interface ChatImage {
  name: string;
  data: Uint8Array;
  format: string;
}

/** One earlier turn, its images loaded, for a request that carries the conversation itself. */
export interface ChatHistoryTurn {
  role: "user" | "assistant";
  text: string;
  images: ChatImage[];
}

export interface ChatProviderArgs {
  message: string;
  images: ChatImage[];
  /** Where the first image may change: its transparent pixels. Its `guide` is shown to the assistant, which writes the image request. */
  mask?: (ChatImage & { guide?: { image: ChatImage; text: string } | undefined }) | undefined;
  /** Continue OpenAI's copy of the conversation from this response. */
  previousResponseId?: string | undefined;
  /** The earlier turns, loaded only when they are sent: without a previous response, or when it is gone. */
  loadHistory: () => Promise<ChatHistoryTurn[]>;
  params: { model: string; reasoning?: string | undefined; instructions: string; tool: Record<string, unknown> };
  credentials: Credentials;
  network: ProviderNetworkCtx;
  /** Set when the tool asks for partial images: the response is streamed and each one is handed over as it arrives. */
  onPartialImage?: ((image: { callId: string; index: number; data: Uint8Array }) => void) | undefined;
}

export interface ProviderChatResult extends ProviderImageResult {
  text: string;
  responseId: string;
  resumed: "chain" | "resent" | null;
  /** How many earlier turns the request carried; 0 when OpenAI's copy carried them. */
  historyTurns: number;
  incomplete: string | null;
}

export interface Provider {
  readonly name: string;
  generate(args: GenerateProviderArgs): Promise<ProviderImageResult>;
  edit(args: EditProviderArgs): Promise<ProviderImageResult>;
  vision(args: VisionProviderArgs): Promise<ProviderVisionResult>;
  chat(args: ChatProviderArgs): Promise<ProviderChatResult>;
}
