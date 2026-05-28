# Agent Workflows

This document is the operating manual for AI agents, skills, and automation that drive `gptimg`. It focuses on reliable workflows, artifact handling, and safe chroma-key decisions.

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
| 4 | provider/API error |
| 5 | local file/decode/output/log error |
| 130 | cancellation |

Each successful image-producing call writes durable artifacts:

| Artifact | Purpose |
|---|---|
| image file | Output for later steps |
| sidecar JSON | Resolved request, redacted provider response, output file hashes |
| JSONL log | Stage-by-stage trace for debugging |
| mask PNG | Chroma removal mask |
| verify preview | Checkerboard preview used for vision checks |

The SDK returns structured objects and never writes to stdout/stderr. Every SDK method accepts `{ signal?: AbortSignal }` as a second argument.

## General Agent Rules

- Create a task-specific output directory for every image job.
- Use stable `--out-name` values that describe the artifact role, such as `donut-original`, `donut-final`, or `logo-verify`.
- Keep the original generated or input image. Treat `chroma` outputs as derived artifacts.
- Do not use `--overwrite` unless intentionally replacing an artifact group. `--overwrite` is group-scoped: it allows the planned files to replace existing siblings, but halts with `output.staleSiblings` if a prior run left indexed files the new plan would not replace (for example, `n=10` followed by `--overwrite` with `n=2`). Delete the listed orphans or choose a fresh `--out-name`.
- A profile that stores `apiKey` must be owner-only on POSIX (mode `0600`). `gptimg profile set-key` writes it that way; hand-authored profiles need `chmod 600`. Loading a loose-mode profile that carries an `apiKey` halts with `profile.insecureMode` (exit code 3).
- Parse stdout JSON for success. Use logs and sidecars for trace/debug context, not primary success detection.
- Treat `partial: true` from `generate` or `edit` as recoverable when at least one file was written.
- Prefer recipes for stable project defaults and `--set` for task-specific overrides.
- Keep network overrides under `network.imageGenerate`, `network.imageVision`, or `network.imageDownload`; network config is strict and typo-sensitive.
- Use `vision` for semantic quality checks and `inspect` for chroma-region decisions.

## Generate And Verify

CLI:

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
  --out-name donut-original-vision \
  > ./out/task-001/02-vision.json
```

SDK:

```ts
import { GptImg } from "gptimg";

const sdk = new GptImg();

const gen = await sdk.generate({
  prompt: "single centered product photo of a pink frosted donut",
  outDir: "./out/task-001",
  outName: "donut-original",
});

const verdict = await sdk.vision({
  in: gen.files[0]!.path,
  check: "one donut is centered, fully visible, and not cropped",
  outDir: "./out/task-001",
  outName: "donut-original-vision",
});
```

Branching guidance:

- If `generate.partial === false`, all provider items that materialized were written.
- If `generate.partial === true` and `files.length > 0`, continue with the written files or retry missing variants.
- If `vision.ok === false`, either regenerate/edit with a more specific prompt or send the output to a human review step.

## Edit Existing Image

CLI:

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

The same artifact and `partial` rules as `generate` apply.

## Chroma Strategy

Chroma removal is local and fast, but the decision to remove interior key-colored regions is semantic. Agents should avoid dropping subject content that merely resembles the key color.

Definitions:

- `preserveInterior: false` (default): every key-colored pixel becomes transparent — including interior pockets like donut holes or hair gaps.
- `preserveInterior: true`: border-connected key regions become transparent; interior key-colored regions stay opaque with their original color.
- `touchesBorder: false`: an interior candidate region; this may be a background hole or accidental subject content.
- `subjectKeyCollisionRisk: true`: key-like pixels remain outside the accepted background. This is a warning to inspect, not an automatic failure.

### Interior-Preservation Workflow

Use `--preserve-interior` when the subject legitimately contains key-colored regions: donut holes you want to keep, a rainbow stamp with green segments, a green tie surrounded by non-green clothing.

1. Keep the original image as source of truth.
2. Inspect the original with `--preserve-interior` to see which interior regions would be preserved.
3. Inspect the original without `--preserve-interior` to see the aggressive (default) accounting.
4. Decide which behavior fits the subject.
5. Run `chroma` with the matching flag on the original.
6. Verify the final output with local alpha checks, final inspect, and a checkerboard preview.

Example:

```sh
gptimg inspect \
  --in donut-original.png \
  --key from-sidecar \
  --preserve-interior \
  > 01-inspect-preserve.json

gptimg inspect \
  --in donut-original.png \
  --key from-sidecar \
  > 02-inspect-aggressive.json

gptimg chroma \
  --in donut-original.png \
  --key from-sidecar \
  --preserve-interior \
  --out-name donut-final.png \
  --mask-name donut-final-mask.png \
  --verify "background is transparent; the donut hole stays opaque; subject edges are smooth" \
  > 03-chroma-final.json

gptimg inspect \
  --in donut-final.png \
  --key '#00ff00' \
  > 04-inspect-final.json
```

Expected final checks:

- `03-chroma-final.json.alphaVerify.ok === true`
- `03-chroma-final.json.verify.ok === true`, when `--verify` is used
- `04-inspect-final.json.stats.removedPixels === 0` for the explicit key
- no visible green halo in the verify preview

### Do Not Chain Settings Through Chroma Outputs

If changing chroma key, threshold, `--preserve-interior`, or fill strategy, rerun from the original image.

Do not use an already background-removed image as the final source for a new strategy. The chroma pipeline computes a fresh alpha matte from the input pixels; it does not compose with existing alpha.

## Verification Loops

Use both local and semantic checks:

- `inspect` answers: are key-colored regions still present?
- local `alphaVerify` answers: is the alpha structure plausible?
- `vision` answers: does the subject still look correct?

Good chroma verification prompt:

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

- `--patch` deep-merges a JSON object at the recipe root.
- Bare `--set size=1024x1024` applies to the current verb section.
- `--set network.imageGenerate.timeout=...` applies at the recipe root.
- `network` is strict: unknown categories and unknown budget fields fail before the provider call.

## Skill Integration Notes

A skill that wraps `gptimg` should:

- Create a unique work directory for every task.
- Save each command's stdout JSON to a file next to the artifacts.
- Keep original inputs and generated originals.
- Use deterministic artifact names such as `01-generate.json`, `subject-original.png`, `subject-final.png`.
- Parse `files`, `sidecarPath`, `logPath`, `partial`, `stats`, `alphaVerify`, and `verify` from stdout JSON.
- Treat `subjectKeyCollisionRisk` and interior `touchesBorder: false` regions as review points.
- Prefer final chroma renders from the original image after inspection, not from diagnostic intermediates.
- Use `vision` on checkerboard previews for final visual quality.
- Escalate to the user when interior key-like regions overlap plausible subject content.

Minimal skill prompt snippet:

```text
Use gptimg artifacts as durable state. Keep original images. Before chroma removal, inspect the original. If the subject has interior key-colored content that must be kept (donut hole, intentional green segment), use `--preserve-interior`; otherwise the default removes all key-colored pixels. When changing chroma settings, rerun from the original image. Do not use already background-removed intermediates as final sources. Verify final outputs with inspect and vision.
```
