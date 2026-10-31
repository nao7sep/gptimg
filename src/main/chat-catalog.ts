// The chats folder's listing, owned by main. Every chat.json is read
// only when a folder is first listed (at startup) and when the chats folder
// setting changes; after that each saved, renamed or trashed chat updates
// its one entry, and every window is told that one change. A chat folder
// added or edited outside GptImg shows once the folder is listed anew.
import { applyChatChange, summarize, type ChatChange, type ChatSummary } from "../shared/chat.ts";
import type { ChatsListing } from "../shared/api.ts";
import { listChats, readChat, ChatError } from "./chats.ts";

export class ChatCatalog {
  #root = "";
  #chats: ChatSummary[] | null = null;
  #unreadable = 0;
  // Listing and changes take turns, so a change sent to the windows is always
  // in the listing any later reply carries, and never in an earlier one.
  #tail: Promise<unknown> = Promise.resolve();
  readonly #notify: (change: ChatChange) => void;

  constructor(notify: (change: ChatChange) => void) {
    this.#notify = notify;
  }

  /** The listing of `root`, read from disk when `root` is new or the last read failed. */
  list(root: string): Promise<ChatsListing> {
    const run = this.#tail.then(async () => {
      if (root !== this.#root || !this.#chats) {
        this.#root = root;
        this.#chats = null;
        const listing = await listChats(root);
        this.#chats = listing.chats;
        this.#unreadable = listing.unreadable;
      }
      return { chats: this.#chats, unreadable: this.#unreadable };
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** The chat at folder `id` in `root` is now `chat`, or is gone when null. */
  change(root: string, id: string, chat: ChatSummary | null): void {
    this.#tail = this.#tail.then(() => {
      if (root !== this.#root) return;
      if (this.#chats) this.#chats = applyChatChange(this.#chats, id, chat);
      this.#notify({ kind: "entry", id, chat });
    });
  }

  /** Reads the one chat at folder `id` again, after an operation on it failed partway. */
  async reread(root: string, id: string): Promise<void> {
    try {
      this.change(root, id, summarize(id, await readChat(root, id)));
    } catch (error) {
      if (error instanceof ChatError && error.code === "notFound") this.change(root, id, null);
    }
  }

  /** The chats folder setting changed: the next listing reads the new folder. */
  folderChanged(): void {
    this.#tail = this.#tail.then(() => {
      this.#chats = null;
      this.#notify({ kind: "folder" });
    });
  }
}
