/**
 * gptimg edge-case smoke harness — black-box exercise of the built CLI across
 * every local, model-free feature plus the validation / exit-code / error
 * contract of the billed ones.
 *
 * SAFETY (this is the point of the design):
 *   - Each child runs with HOME pointed at a throwaway temp dir, so ~/.gptimg
 *     (profile, logs, output defaults) resolves into isolation. The real profile
 *     and API key are never read or written.
 *   - With no key in the temp profile, generate/edit/vision CANNOT reach OpenAI.
 *     We only invoke their *validation-failure* paths (empty prompt/check), which
 *     fail before any network call. Nothing here bills or downloads a model.
 *
 * SMELL DETECTION: every expected-failure case also asserts the failure is clean
 *   — right exit code, and NO raw node stack trace leaking to stderr (an unhandled
 *   exception is exactly the "smell" we are hunting).
 *
 * DELIBERATELY NOT COVERED (would bill, download, or need a GPU/model):
 *   - generate / edit / vision happy paths (OpenAI, billed)
 *   - upscale, mask --method ai (ONNX model download)
 *   - model install of a real model (network download)
 *   - profile set-key against a real key
 *
 * Run from the repo root:  node scripts/edge-smoke.mjs
 * Exit code is non-zero if any case fails.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "gptimg.js");

const WORK = mkdtempSync(path.join(tmpdir(), "gptimg-edge-"));
const HOME_DIR = path.join(WORK, "home"); // isolated ~/.gptimg lives here
const FIX = path.join(WORK, "fix");
mkdirSync(HOME_DIR, { recursive: true });
mkdirSync(FIX, { recursive: true });

const F = {
  img: path.join(FIX, "img.png"), // green bg + opaque red square (chroma input)
  rgba: path.join(FIX, "rgba.png"), // transparent bg + centered opaque square
  mask: path.join(FIX, "mask.png"), // grayscale white square on black
  mask2: path.join(FIX, "mask2.png"), // a different mask, same size
  maskSmall: path.join(FIX, "mask-small.png"), // 32x32, for size-mismatch
  overSmall: path.join(FIX, "over-small.png"), // 32x32, for compose --over mismatch
  big: path.join(FIX, "big.png"), // 1024x1024 square, for icon (master must be >= 1024)
  missing: path.join(FIX, "does-not-exist.png"),
};

function box(w, h, r, g, b, a = 255) {
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: a / 255 } },
  })
    .png()
    .toBuffer();
}

async function buildFixtures() {
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } })
    .composite([{ input: await box(28, 28, 255, 0, 0), left: 18, top: 18 }])
    .png()
    .toFile(F.img);

  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await box(32, 32, 255, 0, 0), left: 16, top: 16 }])
    .png()
    .toFile(F.rgba);

  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite([{ input: await box(32, 32, 255, 255, 255), left: 16, top: 16 }])
    .png()
    .toFile(F.mask);

  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite([{ input: await box(24, 24, 255, 255, 255), left: 8, top: 8 }])
    .png()
    .toFile(F.mask2);

  await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .png()
    .toFile(F.maskSmall);

  await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } })
    .png()
    .toFile(F.overSmall);

  // icon requires a master of at least 1024x1024.
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await box(512, 512, 255, 0, 0), left: 256, top: 256 }])
    .png()
    .toFile(F.big);
}

function run(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: HOME_DIR };
    delete env.OPENAI_API_KEY; // belt-and-suspenders: never let a stray key enable a real call
    const ch = spawn(process.execPath, [BIN, ...args], { env, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    ch.stdout.on("data", (d) => (stdout += d));
    ch.stderr.on("data", (d) => (stderr += d));
    ch.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    ch.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
  });
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tag = passed ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${passed ? "" : `  — ${detail}`}`);
}

const hasStack = (s) => /\n\s+at\s+\S/.test(s); // a leaked node stack frame == smell

function freshOut() {
  const d = mkdtempSync(path.join(WORK, "out-"));
  return d;
}

/** Expect a clean success: exit 0, JSON on stdout, at least one file produced. */
async function expectOk(name, args, outDir) {
  const r = await run([...args, "--out-dir", outDir]);
  if (r.code !== 0) return record(name, false, `exit ${r.code}; stderr: ${r.stderr.slice(0, 160)}`);
  try {
    JSON.parse(r.stdout.trim());
  } catch {
    return record(name, false, `stdout is not JSON: ${r.stdout.slice(0, 120)}`);
  }
  const produced = readdirSync(outDir).length;
  if (produced < 1) return record(name, false, "no output file produced");
  record(name, true);
}

/** Expect a clean failure: non-zero exit, no leaked stack, optional code + message. */
async function expectErr(name, args, { code, msg } = {}) {
  const r = await run(args);
  if (r.code === 0) return record(name, false, "expected failure but exited 0");
  if (hasStack(r.stderr)) return record(name, false, `leaked a raw stack trace:\n${r.stderr.slice(0, 200)}`);
  if (code !== undefined && r.code !== code)
    return record(name, false, `expected exit ${code}, got ${r.code}; stderr: ${r.stderr.slice(0, 140)}`);
  if (msg !== undefined && !r.stderr.includes(msg))
    return record(name, false, `expected stderr to contain "${msg}"; got: ${r.stderr.slice(0, 200)}`);
  record(name, true);
}

async function main() {
  console.log(`workdir: ${WORK}`);
  await buildFixtures();

  console.log("\n== A. CLI contract ==");
  {
    const v = await run(["--version"]);
    record("--version exits 0 with a version", v.code === 0 && /\d+\.\d+\.\d+/.test(v.stdout), `code ${v.code}`);
    const h = await run(["--help"]);
    record("--help exits 0", h.code === 0, `code ${h.code}`);
  }
  await expectErr("unknown command -> clean exit 2", ["bogus-verb"], { code: 2 });
  await expectErr("unknown flag -> clean exit 2", ["mask", "--in", F.img, "--nope"], { code: 2 });
  {
    // #4/#5: every CLI invocation writes a process-session log with startup + shutdown lines.
    const logsDir = path.join(HOME_DIR, ".gptimg", "logs");
    let ok = false;
    try {
      const newest = readdirSync(logsDir).filter((f) => f.endsWith(".log")).sort().at(-1);
      const txt = newest ? readFileSync(path.join(logsDir, newest), "utf-8") : "";
      ok = txt.includes('"cli startup"') && txt.includes('"cli shutdown"');
    } catch {
      ok = false;
    }
    record("process-session log has startup + shutdown (#4/#5)", ok, "missing startup/shutdown in newest session log");
  }

  console.log("\n== B. Validation & exit-code contract (no network) ==");
  await expectErr("generate empty prompt -> 2", ["generate", "--prompt", ""], { code: 2 });
  await expectErr("vision empty check -> 2", ["vision", "--in", F.img, "--check", ""], { code: 2 });
  await expectErr("model install unknown -> 2 (fix #2)", ["model", "install", "bogus-model"], { code: 2, msg: "unknown model" });
  await expectErr("combine radius over bound -> 2 (fix #3)", ["combine", "feather", "--in", F.mask, "--radius", "99999"], { code: 2, msg: "[0..1024]" });
  await expectErr("combine radius negative -> 2", ["combine", "feather", "--in", F.mask, "--radius", "-1"], { code: 2, msg: "[0..1024]" });
  await expectErr("shadow opacity out of range -> 2", ["shadow", "--in", F.rgba, "--opacity", "5"], { code: 2, msg: "(0..1]" });
  await expectErr("backplate radius out of range -> 2", ["backplate", "--from", "#000000", "--to", "#ffffff", "--radius", "0.9"], { code: 2, msg: "[0..0.5]" });
  await expectErr("trim margin out of range -> 2", ["trim", "--in", F.rgba, "--margin", "2"], { code: 2, msg: "[0..1]" });
  await expectErr("resize to-size zero -> 2", ["resize", "--in", F.rgba, "--to-size", "0"], { code: 2 });
  await expectErr("resize to-size over max -> 2", ["resize", "--in", F.rgba, "--to-size", "99999"], { code: 2 });
  await expectErr("icon undersized master -> 2", ["icon", "--in", F.rgba], { code: 2, msg: "at least 1024x1024" });

  console.log("\n== C. Local verb happy paths (model-free) ==");
  await expectOk("mask (chroma key)", ["mask", "--in", F.img, "--key", "#00ff00"], freshOut());
  await expectOk("compose -> RGBA", ["compose", "--in", F.img, "--mask", F.mask], freshOut());
  await expectOk("compose --over flatten", ["compose", "--in", F.img, "--mask", F.mask, "--over", "#ffffff"], freshOut());
  await expectOk("compose --remove-bleed (fix #1 path)", ["compose", "--in", F.img, "--mask", F.mask, "--remove-bleed", "#00ff00"], freshOut());
  await expectOk("combine union", ["combine", "union", "--in", F.mask, "--in", F.mask2], freshOut());
  await expectOk("combine intersect", ["combine", "intersect", "--in", F.mask, "--in", F.mask2], freshOut());
  await expectOk("combine subtract", ["combine", "subtract", "--in", F.mask, "--in", F.mask2], freshOut());
  await expectOk("combine invert", ["combine", "invert", "--in", F.mask], freshOut());
  await expectOk("combine feather (in-bound radius)", ["combine", "feather", "--in", F.mask, "--radius", "2"], freshOut());
  await expectOk("trim", ["trim", "--in", F.rgba], freshOut());
  await expectOk("backplate", ["backplate", "--from", "#112233", "--to", "#445566", "--size", "128"], freshOut());
  await expectOk("layer", ["layer", "--base", F.rgba, "--top", F.rgba], freshOut());
  await expectOk("shadow", ["shadow", "--in", F.rgba], freshOut());
  await expectOk("icon", ["icon", "--in", F.big], freshOut());
  await expectOk("resize (downscale)", ["resize", "--in", F.rgba, "--to-size", "32"], freshOut());
  {
    const r = await run(["model", "list"]);
    let okJson = false;
    try {
      okJson = Array.isArray(JSON.parse(r.stdout.trim()).models);
    } catch {
      okJson = false;
    }
    record("model list -> JSON with models[]", r.code === 0 && okJson, `code ${r.code}`);
  }

  console.log("\n== D. Edge / smell paths ==");
  await expectErr("missing input file -> clean error", ["mask", "--in", F.missing, "--key", "#00ff00"], {});
  await expectErr("combine size mismatch -> clean error", ["combine", "union", "--in", F.mask, "--in", F.maskSmall], {});
  await expectErr("compose --over size mismatch -> clean error", ["compose", "--in", F.img, "--mask", F.mask, "--over", F.overSmall], {});
  {
    // overwrite guard: second write without --overwrite must fail; with it, succeed.
    const od = freshOut();
    const a = await run(["combine", "invert", "--in", F.mask, "--out-dir", od, "--out-name", "ov.png"]);
    const b = await run(["combine", "invert", "--in", F.mask, "--out-dir", od, "--out-name", "ov.png"]);
    const c = await run(["combine", "invert", "--in", F.mask, "--out-dir", od, "--out-name", "ov.png", "--overwrite"]);
    const pass = a.code === 0 && b.code !== 0 && !hasStack(b.stderr) && c.code === 0;
    record("overwrite guard (ok / blocked / --overwrite)", pass, `codes ${a.code}/${b.code}/${c.code}`);
  }
  {
    // unicode + spaces in the output path must round-trip.
    const od = path.join(freshOut(), "with space — ünïcode");
    mkdirSync(od, { recursive: true });
    const r = await run(["combine", "invert", "--in", F.mask, "--out-dir", od]);
    record("output path with spaces/unicode", r.code === 0 && readdirSync(od).length > 0, `code ${r.code}`);
  }

  // ---- summary ----
  const failed = results.filter((r) => !r.passed);
  console.log(`\n== Summary ==\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("  FAILURES:");
    for (const f of failed) console.log(`   - ${f.name}: ${f.detail}`);
  }
  rmSync(WORK, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(2);
});
