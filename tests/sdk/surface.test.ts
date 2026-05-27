import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg } from "../../src/gptimg.js";

describe("GptImg SDK surface", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-sdk-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("uses custom profile and log directories", () => {
    const sdk = new GptImg({
      profileDir: path.join(tmp, "profile-dir"),
      logDir: path.join(tmp, "log-dir"),
    });

    expect(sdk.profileDir).toBe(path.join(tmp, "profile-dir"));
    expect(sdk.logDir).toBe(path.join(tmp, "log-dir"));
  });

  it("exposes the documented helper groups as callable functions", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const profilePath = path.join(tmp, "profile.json");
    const recipePath = path.join(tmp, "recipe.json");

    await sdk.profile.setApiKey("sk-sdk", { path: profilePath });
    const profile = await sdk.profile.load(profilePath);
    expect(sdk.profile.resolve(profile).apiKey).toBe("sk-sdk");
    await sdk.profile.clearApiKey({ path: profilePath });

    await writeFile(recipePath, '{"generate":{"n":1}}\n');
    expect(await sdk.recipe.load(recipePath)).toEqual({ generate: { n: 1 } });
    expect(sdk.recipe.merge({}, { vision: { shrink: { width: 1, height: 1 } } })).toEqual({
      vision: { shrink: { width: 1, height: 1 } },
    });
    expect(sdk.recipe.applyPatch({}, '{"edit":{"size":"1024x1024"}}')).toEqual({
      edit: { size: "1024x1024" },
    });

    expect(typeof sdk.sidecar.read).toBe("function");
    expect(typeof sdk.sidecar.write).toBe("function");
    expect(typeof sdk.image.hash).toBe("function");
    expect(typeof sdk.image.detectFormat).toBe("function");
    expect(typeof sdk.image.shrinkForVision).toBe("function");
    expect(typeof sdk.log.open).toBe("function");
    expect(typeof sdk.log.append).toBe("function");
    expect(typeof sdk.log.close).toBe("function");
    expect(typeof sdk.log.createLogger).toBe("function");
  });
});
