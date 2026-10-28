import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PartialImage } from "gptimgsdk/types";

/**
 * The latest preview per chat, owned in staging until replaced or cleared. A
 * chat's previews and its final clear take turns in the order they arrive.
 */
export class DraftPreviews {
  readonly #staging: string;
  readonly #publish: (sessionId: string, path: string | null) => void;
  readonly #shown = new Map<string, string>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(staging: string, publish: (sessionId: string, path: string | null) => void) {
    this.#staging = staging;
    this.#publish = publish;
  }

  show(sessionId: string, draft: PartialImage | null): Promise<void> {
    const next = () => this.#show(sessionId, draft);
    const run = (this.#queues.get(sessionId) ?? Promise.resolve()).then(next, next);
    this.#queues.set(sessionId, run);
    return run;
  }

  async #show(sessionId: string, draft: PartialImage | null): Promise<void> {
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
