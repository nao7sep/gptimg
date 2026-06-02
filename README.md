# GptImg

TypeScript SDK + CLI for AI image generation, vision verification, and a local image-processing pipeline: masking, compositing, mask algebra, cropping, gradient backplates, layering, drop shadows, macOS/Windows icon packing, super-resolution upscaling, and resizing. It is designed for human CLI use and for AI agents or skills that need durable artifacts: timestamped images, JSON sidecars, and JSONL logs.

Each toy does one observable operation. Workflows are user-composed: `mask` produces a mask, `compose` applies a mask to an image, `combine` does set operations on masks. The chroma-key path is one mask producer among (eventually) several.

Personal tool. v1 ships OpenAI only; the provider boundary exists but no second provider is shipped.

## Automation and agent use

The CLI is built to be driven by scripts and AI agents. Every command prints **one JSON object** — success on stdout, a single error object on stderr — and signals outcome via [exit code](#exit-codes), so a caller parses stdout for results and branches on the code. The SDK returns the same data as objects and never writes to stdout/stderr.

What each verb *does* is defined by the source and `--help`; this README is the reference for the **stable contract** a caller builds against — exit codes, the per-image sidecar model, [artifacts](#artifacts), and [cancellation](#cancellation). A few conventions keep automated runs reproducible and debuggable:

- Give each job its own output directory. Keep the original generation and its sidecar; masks, cutouts, and composites are derived and can be regenerated.
- Use stable, descriptive `--out-name` values (`subject-original`, `subject-mask`, `subject-cutout`), not bare timestamps.
- Don't pass `--overwrite` unless you mean to replace a file. For `generate`/`edit` it is group-scoped: it allows the planned files to replace existing siblings but halts with `output.staleSiblings` if a prior run left indexed files the new plan would not replace.
- Parse stdout JSON for success; use the JSONL log and sidecars for trace context, not primary success detection. Treat `partial: true` from `generate`/`edit` as recoverable when at least one file was written.
- Always run `mask` from the **original** image. To change mask parameters, rerun from the original — do not feed a previous mask or composite back through `mask`.
- `vision` handles any semantic check, but it **cannot see transparency** (it ingests a transparent PNG flattened on black). Composite a cutout onto a known plate first, then vision-check that.
- The local AI models (`mask --method ai`, `upscale`) load 1.5–4.4 GB each — run them **one at a time**. Network calls (`generate`/`edit`/`vision`) can run in parallel.

For complete recipes that compose these verbs into finished assets — including the decisions gptimg deliberately does **not** encode (margins, glyph sizing, background-removal choice, directory layout, target-format filenames) — see the workflow guides:

- **[Stamp workflow](docs/stamp-workflow.md)** — transparent overlay assets (badges, postmarks, frames, ribbons).
- **[Icon workflow](docs/icon-workflow.md)** — app icons packed for Tauri / Electron / Avalonia / .NET.

## Quick Start

```sh
git clone <this repo> gptimg
cd gptimg
npm install
npm run build
```

The build emits `dist/`; the CLI entry is `bin/gptimg.js`. Add `bin/` to `PATH` or invoke as `node bin/gptimg.js`.

Set up a profile:

```sh
# Store the key in the profile. The file is written with owner-only
# permissions (POSIX mode 0600) and the key is obfuscated on disk.
gptimg profile set-key --key sk-...

# Or reference an environment variable instead.
cat > ~/.gptimg/profile.json <<'EOF'
{ "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY" }
EOF
```

When both `apiKeyEnv` and `apiKey` are present, the environment variable wins. `profile clear-key` removes only stored `apiKey`; a missing profile file or missing key is a no-op, while unreadable profile paths are errors.

Profile files are strict JSON objects. Supported top-level keys are `provider`, `apiKey`, `apiKeyEnv`, `organization`, and `project`. For org-scoped OpenAI accounts, `organization` and `project` are passed through to the OpenAI SDK. Network budgets are not profile keys — they live in `recipe.json` under `recipe.network` (see [Configuration](#configuration)).

### Profile file permissions

On POSIX systems, a profile containing `apiKey` must be owner-only (mode `0600`). `gptimg profile set-key` writes the file with that mode automatically; if you hand-author `~/.gptimg/profile.json` and include `apiKey`, run `chmod 600 ~/.gptimg/profile.json` after writing. Loading a loose-mode profile that carries `apiKey` halts with `profile.insecureMode` (exit code 3) and prints the file mode plus the chmod command to run. Profiles that use only `apiKeyEnv` (no stored key) are not subject to this check. The mode check is POSIX-only and is skipped on Windows. If your key was already exposed because the file was loose-mode, rotate it; `clear-key` removes it from the profile but cannot undo prior reads.

Defaults live under `~/.gptimg/`:

| Path | Purpose |
|---|---|
| `~/.gptimg/profile.json` | Provider + API key |
| `~/.gptimg/recipe.json` | Per-verb parameters (optional; missing is fine) |
| `~/.gptimg/output/` | Generated images |
| `~/.gptimg/logs/` | One JSONL file per invocation |
| `~/.gptimg/models/` | Cached AI mask model(s) (override with `GPTIMG_MODELS_DIR`) |

## Common Workflows

Generate one image:

```sh
gptimg generate "a red coffee mug on a wooden desk"
```

Generate and verify:

```sh
gptimg generate "single centered product photo of a pink frosted donut" \
  --out-dir ./out \
  --out-name donut

gptimg vision \
  --in ./out/donut.png \
  --check "one donut is centered, fully visible, and not cropped"
```

Edit an existing image:

```sh
gptimg edit "remove the background" --in input.png --out-dir ./out --out-name edited
```

Remove a chroma-key background:

```sh
gptimg mask --in donut.png --key from-sidecar --preserve-interior \
  --out-name donut-mask.png

gptimg compose --in donut.png --mask donut-mask.png \
  --remove-bleed "#00ff00" \
  --out-name donut-cutout.png
```

To check the result, run `gptimg vision` against the composite with whatever criterion you care about.

Build an app icon from a generated cutout:

```sh
# 1. Trim the cutout to its alpha bbox + 10% relative margin, force square canvas.
gptimg trim --in cutout.png --margin 0.10 --square --out-name content.png

# 2. (Only if the cutout is smaller than its on-plate size) AI-upscale it to that
#    size so layer never enlarges with a plain kernel. A glyph generated near 1024
#    is already large enough — skip this. Write a NEW name; don't overwrite content.
gptimg upscale --in content.png --to-size 1024 --out-name content-up.png

# 3. Cast a soft contact shadow inside the square canvas so the glyph lifts off the plate.
gptimg shadow --in content.png --keep-canvas --blur 24 --offset 0,18 \
  --opacity 0.32 --color "#0a0a20" --out-name content-shadow.png

# 4. Synthesize a 1024² squircle backplate with a brand gradient.
gptimg backplate --size 1024 --from "#3a4a6a" --to "#1a2030" \
  --shape squircle --out-name plate.png

# 5. Composite the shadowed content onto the plate (top at ~78% of the plate side —
#    a starting point; tune by eye per design, color, and style).
gptimg layer --base plate.png --top content-shadow.png --scale 0.78 \
  --out-name icon.png

# 6. Pack the master into platform icons: icon.icns (macOS) + icon.ico (Windows).
gptimg icon --in icon.png --out-dir build/
```

> These snippets are quick orientation. For finished-asset recipes — the cropping, sizing, and packing decisions plus the staging conventions — follow the [stamp workflow](docs/stamp-workflow.md) and [icon workflow](docs/icon-workflow.md).

## CLI Reference

### `generate`

```sh
gptimg generate "logo" \
  --set size=1024x1024 \
  --set quality=high \
  --set n=4
```

Outputs `<stem>.<ext>` for one image, or indexed filenames such as `<stem>-1.png` / `<stem>-01.png` when multiple images are written. **One sidecar JSON is written per image** — `<stem>.json` for n=1, `<stem>-NN.json` for n>1 — each carrying the resolved request, the provider response (base64 nulled), and a single-element `files` entry describing the image it sits next to. This makes every image fully self-describing; downstream commands like `mask --key from-sidecar` look up the sidecar at the literal image stem with no filename-pattern mangling.

The artifact group for a single `generate`/`edit` invocation is `<stem>.<ext>` plus `<stem>-<digits>.<ext>` image siblings plus the matching `<stem>.json` / `<stem>-<digits>.json` per-image sidecars in `--out-dir`. Without `--overwrite`, any existing group member blocks with `output.exists`. With `--overwrite`, the run will replace only the files it plans to write; if prior-run group members exist that the new plan would *not* replace (for example, `<stem>-01.png` … `<stem>-10.png` left over from `n=10` when the new run uses `n=2`), the command halts with `output.staleSiblings` rather than silently leaving orphans behind. Delete the listed files or pick a fresh `--out-name`. Mask and composite siblings are not part of the generate/edit group and are never touched by this check. The availability check runs *before* the provider call, so a conflicting stem fails fast (`output.exists` / `output.staleSiblings`) without spending on generation.

If `recipe.chroma.color` is set, `generate` records the color in each per-image sidecar so later `mask --key from-sidecar` can reuse it.

### `edit`

```sh
gptimg edit "fill in the masked area with sky" --in input.png --mask mask.png
```

Uses the same output, sidecar, recipe, network, and overwrite behavior as `generate`.

### `vision`

```sh
gptimg vision \
  --in /tmp/foo.png \
  --check "the subject is a single coffee mug, no other objects"
```

Returns `{ ok, score, reasons }` from a structured `json_schema` response. Images are auto-shrunk to fit inside 1024x1024 before upload unless `recipe.vision.shrink` or `--set 'shrink={...}'` overrides it.

Vision detail can be configured with `recipe.vision.detail` or `--set detail=low|high|original|auto`. By default, detail is left unset so the model can choose automatically. `original` requires a model that supports it; the default vision model does not.

Each run writes a JSON sidecar (`<out-dir>/<stem>.json`; the stem defaults to a UTC timestamp, override with `--out-name`) recording the request, verdict, and raw response. Pass `--overwrite` to replace an existing sidecar at an explicit `--out-name`; the availability check runs before the (paid) API call so a collision fails fast without spending.

### `mask`

```sh
# Chroma method (default): auto-detect the key from the image border.
gptimg mask --in image.png

# Use the hint stored in the sibling sidecar.
gptimg mask --in image.png --key from-sidecar

# Keep interior key-colored regions opaque (donut hole, intentional green subject content).
gptimg mask --in donut.png --preserve-interior

# Compute stats without writing a file.
gptimg mask --in image.png --dry-run

# AI method (BiRefNet via ONNX Runtime). First call downloads the model into ~/.gptimg/models/.
gptimg mask --in image.png --method ai

# Pre-fetch the AI model for offline use (see `model install` below).
gptimg model install
```

Local only; no API call. Produces a grayscale alpha mask the same size as the input. Two methods are available:

- `--method chroma` (default): per-pixel spill against a chroma-key color. Deterministic, fast, requires the subject to sit on a uniform key.
- `--method ai`: BiRefNet inference via [`onnxruntime-node`](https://www.npmjs.com/package/onnxruntime-node). Works on any background. Lazily downloads the model on first use; cached under `~/.gptimg/models/` (override with `GPTIMG_MODELS_DIR`).

Chroma method algorithm: the key is taken as `--key` (or detected as the linear-RGB average of border pixels for `--key auto`). Per-pixel α is then `clamp(1 − spill / (key_strength · saturationRatio))` where spill is `max(0, C[key] − max(C[other_1], C[other_2]))` for a primary key (R/G/B), or `max(0, min(C[other_1], C[other_2]) − C[suppressed])` for a secondary key (C/M/Y). `--saturation-ratio` (or `recipe.chroma.saturationRatio`, default `0.82`) controls the spill ratio at which near-key pixels snap to α=0; lower values are more aggressive on background haze, higher values preserve more subject detail at the edges. A pure-key pixel is fully transparent; a pixel with no key contamination is opaque. With `--preserve-interior`, a flood fill from the border identifies border-connected transparent pixels; any α≈0 pixel not reached by the fill (the inside of a donut hole, for example) is forced back to opaque.

AI method algorithm: the input is resized to 1024×1024, ImageNet-normalized, and fed to BiRefNet through ONNX Runtime. Per-stage logits are read at the model's native output resolution (validated against `[1,1,H,W]` so a mismatched export fails loudly), sigmoid-mapped, then resized back to the source dimensions and returned as the alpha buffer. The model weights are lazily fetched on first use from the URL pinned in `src/local/models/registry.ts`. Cached file lives at `~/.gptimg/models/birefnet-general-fp16-v1.onnx` (or `$GPTIMG_MODELS_DIR/birefnet-general-fp16-v1.onnx`). Run `gptimg model install` to pre-fetch. The fetcher downloads to a process-unique partial path and publishes via POSIX `link()`, so concurrent callers waste bandwidth but never corrupt the cache. The download runs under the `modelDownload` network budget (per-attempt timeout + bounded retries; each retry re-downloads to a fresh partial), tunable via `recipe.network.modelDownload`. Version reproducibility comes from pinning the registry URL to a specific HuggingFace commit (`/resolve/<commit-sha>/...`), and each download is verified against the model's pinned sha256 — a mismatch fails with `model.checksumMismatch` rather than caching bad bytes.

ONNX Runtime can be tuned with two environment variables: `GPTIMG_ONNX_INTRA_OP_THREADS` overrides the per-session intra-op thread count (default: half the cores), and `GPTIMG_ONNX_EP` sets a comma-separated, priority-ordered execution-provider list (default `cpu`; e.g. `coreml,cpu` on builds that ship the CoreML provider). An unavailable provider fails loudly at session creation.

**Resource cost — read this before running AI masks in parallel.** Each `--method ai` process loads the BiRefNet ONNX session (~500MB resident weights) plus inference activations plus sharp pipeline buffers — roughly **1–1.5GB peak RSS per process**, all of it in native memory (invisible to Node's GC). The ONNX Runtime CPU provider is also capped to half the available cores per session so parallel callers don't oversubscribe the thread pool. On a 24GB machine, **running more than ~2 AI-mask processes simultaneously can push the system into swap thrashing and may crash WindowServer or the kernel**. The chroma method is light (~100–200MB) and parallel-safe; only `--method ai` carries this risk. For batch jobs, run AI masks **sequentially** (e.g. shell `&&`, not `&`).

### `compose`

```sh
# Apply mask to image, write transparent RGBA.
gptimg compose --in image.png --mask image-mask.png

# Flatten over a solid color.
gptimg compose --in image.png --mask image-mask.png --over "#ffffff"

# Flatten over another image.
gptimg compose --in image.png --mask image-mask.png --over background.png

# Decontaminate spill on partial-alpha pixels using a known key color.
gptimg compose --in image.png --mask image-mask.png --remove-bleed "#00ff00"
```

Local only. Writes RGBA when `--over` is omitted; flattens to opaque RGB when `--over` is given.

`--remove-bleed <#rrggbb>` cleans the named bg color out of the subject pixels the mask kept. Two passes run together: (1) chromatic spill suppression on every pixel with α > 0 — for a primary key (R/G/B) the key channel is clamped to ≤ max(other two), for a secondary key (C/M/Y) the two non-suppressed channels are reduced by their excess above the suppressed channel; legitimate subject colors satisfy these constraints so the clamp is a no-op for them. (2) Alpha-aware edge color recovery on partial-α pixels — given `C = α·F + (1−α)·B`, solve for `F`, removing the bg blend baked into edge pixels during the original capture. Achromatic hexes (gray bg) skip step 1 but still benefit from step 2.

### `combine`

```sh
# Union of two masks (pixelwise max).
gptimg combine union --in a.png --in b.png

# Intersection (pixelwise min).
gptimg combine intersect --in a.png --in b.png

# Set difference (a − b).
gptimg combine subtract --in a.png --in b.png

# Invert a single mask.
gptimg combine invert --in a.png

# Feather a mask with N 3×3 box-blur passes.
gptimg combine feather --in a.png --radius 2
```

Local only. The donut-hole workflow uses `combine`:

```sh
# Whole donut shape (a model that segments salient subject would put the hole inside).
gptimg mask --in donut.png --method chroma --key "#00ff00" \
  --preserve-interior --out-name donut-shape.png

# Just the hole (and exterior bg): chroma without --preserve-interior.
gptimg mask --in donut.png --method chroma --key "#00ff00" \
  --out-name donut-keyed.png

# Intersect: keep only pixels both masks agree are subject → donut ring (the
# hole is excluded because the keyed mask marks it transparent).
gptimg combine intersect --in donut-shape.png --in donut-keyed.png \
  --out-name donut-final-mask.png

gptimg compose --in donut.png --mask donut-final-mask.png \
  --out-name donut-cutout.png
```

### `trim`

```sh
# Crop to alpha bbox + 8% relative margin (default).
gptimg trim --in cutout.png

# Force square canvas (extend the shorter axis with transparent pixels).
gptimg trim --in cutout.png --margin 0.10 --square --out-name content.png
```

Local only. Loads the input as RGBA, finds the tightest rect of pixels with alpha > 0, re-pads by `--margin × max(bbox.width, bbox.height)`, and optionally extends the shorter axis to make the output square. Fully-transparent input → exit 5 (`image.noContent`). Default output name `<input-stem>-trim.png`.

### `backplate`

```sh
# Default: 1024² rounded-rect plate with the given gradient.
gptimg backplate --size 1024 --from "#3a4a6a" --to "#1a2030"

# Continuous-curvature squircle (closer to the macOS dock icon shape).
gptimg backplate --size 1024 --from "#3a4a6a" --to "#1a2030" --shape squircle
```

Local only. Synthesizes a square PNG containing a centered rounded shape (rect or squircle) filled with a linear gradient on transparent padding — the bottom layer of the icon pipeline.

`--from` and `--to` are required. `--size` defaults to 1024, `--content` (plate side as fraction of canvas) to 0.80, `--radius` (fraction of content side) to 0.225, `--angle` (CSS deg; 0=bottom→top, 90=left→right) to 135, and `--shape` to `rect`. Without `--out-dir`, output goes to the current working directory; default filename `backplate-<size>.png`.

### `layer`

```sh
# Composite content centered on the plate, scaled to 78% of plate side.
gptimg layer --base plate.png --top content.png --scale 0.78

# Explicit pixel placement (overrides --gravity).
gptimg layer --base plate.png --top content.png --top-offset 120,200
```

Local only. Source-over alpha-composite of `--top` onto `--base`. Unlike `compose --over <image>` (which flattens to opaque RGB driven by a single-channel mask), `layer` preserves the base's transparency outside the top.

`--scale` resizes top so its longer side = `scale × min(baseW, baseH)`, preserving aspect. `--gravity` (default `center`) accepts the nine sharp compass directions. `--top-offset x,y` overrides `--gravity` with an explicit pixel offset of top's top-left corner from base's top-left. Output canvas is always the base size. Default output name `<base-stem>-layered.png`.

### `shadow`

```sh
# Soft drop shadow under a cutout (canvas grows so nothing is clipped).
gptimg shadow --in cutout.png

# Tuned shadow, kept at the input dimensions.
gptimg shadow --in cutout.png --blur 20 --offset 0,16 \
  --color "#101820" --opacity 0.4 --spread 4 --keep-canvas
```

Local only. Casts a drop shadow from the input's alpha shape and composites the original subject back on top. Pipeline: extract alpha → grow by `--spread` px (square dilation) → tint to `--color` at `--opacity` → gaussian-blur by `--blur` → composite shadow then subject onto a transparent canvas.

`--blur` (sigma, default 12), `--offset x,y` (default `0,8`; may be negative), `--color` (`#rrggbb`, default `#000000`), `--opacity` (`(0,1]`, default 0.35), `--spread` (px, default 0). By default the canvas **grows** so the offset/blurred shadow is never clipped; `--keep-canvas` keeps the input size and clips instead. Default output name `<in-stem>-shadow.png`.

### `icon`

```sh
# Pack a square master into icon.icns + icon.ico + a 1024² icon.png.
gptimg icon --in icon.png --out-dir build/

# Also emit the loose sized-PNG set (icon-16.png … icon-1024.png) for Linux/.NET/web.
gptimg icon --in icon.png --out-dir build/ --pngs
```

Local only. Packs a square master PNG into the platform-agnostic icon artifacts every desktop toolchain consumes: `icon.icns` (macOS), `icon.ico` (Windows), and a 1024² `icon.png` master copy. The byte-level container encoding is handled by [`@shockpkg/icon-encoder`](https://www.npmjs.com/package/@shockpkg/icon-encoder); sharp renders each size from the master with the toolkit's lanczos3 resample.

The master must be **square and at least 1024×1024** — non-square exits 5 (`args.invalid`), as does a smaller master (the 1024 entry would otherwise be upscaled). The `.icns` packs the modern PNG-based types `ic04`–`ic14` (16…1024 px incl. retina); the `.ico` packs 16/24/32/48/64/128/256 (32-bit BMP below 256, embedded PNG at 256 — the maximally-compatible Windows layout). `--name` (default `icon`) sets the output stem; `--pngs` additionally writes `<name>-<size>.png` for 16/32/48/64/128/256/512/1024. Without `--out-dir`, output goes beside `--in`.

This verb produces the *same* bytes for every toolchain — only the destination differs. Placement is the caller's job: Electron uses `build/icon.icns` + `build/icon.ico`; Tauri's default `bundle.icon` is `icon.icns` + `icon.ico` + `32x32.png`/`128x128.png`/`128x128@2x.png` (all covered by `--pngs`, modulo renaming); .NET/Avalonia points `<ApplicationIcon>` at `icon.ico`.

### `upscale`

```sh
# Learned ×4 super-resolution, then resample to 1024 (longer side). Alpha preserved.
gptimg upscale --in content.png --to-size 1024

# Pick the resampling kernel for the post-×4 resize; lower the memory ceiling.
gptimg upscale --in content.png --to-size 800 --kernel mitchell --tile 192

# Pre-fetch the model for offline use.
gptimg model install swin2sr
```

Local only. Enlarges small content (a cropped subject, logo, illustration) so it can fill a larger icon crisply, using the [Swin2SR](https://huggingface.co/onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX) real-world ×4 model via ONNX Runtime. The model is native ×4 and **distortion-optimized** (PSNR), so it enlarges faithfully rather than hallucinating texture the way a perceptual GAN would — the right trade for clean art. The OpenAI API is not a substitute: `edit` re-renders and changes content.

`--to-size` (default 1024) sets the **final** longer side; the model runs ×4 at the source's native size, then the result is resampled to the target. To get 2×, just run ×4 and let the downscale halve it — there is no native ×2 path. `--kernel` (default `lanczos3`; also `nearest`, `cubic`, `mitchell`, `lanczos2`) is the resampler for that resize. The model is RGB-only, so alpha is resampled separately and recombined — transparency survives. Default output name `<input-stem>-upscale.png`.

`--tile` (default 256) is the memory knob: roughly the model-input edge processed per pass (reflect-padding to the model's 8px window can nudge the actual input a few px higher). Swin2SR memory grows ~quadratically with input area (~4.4GB peak at 256px on CPU), so large inputs are split into overlapping tiles whose seams are cropped away (a 32px context overlap keeps the worst case within ~6/255 of a single-pass result — visually identical on real content). Lower `--tile` to reduce peak RAM at the cost of more passes; raise it (more RAM) for fewer passes.

> To **shrink** an image, use `resize` (below), not `upscale`. Even when `--to-size` is smaller than the source, `upscale` still runs the full ×4 model first (the download is one-time, but the inference compute + RAM are paid every call) and then shrinks the result — wasteful and not pixel-equivalent to a plain resample. `upscale` is for enlarging small content with the learned model.

### `resize`

```sh
# Plain (model-free) resample to 512 on the longer side; alpha preserved.
gptimg resize --in big.png --to-size 512

# Pick the kernel.
gptimg resize --in photo.png --to-size 256 --kernel mitchell
```

Local only, no model. One sharp resample to `--to-size` (the longer side; aspect preserved), in either direction. This is the cheap counterpart to `upscale`: milliseconds and a few MB, with no 54MB model download or GBs of RAM. Use it to **downscale** (where a learned model adds nothing — classical kernels are already optimal for shrinking) or for quick enlargement where super-resolution quality isn't needed; reach for `upscale` only when enlarging small content and you want the learned ×4. `--to-size` is required; `--kernel` (default `lanczos3`; also `nearest`, `cubic`, `mitchell`, `lanczos2`) selects the resampler. Alpha is preserved. Default output name `<input-stem>-resize.png`.

### `model`

Manage the local AI model cache (used by `mask --method ai`).

```sh
# Download all known models into the cache (verified against the pinned sha256).
gptimg model install

# Install a specific model (birefnet = AI mask, swin2sr = upscale).
gptimg model install birefnet
gptimg model install swin2sr

# Re-download and replace even if cached (use when a file is corrupt/outdated).
gptimg model install birefnet --force

# Show known models and whether each is cached.
gptimg model list
```

Local model files are fetched lazily on first `mask --method ai` too; `model install` just pre-fetches. Downloads run under `recipe.network.modelDownload` and are verified against the pinned sha256 (mismatch → `model.checksumMismatch`).

## SDK

```ts
import { GptImg } from "gptimg";

const sdk = new GptImg();

const gen = await sdk.generate({ prompt: "a red mug" });
const verdict = await sdk.vision({
  in: gen.files[0].path,
  check: "subject is centered and well-lit",
});
const mask = await sdk.mask({ in: gen.files[0].path });
const cutout = await sdk.compose({
  in: gen.files[0].path,
  mask: mask.output!,
});

// Icon pipeline.
const trim = await sdk.trim({ in: cutout.output, margin: 0.1, square: true });
// Optional: AI-upscale only if the cutout is below its on-plate size.
const big = await sdk.upscale({ in: trim.output, toSize: 1024 });
// Contact shadow so the glyph lifts off the plate (kept inside the square canvas).
const shadow = await sdk.shadow({
  in: big.output,
  keepCanvas: true,
  blur: 24,
  offset: { x: 0, y: 18 },
  opacity: 0.32,
  color: "#0a0a20",
});
const plate = await sdk.backplate({
  size: 1024,
  from: "#3a4a6a",
  to: "#1a2030",
  shape: "squircle",
});
const composed = await sdk.layer({
  base: plate.output,
  top: shadow.output,
  scale: 0.78, // starting point; tune by eye per design
});
// Pack the master into platform icons (icon.icns / icon.ico / icon.png).
const icon = await sdk.icon({ in: composed.output, outDir: "build" });
```

All SDK verbs return data objects and never write to stdout/stderr. Each method accepts `{ signal?: AbortSignal }` as a second argument.

Building blocks are exposed for composition:

```ts
sdk.profile.load / resolve / setApiKey / clearApiKey
sdk.recipe.load / merge / applySet
sdk.sidecar.read / write
sdk.image.hash / detectFormat / shrinkForVision
sdk.log.open / append / close / createLogger
```

## Configuration

Per-verb model defaults:

| Verb | Default model | Override |
|---|---|---|
| `generate` | `gpt-image-2` | `recipe.generate.model` or `--set model=...` |
| `edit` | `gpt-image-2` | `recipe.edit.model` or `--set model=...` |
| `vision` | `gpt-5.4-mini` | `recipe.vision.model` or `--set model=...` |

There is no global `model` in `profile.json`.

Model notes:

- `gpt-image-2` rejects `background: "transparent"`. For transparent output, generate against a solid chroma backdrop and remove it locally, or choose a model that supports transparent backgrounds.
- `gpt-image-2` does not use `input_fidelity`; the OpenAI provider adapter does not send it.
- `n > 1` behavior can vary by model and endpoint. If a batch request fails, retry with `n=1` or split the batch.
- Edit reference images may be billed at maximum fidelity even when output `quality` is lower.

Key defaults and overrides:

| Knob | Default lives in | Override path |
|---|---|---|
| Per-verb model | `src/providers/openai/defaults.ts` | `recipe.{verb}.model` or `--set model=...` |
| Vision system prompt | `src/providers/openai/defaults.ts` | `recipe.vision.systemPrompt` |
| Vision shrink target | `src/verbs/defaults.ts` | `recipe.vision.shrink` |
| Chroma options | `src/local/chroma/defaults.ts` | `recipe.chroma.*` or chroma CLI/SDK args |
| Network budgets | `src/network/defaults.ts` | `recipe.network.*` or `--set network.<category>.<field>=...` |

Network budgets are strict and can be set in `recipe.network` or `--set`:

| Category | Used by | Default timeout | Default retries | Default intervals |
|---|---|---|---|---|
| `imageGenerate` | `images.generate`, `images.edit` | 600,000 ms | 2 | `[2000, 5000]` ms |
| `imageVision` | `chat.completions.create` | 120,000 ms | 2 | `[2000, 5000]` ms |
| `imageDownload` | URL-to-bytes fallback | 30,000 ms | 2 | `[500, 1500]` ms |
| `modelDownload` | model fetch (`mask --method ai`, `model install`) | 600,000 ms | 2 | `[2000, 5000]` ms |

For `modelDownload`, `timeout` bounds the whole streamed download per attempt — finite so a stalled connection retries instead of hanging, but generous because the weights are large (~490 MB).

```sh
gptimg generate "logo" \
  --set network.imageGenerate.timeout=120000 \
  --set 'network.imageGenerate.retryIntervals=[2000,5000,15000]'
```

Retry behavior:

- `Retry-After` and `retry-after-ms` response headers override configured intervals.
- Without retry headers, retry K waits `retryIntervals[min(K - 1, length - 1)]`.
- `[]` means immediate retry; `maxRetries: 0` disables retries.
- Retryable errors include HTTP 408, 409, 429, 5xx, transient network errors, and per-attempt download timeouts.
- 400/401/403/404 and validation failures fail immediately.

Recipe overrides:

```sh
# Layered last-wins: recipe file -> --set
gptimg generate "x" \
  --set size=1024x1024 \
  --set quality=high \
  --set tools.0.type=image_generation \
  --set mask=@./mask.json
```

Bare `--set` keys are scoped under the current verb; paths beginning with `generate`, `edit`, `vision`, `chroma`, or `network` are recipe-rooted.

## Artifacts

| File | Written by |
|---|---|
| `<stem>.<ext>`, `<stem>-N.<ext>`, `<stem>-NN.<ext>` | AI image output(s) |
| `<stem>.json` | Sidecar with resolved request, redacted response, SHA-256 file table |
| `<utc>-gptimg.jsonl` | Per-invocation JSONL log |
| `~/.gptimg/models/<model>.onnx` | Lazily fetched AI models (BiRefNet for `mask --method ai`, Swin2SR for `upscale`) |
| `<input-stem>-mask.png` | `mask` output (grayscale alpha) |
| `<input-stem>-composed.png` | `compose` output (RGBA or flattened RGB) |
| `<input-stem>-<op>.png` | `combine` output (grayscale alpha) |
| `<input-stem>-trim.png` | `trim` output (cropped to alpha bbox + relative margin) |
| `backplate-<size>.png` | `backplate` output (squircle/rect plate on transparent canvas) |
| `<base-stem>-layered.png` | `layer` output (top alpha-composited onto base) |
| `<input-stem>-shadow.png` | `shadow` output (subject over a soft drop shadow; canvas grown unless `--keep-canvas`) |
| `<name>.icns`, `<name>.ico`, `<name>.png` (+ `<name>-<size>.png`) | `icon` output (macOS/Windows containers + master; sized PNGs with `--pngs`) |
| `<input-stem>-upscale.png` | `upscale` output (×4 super-resolution resampled to target, alpha preserved) |
| `<input-stem>-resize.png` | `resize` output (plain model-free resample, alpha preserved) |

Sidecars store basenames for image entries so an image + sidecar pair can be moved together.

## Cancellation

Every SDK method accepts an optional `AbortSignal`. On abort, the SDK rejects with `AbortError` (`errorType: "abort"`, `code: "cancelled"`), closes in-flight HTTP requests, cancels URL downloads, breaks out of retry sleeps, stops local operations at the next phase boundary, and skips sidecar writes that would be incomplete.

Cancellation cannot stop OpenAI server-side inference after the request has been accepted; billing may still occur. It also cannot interrupt a `sharp` decode mid-stage or reverse an atomic write that has already begun.

On the CLI, the first `Ctrl-C` triggers cancellation cleanly; a second `Ctrl-C` exits hard with code 130.

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error |
| 3 | profile or recipe error |
| 4 | provider error |
| 5 | local operation error |
| 130 | cancelled by `Ctrl-C` / abort |

Usage errors are emitted by Commander as plain text with usage help. Runtime errors are emitted as a single JSON object on stderr.

## Development

```sh
npm run build
npm run typecheck
npm test
```

Tests cover the algorithmic core, CLI exit-code boundaries, SDK abort shape, OpenAI provider adapters, network retry behavior, and the chroma pipeline against committed synthetic fixtures under `tests/fixtures/`.

## License

MIT
