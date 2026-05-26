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
