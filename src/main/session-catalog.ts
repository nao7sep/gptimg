// The sessions folder's listing, owned by main. Every session.json is read
// only when a folder is first listed (at startup) and when the sessions folder
// setting changes; after that each saved, renamed or trashed session updates
// its one entry, and every window is told that one change. A session folder
// added or edited outside GptImg shows once the folder is listed anew.
import { applySessionChange, type SessionChange, type SessionSummary } from "../shared/session.ts";
import type { SessionsListing } from "../shared/api.ts";
import { listSessions } from "./sessions.ts";

export class SessionCatalog {
  #root = "";
  #sessions: SessionSummary[] | null = null;
  #unreadable = 0;
  // Listing and changes take turns, so a change sent to the windows is always
  // in the listing any later reply carries, and never in an earlier one.
  #tail: Promise<unknown> = Promise.resolve();
  readonly #notify: (change: SessionChange) => void;

  constructor(notify: (change: SessionChange) => void) {
    this.#notify = notify;
  }

  /** The listing of `root`, read from disk when `root` is new or the last read failed. */
  list(root: string): Promise<SessionsListing> {
    const run = this.#tail.then(async () => {
      if (root !== this.#root || !this.#sessions) {
        this.#root = root;
        this.#sessions = null;
        const listing = await listSessions(root);
        this.#sessions = listing.sessions;
        this.#unreadable = listing.unreadable;
      }
      return { sessions: this.#sessions, unreadable: this.#unreadable };
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** The session at folder `id` in `root` is now `session`, or is gone when null. */
  change(root: string, id: string, session: SessionSummary | null): void {
    this.#tail = this.#tail.then(() => {
      if (root !== this.#root) return;
      if (this.#sessions) this.#sessions = applySessionChange(this.#sessions, id, session);
      this.#notify({ kind: "entry", id, session });
    });
  }

  /** The sessions folder setting changed: the next listing reads the new folder. */
  folderChanged(): void {
    this.#tail = this.#tail.then(() => {
      this.#sessions = null;
      this.#notify({ kind: "folder" });
    });
  }
}
