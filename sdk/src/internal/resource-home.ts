import { homedir } from "node:os";
import path from "node:path";

/**
 * The SDK's own resource folder (sdk-conventions, *Its own resources have a
 * home of its own*): models default to `~/.gptimgsdk/models`, named after the
 * package and never inside an app's data folder, so a script needs no
 * configuration and no app's reset removes what others rely on. Every caller
 * can point elsewhere per call, per instance or through a profile. This module
 * is the one place in the SDK allowed to use the home folder; the boundary
 * test holds that.
 */
export function defaultModelsDir(): string {
  return path.join(homedir(), ".gptimgsdk", "models");
}
