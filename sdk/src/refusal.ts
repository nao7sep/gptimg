/**
 * Refusals (sdk-conventions, *A refusal is a result*). When the SDK, or a
 * provider on its behalf, decides an operation should not proceed, the verb
 * returns `{ status: "refused", refusal }` instead of throwing. Deep code
 * signals the decision with `refuse()`; the verb boundary (`withVerbLogger`)
 * turns the signal into the result, so every verb refuses the same way.
 */

export const REFUSAL_CODES = [
  // A destination the call did not ask to replace already exists.
  "output.exists",
  // Two names differ only by letter case where the volume treats them as one.
  "output.caseConflict",
  // Two Unicode spellings of one name would create separate files.
  "output.normalizationConflict",
  // An overwrite would leave numbered siblings of an earlier, larger run.
  "output.staleSiblings",
  // A live call in this process holds an overlapping output group.
  "output.busy",
  // The sidecar beside an image does not describe that image.
  "sidecar.imageMismatch",
  // The image provider's moderation declined the request.
  "provider.moderationBlocked",
  // The vision model declined to answer.
  "provider.refused",
  // The provider's content filter stopped the answer.
  "provider.contentFiltered",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  code: RefusalCode;
  /** English, diagnostic; consumers present the code through their own copy. */
  message: string;
  /** The path or request the refusal concerns, when there is one. */
  subject?: string;
  /**
   * The provider's documented reason for declining, extracted from its
   * documented field only and safe to present beneath the consumer's own copy;
   * null when the provider gave none or the refusal is the SDK's own.
   */
  safeReason: string | null;
}

/** The internal signal `refuse()` throws; never leaves the SDK. */
export class RefusalSignal extends Error {
  readonly refusal: Refusal;
  /** The paid answer the refusal arrived in, when the provider answered with one; set where it is caught. */
  response?: Record<string, unknown>;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "RefusalSignal";
    this.refusal = refusal;
  }

  /** The refusal's code, so internal callers can branch on it as on an error's. */
  get code(): RefusalCode {
    return this.refusal.code;
  }
}

export function refuse(
  code: RefusalCode,
  message: string,
  options: { subject?: string; safeReason?: string | null } = {},
): never {
  throw new RefusalSignal({
    code,
    message,
    ...(options.subject !== undefined && { subject: options.subject }),
    safeReason: options.safeReason ?? null,
  });
}

/** What a verb returns when it refused: nothing was written, and a provider's refusal is never resent. */
export interface RefusedResult {
  status: "refused";
  refusal: Refusal;
  /**
   * The provider's response when the refusal came in a paid answer (a vision
   * model's refusal or content filter), with its token `usage`, credentials
   * masked; absent when the call was refused before or without one.
   */
  response?: Record<string, unknown>;
  /** The call's log, or null when no log was written. */
  logPath: string | null;
}
