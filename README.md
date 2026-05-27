# GptImg

A TypeScript SDK + CLI for AI image generation, vision verification, and local chroma-key post-processing. Designed to be driven both by humans on the CLI and by AI agents through the SDK, with stable on-disk artifacts (timestamped images, sidecars, JSONL logs) that let an agent iterate without in-process state.

Personal tool. v1 ships OpenAI only; the provider seam is in place but no second provider is shipped.

## Install

```sh
git clone <this repo> gptimg
cd gptimg
npm install
npm run build
```

The build emits `dist/`; the CLI entry is `bin/gptimg.js`. Add to PATH or invoke as `node bin/gptimg.js`.

## Setup

The profile holds the connection info. Two ways to provide the API key:

```sh
# Store the key in the profile (obfuscated on disk).
gptimg profile set-key --key sk-...

# Or reference an environment variable instead.
cat > ~/.gptimg/profile.json <<'EOF'
{ "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY" }
EOF
```

When both are present, the environment variable wins (runtime overrides persistent config).

Defaults all live under `~/.gptimg/`:

| Path | Purpose |
|---|---|
| `~/.gptimg/profile.json` | Provider + API key |
| `~/.gptimg/recipe.json` | Per-verb parameters (optional; missing is fine) |
| `~/.gptimg/output/` | Generated images |
| `~/.gptimg/logs/` | One JSONL file per invocation |

## Models

The default model for `generate` and `edit` is `gpt-image-2`. Override per-call with `--set model=...` or persistently via `profile.json` (`"model": "..."`) or `recipe.json`.

A few gpt-image-2 specifics worth knowing:

- **No transparent backgrounds.** `background: "transparent"` is rejected by gpt-image-2. If you need transparent output, either set `model` to `gpt-image-1.5`, or keep gpt-image-2 and use the chroma-key workflow below (generate against a solid backdrop, then strip it locally).
- **`input_fidelity` is gone.** gpt-image-2 always processes input images at high fidelity; passing the parameter will fail. Our code never sent it.
- **`n > 1` behavior varies.** Some references treat gpt-image-2 generation as fixed at `n=1` while edit requests support 1–10. If a batch request fails, fall back to a single image and call again.
- **Reference images are billed at max fidelity** on edit calls regardless of `quality`. Quality affects output cost only.

### Why `model` (and `network`) live in both profile and recipe

`model` is part-connection-shaped (it gates which features exist, like `provider`) and part-call-shaped (it's a per-request parameter, like `size`). So it can appear in `profile.json` for the stable default and in `recipe.json` for per-project overrides — the recipe value wins. The `network` block below follows the same rule for the same reason.

## Network

Every outbound network call passes through a typed budget that defines the timeout, retry count, and retry schedule. There are three categories:

| Category | Used by | Default timeout | Default retries | Default intervals |
|---|---|---|---|---|
| `imageGenerate` | `images.generate`, `images.edit` | 600,000 ms | 2 | `[2000, 5000]` ms |
| `imageVision` | `chat.completions.create` (vision verb, chroma `--verify`) | 120,000 ms | 2 | `[2000, 5000]` ms |
| `imageDownload` | URL-to-bytes fallback when a response returns a URL instead of base64 | 30,000 ms | 2 | `[500, 1500]` ms |

Override per-category in profile, recipe, `--patch`, or `--set` — last wins:

```jsonc
// ~/.gptimg/profile.json
{
  "provider": "openai",
  "apiKey": "...",
  "network": {
    "imageGenerate": { "timeout": 300000, "maxRetries": 4 }
  }
}
```

```jsonc
// ~/.gptimg/recipe.json
{
  "network": {
    "imageGenerate": { "retryIntervals": [1000, 3000, 10000] }
  },
  "generate": { "size": "1024x1024" }
}
```

```sh
# CLI: arrays and objects are JSON-parsed in --set values
gptimg generate "logo" \
  --set network.imageGenerate.timeout=120000 \
  --set 'network.imageGenerate.retryIntervals=[2000,5000,15000]'
```

**Retry behavior:**

- `Retry-After` and `retry-after-ms` response headers always win — when the server tells us to wait N, we wait N.
- Otherwise, the wait before retry K is `retryIntervals[min(K - 1, length - 1)]`. So `[5000]` means "always wait 5s" and `[]` means immediate retry.
- A mild jitter (75–100%) is applied to scheduled waits.
- Retryable errors: HTTP 408, 409, 429, 5xx, and transient network errors (`ECONNRESET`, `ETIMEDOUT`, etc.). Everything else (400/401/403/404, validation failures) fails immediately.
- `maxRetries: 0` disables retries entirely. The OpenAI SDK's built-in retries are also disabled — we own the policy end-to-end so URL downloads share the same behavior as AI calls.

The legacy top-level `profile.timeout` / `profile.maxRetries` fields are accepted for one release but log a deprecation warning. Move them under `profile.network.imageGenerate` / `profile.network.imageDownload` as appropriate.

## Cancellation

Every SDK method accepts a second argument with an optional `AbortSignal`:

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 30_000);

await sdk.generate({ prompt: "logo" }, { signal: ctrl.signal });
```

When the signal aborts, the SDK rejects with an `AbortError` (`errorType: "abort"`, `code: "cancelled"`) and:

- closes the in-flight HTTP request to OpenAI,
- cancels any URL download in progress,
- breaks out of retry sleeps,
- stops the chroma pipeline at the next phase boundary,
- skips the sidecar write (which would be incomplete and misleading).

What we cannot do:

- Stop OpenAI's server from finishing inference on a request it has already accepted. **You will still be billed for tokens spent server-side.** Cancellation just unblocks our process — it does not refund.
- Stop a `sharp` decode that's mid-stride. We honor the signal *between* stages, not inside them.
- Reverse a `write-file-atomic` write that has already begun. They take fractions of a second so this is rarely visible.

On the CLI, the first `Ctrl-C` triggers cancellation cleanly; a second `Ctrl-C` exits the process hard with code 130. A backstop timer also forces exit after 2 s if the abort doesn't drain.

## Verbs

### `generate`

```sh
gptimg generate "a red coffee mug on a wooden desk"

# With a chroma-key backdrop hint (recipe.json):
#   { "generate": { "chromaKey": { "color": "#00ff00" } } }
gptimg generate "isometric icon of a folder"

# Override recipe fields on the command line.
gptimg generate "logo" \
  --set size=1024x1024 \
  --set quality=high \
  --set n=4
```

Outputs `<utc>-gptimg.png` (or `-01..-NN.png` when n>1) in the out directory, plus a `<stem>.json` sidecar capturing the resolved request and the AI response (base64 image fields nulled in place).

### `edit`

```sh
gptimg edit "remove the background" --in input.png
gptimg edit "fill in the masked area with sky" --in input.png --mask mask.png
```

### `vision`

```sh
gptimg vision \
  --in /tmp/foo.png \
  --check "the subject is a single coffee mug, no other objects"
```

Returns `{ ok, score, reasons }` from a structured `json_schema` response. Images are auto-shrunk to fit inside 1024×1024 before upload (configurable via `recipe.vision.shrink`).

### `chroma`

Local; no API call. Detects and removes a chroma-key background using a region-aware Gaussian model plus smoothstep alpha along the silhouette.

```sh
# Auto-detect the chroma key from the image border.
gptimg chroma --in image.png

# Use the hint stored in the sibling sidecar.
gptimg chroma --in image.png --key from-sidecar

# Two modes: outer (default) keeps interior background pockets opaque;
# all removes them too.
gptimg chroma --in donut.png --mode all

# Chain a vision check after removal.
gptimg chroma --in image.png \
  --verify "background is fully removed and the subject is intact"
```

Writes `<input-stem>-chroma.png` and `<input-stem>-mask.png` next to the input by default. The original is never overwritten. Stats are returned on stdout for the agent's branching:

```json
{
  "stats": {
    "removedFraction": 0.83,
    "regionsRemoved": [{ "area": 5891, "meanConfidence": 0.82, "touchesBorder": true }],
    "noKeyDetected": false,
    "subjectKeyCollisionRisk": false
  }
}
```

### `inspect`

Same detection pipeline as `chroma` but writes nothing — returns the stats only. Useful when an agent wants to decide whether to attempt removal at all.

```sh
gptimg inspect --in image.png
```

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

All verbs return pure data (file paths, hashes, structured stats). The SDK never writes to stdout/stderr — that is the CLI layer's job.

Building blocks are exposed for composition:

```ts
sdk.profile.load / resolve / setApiKey / clearApiKey
sdk.recipe.load / merge / applySet / applyPatch
sdk.sidecar.read / write
sdk.image.hash / detectFormat / shrinkForVision
sdk.log.open / append / close / createLogger
```

## File outputs

| File | Written by |
|---|---|
| `<stem>.<ext>`, `<stem>-NN.<ext>` | AI image output(s) |
| `<stem>.json` | Sidecar — resolved request, AI response (base64 nulled), `files` table with SHA-256 + format |
| `<utc>-gptimg.jsonl` | Per-invocation log; one JSON object per stage |
| `<input-stem>-chroma.png` | Chroma RGBA result |
| `<input-stem>-mask.png` | Chroma alpha mask (where background was removed) |

Sidecars are mobile: filenames are basenames only so an image + sidecar pair can be moved together without breaking references.

## Override mechanism

Recipes can be modified per-call:

```sh
# Layered last-wins: file → --patch → --set
gptimg generate "x" \
  --patch '{"generate":{"size":"1024x1024"}}' \
  --set quality=high \
  --set tools.0.type=image_generation \
  --set mask=@./mask.json
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error |
| 3 | profile or recipe error |
| 4 | provider error (API failure) |
| 5 | local-op error (file I/O, decode, etc.) |

Errors are emitted as a single JSON object on stderr.

## Development

```sh
npm run build       # tsup → dist/ (ESM)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Tests cover the algorithmic core (obfuscation, resolution, recipe merging, output naming, hashing, base64 nulling) and the chroma pipeline against committed synthetic fixtures under `tests/fixtures/`. The fixture generator is `tests/fixtures/_generate.mjs`.

## License

MIT
