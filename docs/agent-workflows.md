# Agent Workflows

This document is the operating manual for AI agents, skills, and automation that drive `gptimg`. It focuses on reliable workflows, artifact handling, and the mask/compose/combine toy lineup.

## Automation Contract

CLI success is emitted as one JSON object on stdout. Runtime errors are emitted as one JSON object on stderr:

```json
{
  "error": {
    "type": "localOp",
    "code": "output.exists",
    "message": "..."
  }
}
```

Usage errors come from Commander and are plain text. Use exit codes to branch:

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error |
| 3 | profile or recipe error |
| 4 | provider error |
| 5 | local operation error |
| 130 | cancelled by `Ctrl-C` / abort |

Each successful call writes durable artifacts:

| Artifact | Purpose |
|---|---|
| image file | Output for later steps |
| sidecar JSON | One per image (`<image-stem>.json`); resolved request + redacted response + this image's hash. Generate/edit/vision. |
| JSONL log | Stage-by-stage trace for debugging |
| mask PNG | Grayscale alpha (`mask`, `combine`) |
| composite PNG | Image flattened against a mask (`compose`) |

The SDK returns structured objects and never writes to stdout/stderr. Every SDK method accepts `{ signal?: AbortSignal }` as a second argument.

## General Agent Rules

- Create a task-specific output directory for every image job.
- Use stable `--out-name` values that describe the artifact role, such as `donut-original`, `donut-mask`, `donut-cutout`.
- Keep the original generated or input image. Treat masks and composites as derived artifacts you can regenerate.
- Do not use `--overwrite` unless intentionally replacing a file. For `generate`/`edit`, `--overwrite` is group-scoped: it allows the planned files to replace existing siblings, but halts with `output.staleSiblings` if a prior run left indexed files the new plan would not replace.
- A profile that stores `apiKey` must be owner-only on POSIX (mode `0600`). `gptimg profile set-key` writes it that way; hand-authored profiles need `chmod 600`.
- Parse stdout JSON for success. Use logs and sidecars for trace/debug context, not primary success detection.
- Treat `partial: true` from `generate` or `edit` as recoverable when at least one file was written.
- Prefer recipes for stable project defaults and `--set` for task-specific overrides.
- Keep network overrides under `network.imageGenerate`, `network.imageVision`, `network.imageDownload`, or `network.modelDownload`; network config is strict and typo-sensitive.
- Always run `mask` against the original image. If you want different mask parameters, rerun from the original — do not pass a previous mask or composite back through `mask`.
- Use `vision` for any semantic quality check, including on a composite.

## Generate And Verify

```sh
mkdir -p ./out/task-001

gptimg generate "single centered product photo of a pink frosted donut" \
  --out-dir ./out/task-001 \
  --out-name donut-original \
  > ./out/task-001/01-generate.json

gptimg vision \
  --in ./out/task-001/donut-original.png \
  --check "one donut is centered, fully visible, and not cropped" \
  --out-dir ./out/task-001 \
  --out-name donut-vision \
  > ./out/task-001/02-vision.json
```

Branching guidance:

- If `generate.partial === false`, all provider items that materialized were written.
- If `generate.partial === true` and `files.length > 0`, continue with the written files or retry missing variants.
- If `vision.ok === false`, either regenerate/edit with a more specific prompt or send the output to a human review step.

## Edit Existing Image

```sh
gptimg edit "remove the background and keep the product intact" \
  --in input.png \
  --out-dir ./out/task-002 \
  --out-name product-edited \
  > ./out/task-002/01-edit.json
```

Use masks when only part of the image should change:

```sh
gptimg edit "replace the masked background with a clear blue sky" \
  --in input.png \
  --mask mask.png \
  --out-dir ./out/task-002 \
  --out-name product-sky
```

## Background Removal Pipeline

The pipeline is three observable steps: produce a mask, optionally combine masks, apply with `compose`.

### Simple chroma backdrop

```sh
gptimg generate "single centered donut on a #00ff00 backdrop" \
  --set chroma.color=#00ff00 \
  --out-dir ./out/task-003 \
  --out-name donut \
  > ./out/task-003/01-generate.json

gptimg mask \
  --in ./out/task-003/donut.png \
  --key from-sidecar \
  --out-dir ./out/task-003 \
  --out-name donut-mask.png \
  > ./out/task-003/02-mask.json

gptimg compose \
  --in ./out/task-003/donut.png \
  --mask ./out/task-003/donut-mask.png \
  --remove-bleed "#00ff00" \
  --out-dir ./out/task-003 \
  --out-name donut-cutout.png \
  > ./out/task-003/03-compose.json

gptimg vision \
  --in ./out/task-003/donut-cutout.png \
  --check "background is transparent and the subject edges look clean" \
  --out-dir ./out/task-003 \
  --out-name donut-verify \
  > ./out/task-003/04-vision.json
```

### Donut hole (interior key-colored region transparent)

The `mask` verb produces a mask whose interior regions are either preserved or removed depending on `--preserve-interior`. Use `combine subtract` to carve a hole out of a shape:

```sh
# Full shape (donut + hole filled in as subject).
gptimg mask \
  --in donut.png --key "#00ff00" --preserve-interior \
  --out-name donut-shape.png

# Just the keyed regions (exterior + hole).
gptimg mask \
  --in donut.png --key "#00ff00" \
  --out-name donut-keyed.png

# Donut with a transparent hole.
gptimg combine subtract --in donut-shape.png --in donut-keyed.png \
  --out-name donut-final-mask.png

gptimg compose --in donut.png --mask donut-final-mask.png \
  --out-name donut-cutout.png
```

### AI mask method

When the subject is not on a uniform chroma backdrop, use `--method ai` instead of `--method chroma`:

```sh
gptimg mask --in scene.png --method ai \
  --out-dir ./out/task-004 \
  --out-name scene-mask.png \
  > ./out/task-004/01-mask-ai.json

gptimg compose --in scene.png --mask ./out/task-004/scene-mask.png \
  --out-dir ./out/task-004 \
  --out-name scene-cutout.png \
  > ./out/task-004/02-compose.json
```

The AI method runs BiRefNet locally via ONNX Runtime. The model is lazily fetched into `~/.gptimg/models/` on first use (override with `GPTIMG_MODELS_DIR`). For offline machines or CI, pre-fetch with `gptimg mask install-model`.

**Resource caution — do not parallelize `--method ai` carelessly.** Every `--method ai` process loads the BiRefNet ONNX session (~500MB) plus inference buffers, peaking around **1–1.5GB RSS** per process in native memory (V8's GC doesn't see it). Running many in parallel pushes the host into swap thrashing and can crash the desktop session — a 24GB machine should run AI masks **sequentially** (shell `&&`, not `&`). The chroma method, by contrast, is light (~100–200MB) and parallel-safe. ONNX Runtime's per-session intra-op thread pool is already capped to half the available cores so multiple sessions don't fight for the CPU, but the memory ceiling is the binding constraint. If you must batch many AI masks, run them one at a time.

### Definitions

- `preserveInterior: false` (default): every key-colored pixel becomes transparent — including interior pockets like donut holes or hair gaps. Chroma method only.
- `preserveInterior: true`: border-connected key regions become transparent; interior key-colored regions stay opaque. Chroma method only.

### Compose targets

- Omit `--over`: write RGBA.
- `--over "#rrggbb"`: flatten over a solid color, write opaque RGB.
- `--over path/to/bg.png`: flatten over another image (must match input size), write opaque RGB.

### Decontamination

`compose --remove-bleed "#rrggbb"` cleans the named background color out of subject pixels. Spill suppression on all kept pixels (chromatic keys) plus alpha-aware edge recovery on partial-α pixels (any key, including gray). Off by default. Use when subject pixels carry visible tint from the background they were photographed against.

## Verification Loops

Use `vision` for any semantic check on a composite. Good prompt:

```text
The subject has a fully transparent background, including intended holes. The subject remains intact, colored details are preserved, and edges are smooth without visible key-color halos or cut-out damage.
```

For generated images, verify before expensive post-processing when possible:

```sh
gptimg vision \
  --in candidate.png \
  --check "the image contains exactly one centered donut with an open center hole and no green color on the donut itself"
```

## Recipe Strategy

Use recipe files for stable defaults:

```jsonc
{
  "generate": {
    "size": "1024x1024",
    "quality": "medium"
  },
  "vision": {
    "shrink": { "width": 1024, "height": 1024 }
  },
  "chroma": {
    "color": "#00ff00",
    "preserveInterior": false
  },
  "network": {
    "imageGenerate": { "timeout": 300000 },
    "imageVision": { "timeout": 120000 }
  }
}
```

Use `--set` for task-specific overrides:

```sh
gptimg generate "logo" \
  --set quality=high \
  --set n=2 \
  --set network.imageGenerate.timeout=600000
```

Scoping rules:

- Bare `--set size=1024x1024` applies to the current verb section.
- `--set network.imageGenerate.timeout=...` applies at the recipe root.
- `--set chroma.color=#00ff00` applies at the recipe root (used by `mask --method chroma` and recorded by `generate` into the sidecar).
- `network` is strict: unknown categories and unknown budget fields fail before the provider call.

## Skill Integration Notes

A skill that wraps `gptimg` should:

- Create a unique work directory for every task.
- Save each command's stdout JSON to a file next to the artifacts.
- Keep original inputs and generated originals.
- Use deterministic artifact names such as `01-generate.json`, `subject-original.png`, `subject-mask.png`, `subject-cutout.png`.
- Parse `files`, `logPath`, `partial`, and `stats` from stdout JSON. Each `files[i]` carries its own `sidecarPath` (per-image sidecar contract — one JSON per image).
- Prefer final composites from the original image, not from diagnostic intermediates.
- Use `vision` on composites for final visual quality.
- Escalate to the user when interior key-like regions overlap plausible subject content.

Minimal skill prompt snippet:

```text
Use gptimg artifacts as durable state. Keep original images. To remove a background: run `mask` to produce an alpha mask, then `compose` to apply it. For subjects with intentional interior key-colored content (donut hole, intentional green segment), produce both a preserve-interior mask and a default mask, then `combine subtract` them before `compose`. When changing parameters, rerun `mask` from the original image. Verify final composites with `vision`.
```
