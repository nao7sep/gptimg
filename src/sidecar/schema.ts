import { z } from "zod";

/**
 * The shape of a current sidecar, checked on read and on write
 * (store-recovery-conventions). The provider's response stays opaque but must
 * be present; unrecognized keys are kept as they are.
 */
export const SidecarSchema = z.looseObject({
  request: z.record(z.string(), z.unknown()),
  response: z.custom<unknown>((value) => value !== undefined, { message: "Required" }),
  files: z.array(
    z.looseObject({
      index: z.number().int(),
      name: z.string(),
      sha256: z.string(),
      format: z.string(),
    }),
  ),
});
