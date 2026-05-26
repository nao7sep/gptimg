import type { Provider } from "../types.js";
import { openaiEdit } from "./edit.js";
import { openaiGenerate } from "./generate.js";
import { openaiVision } from "./vision.js";

export const openaiProvider: Provider = {
  name: "openai",
  generate: openaiGenerate,
  edit: openaiEdit,
  vision: openaiVision,
};
