# GptImg

TypeScript SDK + CLI for AI image generation, vision verification, and local chroma-key post-processing. It is designed for human CLI use and for AI agents or skills that need durable artifacts: timestamped images, JSON sidecars, and JSONL logs.

Personal tool. v1 ships OpenAI only; the provider boundary exists but no second provider is shipped.

## AI Agent Usage

Most automated use should start with the agent manual:

- [Agent workflows and best practices](docs/agent-workflows.md)

Core operating rules:

- Parse CLI stdout JSON for success; runtime errors are JSON on stderr.
- Keep the original generated or input image. Treat chroma outputs as derived artifacts.
- Use task-specific `--out-dir` / `--out-name` values. Use `--overwrite` only when intentionally replacing an artifact group.
- Treat `partial: true` from `generate` / `edit` as recoverable when at least one file was written.
- For subjects with intentional interior key-colored content (donut hole, green segment, green clothing surrounded by non-green), pass `--preserve-interior` to keep those regions opaque.
- When changing chroma key, threshold, `--preserve-interior`, or fill strategy, rerun from the original image. Do not use an already background-removed image as the final source unless intentionally experimenting.

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

Profile files are strict JSON objects. Supported top-level keys are `provider`, `apiKey`, `apiKeyEnv`, `organization`, `project`, and `network`. For org-scoped OpenAI accounts, `organization` and `project` are passed through to the OpenAI SDK.

### Profile file permissions

On POSIX systems, a profile containing `apiKey` must be owner-only (mode `0600`). `gptimg profile set-key` writes the file with that mode automatically; if you hand-author `~/.gptimg/profile.json` and include `apiKey`, run `chmod 600 ~/.gptimg/profile.json` after writing. Loading a loose-mode profile that carries `apiKey` halts with `profile.insecureMode` (exit code 3) and prints the file mode plus the chmod command to run. Profiles that use only `apiKeyEnv` (no stored key) are not subject to this check. The mode check is POSIX-only and is skipped on Windows. If your key was already exposed because the file was loose-mode, rotate it; `clear-key` removes it from the profile but cannot undo prior reads.

Defaults live under `~/.gptimg/`:

| Path | Purpose |
|---|---|
| `~/.gptimg/profile.json` | Provider + API key |
| `~/.gptimg/recipe.json` | Per-verb parameters (optional; missing is fine) |
| `~/.gptimg/output/` | Generated images |
| `~/.gptimg/logs/` | One JSONL file per invocation |

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

Chroma workflow for subjects with intentional key-colored content (donut holes, green segments of a rainbow stamp, a green tie):

```sh
# Run chroma with --preserve-interior to keep interior key-colored regions
# opaque. Without the flag, all key-colored pixels become transparent.
gptimg chroma \
  --in donut-original.png \
  --key from-sidecar \
  --preserve-interior
```

To check the result, run `gptimg vision` against the output with whatever criterion you care about.

## CLI Reference

### `generate`

```sh
gptimg generate "logo" \
  --set size=1024x1024 \
  --set quality=high \
  --set n=4
```

Outputs `<stem>.<ext>` for one image, or indexed filenames such as `<stem>-1.png` / `<stem>-01.png` when multiple images are written. A `<stem>.json` sidecar captures the resolved request and provider response with base64 image fields nulled.

The artifact group for a single `generate`/`edit` invocation is `<stem>.<ext>` plus `<stem>-<digits>.<ext>` siblings plus the `<stem>.json` sidecar in `--out-dir`. Without `--overwrite`, any existing group member blocks with `output.exists`. With `--overwrite`, the run will replace only the files it plans to write; if prior-run group members exist that the new plan would *not* replace (for example, `<stem>-01.png` … `<stem>-10.png` left over from `n=10` when the new run uses `n=2`), the command halts with `output.staleSiblings` rather than silently leaving orphans behind a sidecar that no longer describes them. Delete the listed files or pick a fresh `--out-name`. Chroma-derived siblings (`<stem>-mask.png`, `<stem>-chroma.png`) are not part of the generate/edit group and are never touched by this check.

If `recipe.chroma.color` is set, `generate` records the color in the sidecar so later `chroma --key from-sidecar` can reuse it.

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

### `chroma`

```sh
# Auto-detect the chroma key from the image border.
gptimg chroma --in image.png

# Use the hint stored in the sibling sidecar.
gptimg chroma --in image.png --key from-sidecar

# Keep interior key-colored regions opaque (donut hole, intentional green subject content).
gptimg chroma --in donut.png --preserve-interior
```

Local only; no API call.

Algorithm: the chroma background is detected with a Gaussian color model in LAB and per-pixel α is derived from the linear-RGB spill ratio `α = 1 − spill / key_strength`, where `spill = max(0, key_channel − max(other_channels))`. A pure-key pixel is fully transparent regardless of where it sits. For partial-α pixels the foreground color is inpainted by iterated dilation from confirmed-opaque pixels, so edges fade as the real subject color rather than as a dark Vlahos clip or a green halo.

By default, every key-colored pixel becomes transparent — including interior regions like donut holes or intentional green subject content. Pass `--preserve-interior` to force interior key-colored regions to stay opaque. Border-connected key regions are always removed.

## SDK

```ts
import { GptImg } from "gptimg";

const sdk = new GptImg();

const gen = await sdk.generate({ prompt: "a red mug" });
const verdict = await sdk.vision({
  in: gen.files[0].path,
  check: "subject is centered and well-lit",
});
const chroma = await sdk.chroma({ in: gen.files[0].path });
```

All SDK verbs return data objects and never write to stdout/stderr. Each method accepts `{ signal?: AbortSignal }` as a second argument.

Building blocks are exposed for composition:

```ts
sdk.profile.load / resolve / setApiKey / clearApiKey
sdk.recipe.load / merge / applySet / applyPatch
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
| `<input-stem>-chroma.png` | Chroma RGBA result |
| `<input-stem>-mask.png` | Chroma alpha mask |

Sidecars store basenames for image entries so an image + sidecar pair can be moved together.

## Cancellation

Every SDK method accepts an optional `AbortSignal`. On abort, the SDK rejects with `AbortError` (`errorType: "abort"`, `code: "cancelled"`), closes in-flight HTTP requests, cancels URL downloads, breaks out of retry sleeps, stops chroma at the next phase boundary, and skips sidecar writes that would be incomplete.

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
