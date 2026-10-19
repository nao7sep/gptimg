import type { Provider } from "../types.ts";
import { openaiChat } from "./chat.ts";
import { openaiEdit } from "./edit.ts";
import { openaiGenerate } from "./generate.ts";
import { openaiVision } from "./vision.ts";

export const openaiProvider: Provider = {
  name: "openai",
  generate: openaiGenerate,
  edit: openaiEdit,
  vision: openaiVision,
  chat: openaiChat,
};
