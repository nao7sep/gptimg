import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PartialDraft } from "./sdk-protocol.ts";

/** The latest preview per chat, owned in staging until replaced or cleared. */
export class DraftPreviews {
  readonly #staging: string;
  readonly #publish: (sessionId: string, path: string | null) => void;
  readonly #shown = new Map<string, string>();
  readonly #generation = new Map<string, number>();

  constructor(staging: string, publish: (sessionId: string, path: string | null) => void) {
    this.#staging = staging;
    this.#publish = publish;
  }

  async show(sessionId: string, draft: PartialDraft | null): Promise<void> {
    const mine = (this.#generation.get(sessionId) ?? 0) + 1;
    this.#generation.set(sessionId, mine);
    if (!draft) {
      const previous = this.#shown.get(sessionId);
      this.#shown.delete(sessionId);
      this.#publish(sessionId, null);
      if (previous) await rm(previous, { force: true }).catch(() => undefined);
      return;
    }
    const path = join(this.#staging, `draft-${randomUUID().slice(0, 8)}.${draft.format === "jpeg" ? "jpg" : draft.format}`);
    try {
      await mkdir(this.#staging, { recursive: true, mode: 0o700 });
      await writeFile(path, draft.data, { mode: 0o600 });
      if (this.#generation.get(sessionId) !== mine) {
        await rm(path, { force: true }).catch(() => undefined);
        return;
      }
      const previous = this.#shown.get(sessionId);
      this.#shown.set(sessionId, path);
      this.#publish(sessionId, path);
      if (previous) await rm(previous, { force: true }).catch(() => undefined);
    } catch {
      // A draft is only a preview; its write or cleanup cannot fail the turn.
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}
