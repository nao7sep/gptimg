# gptimg — Reference

The behavioral contract for the gptimg toolkit. gptimg is SDK-first: every capability is a method on the `GptImg` class (exported from the package entry), and the CLI (`gptimg <subcommand>`) is a thin bridge that parses the invocation, calls exactly one SDK method, and renders the result. Each capability below is described once; the SDK method name and the CLI subcommand name are identical unless noted. Argument types and bounds shown here are enforced by the SDK and apply identically to both callers — the CLI only coerces command-line strings to typed values.

This document covers the contract a reader cannot get cheaply from the code: result envelopes, error/exit semantics, cancellation, on-disk artifacts, and resolved defaults. Per-flag help and method signatures are derivable from `--help` and the exported TypeScript types and are not restated.

---

## The shared call contract

Every verb obeys the same I/O and failure model.

### Construction and ambient state

`new GptImg(opts?)` — `opts.profileDir` (default `~/.gptimg`) and `opts.logDir` (default `<profileDir>/logs`). All ambient locations derive from `profileDir`:

- Profile: `<profileDir>/profile.json`
- Recipe (default): `<profileDir>/recipe.json`
- Output (default for `generate`/`edit`/`vision`): `<profileDir>/output`
- Model cache: `<profileDir>/models`, overridable by the `GPTIMG_MODELS_DIR` environment variable
- Logs: `<profileDir>/logs`

The CLI always constructs `GptImg` with defaults; it does not expose `--profile-dir`/`--log-dir`.

### Call options (`VerbCallOptions`)

Every verb method takes an optional second argument:

- `signal?: AbortSignal` — cancellation (see [Cancellation](#cancellation)).
- `onProgress?: (entry: LogEntry) => void` — progress sink. The SDK calls this for each non-error stage event it also writes to the log; with no callback the SDK is silent and writes nothing to any stream. The CLI always supplies a callback that renders each event to stderr.

`LogEntry` shape: `{ time, level: "debug"|"info"|"warn"|"error", message, verb, stage, data? }`. `time` is UTC ISO-8601 with milliseconds and `Z`. `stage` is one of `resolve | request | response | write | stats | retry | download | infer | cancelled | error | log`.

### Output channels (CLI)

- **stdout** carries exactly one JSON document on success, written once at the end. It is the verb's typed result object serialized as JSON (pretty-printed when stdout is a TTY, compact otherwise). On failure, stdout is empty.
- **stderr** carries progress (one `LogEntry` JSON object per line, JSONL) and the error document. Progress is on by default; the global `--quiet` flag suppresses progress but not errors.

The SDK itself never writes to stdout or stderr; it returns the typed result object.

### Errors and exit codes

The SDK throws typed errors; every error is a subclass of `GptImgError` with a stable `.code` string and an `.errorType`. The CLI maps the error to an exit code and renders it.

| `errorType` | SDK class | Exit code | Renders on stderr as |
|---|---|---|---|
| (usage — see below) | any of the below, when `code` is in the usage set | `2` | plain `error: <message>` line |
| `profile` | `ProfileError` | `3` | structured `{ error: { type, code, message } }` |
| `recipe` | `RecipeError` | `3` | structured |
| `provider` | `ProviderError` | `4` | structured |
| `localOp` | `LocalOpError` | `5` | structured |
| `abort` | `AbortError` | `130` | (not rendered as an error document) |
| (anything else, non-`GptImgError`) | — | `1` | structured with `type: "unknown"` |

**Usage versus runtime** is decided by the error's `code`, not its class — a single classifier (`isUsageError`) drives both the exit code and the rendered form. A usage error is the caller's fault (a bad value, a malformed flag, a profile/recipe the caller named or wrote, an output collision, a missing key, an insecure profile mode) and always exits `2` regardless of the error class that carried it. The usage `code` set is:

```
args.invalid, image.noContent, image.sizeMismatch, vision.detailUnsupported,
output.mixedExtensions, set.invalidExpression, provider.unknown,
recipe.notFound, recipe.invalidJson, recipe.validationFailed,
profile.notFound, profile.invalidJson, profile.validationFailed,
output.exists, output.staleSiblings, apiKey.missing, profile.insecureMode
```

Everything else (I/O, network, model, provider runtime failures) is a runtime error mapped to the domain code in the table above. The full code catalogue is in [Error codes](#error-codes).

Commander-level parse failures (unknown flag, missing required argument, bad enum token, non-coercible value, and `--help`/`--version`) exit `2` for errors and `0` for help/version, before any SDK call.

### Cancellation

Every verb accepts `signal`. On abort the SDK stops at the next boundary — a pending provider request, a URL/model download, a retry sleep, or a phase edge — and throws `AbortError` (`errorType: "abort"`, `code: "cancelled"`). Work a remote service has already accepted may keep running and billing; the guarantee is only that the local process stops listening promptly. The CLI installs a SIGINT handler: the first Ctrl-C aborts; a second Ctrl-C within a 2-second grace window forces an immediate exit. Cancellation exits `130`.

### Logging and on-disk session log

Every verb call opens one per-operation log file and returns its path in the result (`logPath`, or `sidecarPath`/`outputs` carrying it transitively). Default log path: `<logDir>/<yyyymmdd-hhmmss-fff-utc>.log` (JSON Lines; millisecond precision so concurrent runs never share a file). A caller-supplied `log` argument overrides the path. Secrets are redacted (by exact, case-insensitive field name: `apikey`, `authorization`, `token`, `password`, `secret`) before any result, log record, or sidecar is written.

Separately, the **CLI process** writes a session-lifecycle log (startup/shutdown/crash) under `<logDir>` — this is a CLI-only concern; the SDK installs no global process handlers.

### Concurrency

Concurrent invocation is expected. The model cache and any shared file are published by atomic rename, so parallel runs never corrupt shared state; they only waste work. Per-run outputs go to caller-chosen (or timestamped) paths. First-time setup that is best done once before fanning out: `profile set-key` and `model install` (the model download is a large one-shot fetch).

### Network budgets and retries (provider-backed and model-download verbs)

Timeout/retry policy lives in the SDK and is configurable via the recipe `network` section. Defaults per category:

| Budget | timeout (ms) | maxRetries | retryIntervals (ms) |
|---|---|---|---|
| `imageGenerate` (generate, edit) | 600000 | 2 | [2000, 5000] |
| `imageVision` (vision) | 120000 | 2 | [2000, 5000] |
| `imageDownload` (fetching result image URLs) | 30000 | 2 | [500, 1500] |
| `modelDownload` (BiRefNet/Swin2SR fetch) | 600000 | 2 | [2000, 5000] |

`timeout` is per-attempt; `0` disables it. Retries are bounded (`1 + maxRetries` attempts) and apply only to transient boundaries: retryable HTTP statuses (`408, 429, 5xx`, several Cloudflare codes) and network error codes (`ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EPIPE`, undici socket/connect-timeout). Aborts are never retried. Backoff uses the schedule with equal jitter; a `Retry-After` / `retry-after-ms` response header overrides the wait for that attempt. Every retry is reported through `onProgress` as a `retry`-stage event. Invalid arguments, missing local files, output collisions, and local computation failures are never retried.

### Output collisions and overwrite

By default a verb refuses to overwrite existing output. The behavior differs by verb family:

- **Single-file verbs** (mask, compose, combine, trim, backplate, layer, shadow, resize, upscale, vision-sidecar): throw `output.exists` if the target path exists; `overwrite: true` allows replacement.
- **Artifact-group verbs** (generate, edit): the group is `<stem>` plus its image extension plus one `.json` sidecar per image. Without `overwrite`, *any* existing group sibling throws `output.exists`. With `overwrite: true`, planned files are replaced, but group siblings from a prior run that this run will **not** replace (e.g. a leftover image at a different `n`) throw `output.staleSiblings` — the caller must delete them or pick a fresh `outName`. The check runs once before the paid provider call (sidecar-based, fail-fast) and again after the response as the authority.

---

## Provider-backed verbs

These resolve a profile (for the API key) and a recipe (for model/params), call the configured provider, write outputs, and emit per-image sidecars. The only provider supported is `openai`.

### `generate(args, opts?) → GenerateResult`

**Purpose:** Generate one or more images from a text prompt.

**Arguments (`GenerateArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `prompt` | string | required, non-empty | Text prompt. |
| `outDir` | string | default `<profileDir>/output` | Output directory. |
| `outName` | string | default `<yyyymmdd-hhmmss-utc>-gptimg` | Output filename stem (no extension; absolute stem overrides `outDir`). |
| `profile` | string | default `<profileDir>/profile.json` | Profile path. |
| `recipe` | string | default `<profileDir>/recipe.json` if present, else `{}` | Recipe path. |
| `log` | string | default per-session log | Log file path. |
| `set` | string[] | optional | Recipe overrides; see [Recipes](#recipes-and-the---set-override). |
| `overwrite` | boolean | default `false` | Allow replacing the artifact group. |

Image parameters (`model`, `size`, `quality`, `n`, and any provider passthrough) come from the recipe `generate` section, not from args. Default model `gpt-image-2`. `n` defaults to `1`. The recipe `chroma.color`, when set, is recorded into each sidecar's `request.chroma` (it does not alter the generated pixels — it is a hint for a later `mask --method chroma --key from-sidecar`).

**Result (`GenerateResult`):** `{ files: OutputFile[], logPath: string, partial: boolean }`. Each `OutputFile` is `{ index, path, sidecarPath, sha256, format }`. `partial` is `true` if the provider returned some images that failed to decode/write (those are logged as warnings and omitted from `files`); the call still succeeds.

**On-disk artifacts:** For `n=1`, `<stem>.<ext>` + `<stem>.json`. For `n>1`, `<stem>-NN.<ext>` + `<stem>-NN.json` (zero-padded index, one sidecar per image). Image extension is detected from the returned bytes; if the provider returns images with mixed extensions in one group, the call throws `output.mixedExtensions`. Each sidecar is `{ request, response, files }` — `request` echoes the params + prompt + n (+ chroma); `response` is the raw provider response with any base64 image payloads nulled out; `files` carries that one image's `{ index, name, sha256, format }`.

**Failure modes:** `args.invalid` (empty prompt); `profile.*` / `apiKey.missing` (profile resolution); `recipe.*` / `set.invalidExpression`; `provider.unknown` (unknown provider in profile), `provider.requestFailed` (API call failed after retries); `output.exists` / `output.staleSiblings` / `output.mixedExtensions`; `AbortError`.

### `edit(args, opts?) → EditResult`

**Purpose:** Edit an existing image from a prompt, optionally masked.

**Arguments (`EditArgs`):** all of `GenerateArgs`, plus:

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | Source image path. |
| `mask` | string | optional | Mask image path (transparent areas are the editable region, per the provider's convention). |

Params come from the recipe `edit` section (same shape as `generate`; default model `gpt-image-2`, `n` default `1`).

**Result (`EditResult`):** identical shape to `GenerateResult`.

**On-disk artifacts:** identical to `generate`.

**Failure modes:** as `generate`, plus `image.readFailed` if `in` (or `mask`, when given) is not readable.

### `vision(args, opts?) → VisionResult`

**Purpose:** Ask a vision model a yes/no verification question about one or more images, returning a structured verdict.

**Arguments (`VisionArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string \| string[] | required, ≥1 | Image path(s) to inspect. |
| `check` | string | required, non-empty | The criterion to verify. |
| `profile` | string | default profile path | Profile path. |
| `recipe` | string | default recipe | Recipe path. |
| `outDir` | string | default `<profileDir>/output` | Sidecar directory. |
| `outName` | string | default `<timestamp>-gptimg` | Sidecar filename stem. |
| `log` | string | default per-session log | Log path. |
| `set` | string[] | optional | Recipe overrides (scoped to `vision`). |
| `overwrite` | boolean | default `false` | Overwrite an existing sidecar at the resolved stem. |

Vision params come from the recipe `vision` section: `model` (default `gpt-5.4-mini`), `detail` (`low | high | original | auto`), `systemPrompt`, and `shrink` (`{ width, height }`, default `{ 1024, 1024 }`). Each input is shrunk to fit the `shrink` box before upload (aspect preserved; only downsized).

**Result (`VisionResult`):** `{ ok: boolean, score: number, reasons: string[], raw: unknown, sidecarPath: string, logPath: string }`. `ok` is the model's verdict, `score` its confidence in `[0,1]`, `reasons` concrete observations.

**On-disk artifacts:** one sidecar `<stem>.json` (no image output). `request` holds the params, check, detail, and per-input `{ name, shrink }`; `response` holds `{ verdict, raw }`; `files` is `[]`.

**Failure modes:** `args.invalid` (empty `in`/`check`); `image.readFailed` (unreadable input); `profile.*` / `apiKey.missing`; `recipe.*`; `provider.requestFailed`, `provider.invalidResponse` (response empty/non-JSON/off-schema); `vision.detailUnsupported` (`detail: "original"` against a model that does not support it — usage error); `output.exists` (sidecar collision without `overwrite`); `AbortError`.

---

## Local image operations

These run entirely on-device (no provider, no API key). `mask --method ai` and `upscale` additionally need a local ONNX model (auto-fetched on first use; see [Model management](#model-management)). All take optional `outDir` / `outName` / `log` / `overwrite`. Unless noted, `outDir` defaults to the directory of the primary input, `outName` defaults as listed, and all outputs are PNG.

### `mask(args, opts?) → MaskResult`

**Purpose:** Produce a grayscale alpha mask separating subject from background (255 = subject, 0 = background).

**Arguments (`MaskArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | Input image. |
| `method` | `"chroma"` \| `"ai"` | default `"chroma"` | Masking method. |
| `key` | `"auto"` \| `"from-sidecar"` \| `#rrggbb` | chroma only; default `"auto"` | Key-color source. `auto` = mean of border pixels (depth `borderSample`); `from-sidecar` reads the color recorded by `generate`; a hex sets it explicitly. |
| `preserveInterior` | boolean | chroma only; default `false` | Keep interior key-colored regions opaque (e.g. a donut hole) instead of removing them. |
| `borderSample` | int > 0 | chroma only; default `4` | Border-sample depth in px for `auto`. |
| `saturationRatio` | number in (0,1] | chroma only; default `0.82` | Spill ratio at which near-key pixels saturate to α=0. |
| `dryRun` | boolean | default `false` | Compute stats only; write no mask. |
| `recipe` | string | optional | Recipe (its `chroma` section supplies chroma defaults when args omit them). |

Method `ai` ignores the chroma knobs and runs BiRefNet over the whole image.

**Result (`MaskResult`):** `{ input, output: string|null, stats, logPath }`. `output` is `null` when `dryRun`. `stats` is a discriminated union on `method`: chroma → `{ method:"chroma", key:"#rrggbb", keySource:"auto"|"sidecar"|"explicit", preserveInterior, removedPixels, removedFraction, width, height }`; ai → `{ method:"ai", model:"birefnet", removedPixels, removedFraction, width, height }`.

**On-disk artifacts:** `<in-stem>-mask.png` (unless `dryRun`).

**Note:** for a chroma `key` that is achromatic or multi-channel (gray, or no dominant channel), the spill formula does not apply and the mask comes back fully opaque (everything kept) — a no-op rather than an error.

**Failure modes:** `args.invalid` (bad `key` token, bad ranges); `output.exists`; for `ai`/model-download failures: `model.downloadFailed`, `model.checksumMismatch`, `model.loadFailed`, `model.outputShape`; `image.*` decode/read failures; `AbortError`.

### `compose(args, opts?) → ComposeResult`

**Purpose:** Apply a mask to an image (cutout), optionally flattening over a backdrop and removing background bleed.

**Arguments (`ComposeArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | Source image. |
| `mask` | string | required | Alpha mask (same dimensions as `in`). |
| `over` | `"transparent"` \| `#rrggbb` \| `<path>` | default transparent | Flatten target: transparent output, a solid color, or another image. |
| `removeBleed` | `#rrggbb` | optional | Remove the named background color from kept subject pixels. The math dispatches on the key's chromaticity: a chromatic key gets spill suppression at every kept pixel (no edge recovery); an achromatic (gray) key gets alpha-aware edge recovery at partial-α pixels only. |

**Result (`ComposeResult`):** `{ input, mask, output, width, height, over: "transparent"|"color"|"image", logPath }`.

**On-disk artifacts:** `<in-stem>-composed.png`.

**Failure modes:** `args.invalid` (bad `removeBleed` hex; an `over` value that looks like hex but lacks `#`); `image.sizeMismatch` (mask size ≠ image size); `output.exists`; `image.*`; `AbortError`.

### `combine(args, opts?) → CombineResult`

**Purpose:** Boolean and morphological operations on masks.

**Arguments (`CombineArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `op` | `union` \| `intersect` \| `subtract` \| `invert` \| `feather` | required | The operation. |
| `inputs` | string[] | required; exactly 1 for `invert`/`feather`, exactly 2 for the binary ops | Mask path(s). |
| `radius` | number in [0,1024] | default `1` | Feather radius (count of 3×3 box-blur passes); ignored by other ops. |

**Result (`CombineResult`):** `{ inputs, output, width, height, op, logPath }`.

**On-disk artifacts:** `<first-input-stem>-<op>.png`.

**Failure modes:** `args.invalid` (wrong input arity for the op, bad `radius`); `image.sizeMismatch` (the two binary-op inputs differ in size); `output.exists`; `image.*`; `AbortError`.

### `trim(args, opts?) → TrimResult`

**Purpose:** Crop to the tightest non-transparent bounding box, re-pad by a margin, optionally square.

**Arguments (`TrimArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | RGBA input. |
| `margin` | number in [0,1] | default `0.08` | Re-pad margin as a fraction of the longer bbox side. |
| `square` | boolean | default `false` | Extend the shorter axis with transparency to make the output square. |

**Result (`TrimResult`):** `{ input, output, bbox:{x,y,width,height}, margin, marginPx, width, height, square, logPath }`. `marginPx = round(margin * max(bbox.width, bbox.height))`.

**On-disk artifacts:** `<in-stem>-trim.png`.

**Failure modes:** `args.invalid` (bad `margin`); `image.noContent` (input is fully transparent — usage error); `image.writeFailed`; `output.exists`; `AbortError`.

### `backplate(args, opts?) → BackplateResult`

**Purpose:** Render a square gradient backplate with rounded/squircle corners (e.g. an app-icon base). Takes no input image.

**Arguments (`BackplateArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `from` | `#rrggbb` | required | Gradient start color. |
| `to` | `#rrggbb` | required | Gradient end color. |
| `size` | int > 0 | default `1024` | Output side length in px. |
| `content` | number in (0,1] | default `0.80` | Content (squircle) side as a fraction of `size`. |
| `radius` | number in [0,0.5] | default `0.225` | Corner radius as a fraction of the content side. |
| `angle` | number | default `135` | CSS-style gradient angle (0 = bottom→top, 90 = left→right, 180 = top→bottom). |
| `shape` | `"rect"` \| `"squircle"` | default `"rect"` | Corner shape. |

`outDir` defaults to the current working directory (no input file to derive from).

**Result (`BackplateResult`):** echoes the resolved `output, size, content, radius, shape, from, to, angle, logPath`.

**On-disk artifacts:** `backplate-<size>.png`.

**Failure modes:** `args.invalid` (missing/bad colors, out-of-range knobs); `image.writeFailed`; `output.exists`; `AbortError`.

### `layer(args, opts?) → LayerResult`

**Purpose:** Composite a top image onto a base, with optional scaling and placement. The canvas stays at the base's size.

**Arguments (`LayerArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `base` | string | required | Bottom layer (e.g. a backplate). |
| `top` | string | required | Foreground (e.g. trimmed content). |
| `scale` | number > 0 | optional | Resize `top` so its longer side = `scale * min(baseW, baseH)`; aspect preserved. Omit to keep native size. |
| `gravity` | `center` \| `north` \| `south` \| `east` \| `west` \| `northeast` \| `northwest` \| `southeast` \| `southwest` | default `"center"` | Placement anchor; ignored when `topOffset` is given. |
| `topOffset` | `{ x:int, y:int }` | optional | Explicit pixel offset of `top` (overrides `gravity`). |

**Result (`LayerResult`):** `{ base, top, output, width, height, topWidth, topHeight, gravity: LayerGravity|null, topOffset: {x,y}|null, logPath }`. Exactly one of `gravity`/`topOffset` is non-null.

**On-disk artifacts:** `<base-stem>-layered.png`.

**Failure modes:** `args.invalid` (bad `scale`/`gravity`/non-integer `topOffset`; `scale` that resolves to < 1px; `top` larger than `base` after scaling; `topOffset` that places `top` outside the base); `image.decodeFailed` / `image.noContent` (unreadable or degenerate inputs); `image.writeFailed`; `output.exists`; `AbortError`.

### `shadow(args, opts?) → ShadowResult`

**Purpose:** Cast a soft drop shadow from an RGBA subject's alpha shape.

**Arguments (`ShadowArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | RGBA input (its alpha casts the shadow). |
| `blur` | number; `0` or in [0.3, 1000] | default `12` | Gaussian blur sigma in px (`0` = hard edge). |
| `offset` | `{ x:int, y:int }`, \|x\|,\|y\| ≤ 10000 | default `{ x:0, y:8 }` | Shadow displacement (may be negative). |
| `color` | `#rrggbb` | default `"#000000"` | Shadow color. |
| `opacity` | number in (0,1] | default `0.35` | Peak shadow opacity. |
| `spread` | int in [0,1024] | default `0` | Grow the shadow shape outward before blurring. |
| `keepCanvas` | boolean | default `false` | Keep the canvas at input size (clipping overflow). Default grows the canvas so the shadow is never cut. |

**Result (`ShadowResult`):** `{ input, output, width, height, sourceWidth, sourceHeight, blur, offset, color, opacity, spread, keepCanvas, logPath }`.

**On-disk artifacts:** `<in-stem>-shadow.png`.

**Failure modes:** `args.invalid` (out-of-range knobs, non-integer offset/spread); `image.writeFailed`; `output.exists`; `AbortError`.

### `resize(args, opts?) → ResizeResult`

**Purpose:** Resample to a target longer-side length, aspect preserved, alpha preserved.

**Arguments (`ResizeArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | Input (any format sharp reads). |
| `toSize` | int in [1, 16384] | required | Output longer-side length in px. |
| `kernel` | `nearest` \| `cubic` \| `mitchell` \| `lanczos2` \| `lanczos3` | default `"lanczos3"` | Resampling kernel. |

**Result (`ResizeResult`):** `{ input, output, sourceWidth, sourceHeight, width, height, toSize, kernel, logPath }`.

**On-disk artifacts:** `<in-stem>-resize.png`.

**Failure modes:** `args.invalid` (missing/out-of-range `toSize`, bad `kernel`); `image.decodeFailed` / `image.noContent`; `image.writeFailed`; `output.exists`; `AbortError`.

### `upscale(args, opts?) → UpscaleResult`

**Purpose:** Super-resolve via the Swin2SR ×4 model, then resample to a target size. Needs the `swin2sr` model (auto-fetched).

**Arguments (`UpscaleArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | Input RGBA image. |
| `toSize` | int in [1, 8192] | default `1024` | Final output longer-side length (aspect preserved). |
| `kernel` | resample kernel (as `resize`) | default `"lanczos3"` | Kernel for the resize after the model's ×4. |
| `tile` | int ≥ model-min | default the model's default tile | Max model-input edge per pass — the memory knob. |
| `recipe` | string | optional | Recipe (for the `network.modelDownload` budget). |

**Result (`UpscaleResult`):** `{ input, output, sourceWidth, sourceHeight, modelWidth, modelHeight, width, height, toSize, kernel, tile, tiles, logPath }`. `modelWidth/Height` is the size after the native ×4; `tiles` is the number of model passes the source was split into.

**On-disk artifacts:** `<in-stem>-upscale.png`.

**Failure modes:** `args.invalid` (out-of-range `toSize`/`tile`, bad `kernel`); model fetch/inference: `model.downloadFailed`, `model.checksumMismatch`, `model.loadFailed`, `model.outputShape`; `image.writeFailed`; `output.exists`; `AbortError`.

### `icon(args, opts?) → IconResult`

**Purpose:** Pack a square master PNG into platform icon files (`.icns`, `.ico`, a base `.png`) and optionally a sized-PNG set.

**Arguments (`IconArgs`):**

| Field | Type | Req/Default | Meaning |
|---|---|---|---|
| `in` | string | required | Square master PNG, ≥ 1024×1024. |
| `name` | plain filename stem (no path separators) | default `"icon"` | Base filename stem → `<name>.icns/.ico/.png`. |
| `pngs` | boolean | default `false` | Also emit the loose sized-PNG set `<name>-<size>.png` for sizes 16…1024. |
| `outDir` | string | default the directory of `in` | Output directory. |

**Result (`IconResult`):** `{ input, outputs: string[], icns, ico, png, pngs: string[], width, height, logPath }`. `outputs` lists every file written (absolute); `pngs` is empty unless requested. `width/height` are the master dimensions.

**On-disk artifacts:** `<name>.icns`, `<name>.ico`, `<name>.png`, and (when `pngs`) `<name>-16.png` … `<name>-1024.png`.

**Failure modes:** `args.invalid` (name with path separators; master not square; master smaller than 1024×1024); `image.decodeFailed` / `image.noContent`; `image.writeFailed`; `output.exists`; `AbortError`.

---

## Model management

Two AI models are lazily fetched into the cache (`<profileDir>/models`, or `GPTIMG_MODELS_DIR`): `birefnet` (BiRefNet matting, used by `mask --method ai`) and `swin2sr` (Swin2SR ×4 super-resolution, used by `upscale`). Each is pinned to an immutable URL and verified against a pinned SHA-256 after download. Methods live under `GptImg.model`; the CLI exposes them as `gptimg model <install|list>`.

### `model.install(key, opts?) → InstalledModel` / CLI `model install [name]`

**Purpose:** Download one model (or, with no name / `installAll`, all of them) into the cache.

- SDK: `model.install(key, opts?)` installs one and returns `InstalledModel` `{ key, name, path, forced }`; `model.installAll(opts?)` installs all and returns `ModelInstallResult` `{ installed: InstalledModel[] }`.
- CLI `model install [name]`: with a name, installs that one; with no name, installs all. Either way it prints `{ installed: [...] }`.
- `opts`/flags: `force` (`--force`) re-downloads over a cached file; `recipe` (`--recipe`) supplies the `network.modelDownload` budget; `log` (`--log`).

`key`/`name` must be a known model key (`birefnet`, `swin2sr`); an unknown key is `args.invalid` (usage). `forced` is `true` only when `--force` re-downloaded over an existing cache entry.

**Failure modes:** `args.invalid` (unknown model); `model.downloadFailed`, `model.checksumMismatch`; `AbortError`.

### `model.list() → ModelListResult` / CLI `model list`

**Purpose:** List every known model and whether it is cached. Synchronous, no network.

**Result (`ModelListResult`):** `{ models: ModelListEntry[] }`, each `{ key, name, path, cached: boolean, sizeBytes?: number }` (`sizeBytes` present only when cached).

---

## Profile management

The profile (`profile.json`) holds connection settings and the (obfuscated) API key. These helpers live under `GptImg.profile`; the CLI exposes the key-mutating ones as `gptimg profile <set-key|clear-key>`. The read/resolve helpers are SDK-only.

**Profile shape (`Profile`):** `{ provider: string (required, non-empty), apiKey?: string, apiKeyEnv?: string, organization?: string, project?: string }`. The schema is strict — unknown fields are rejected.

**API-key resolution (`profile.resolve`, internal to every provider call):** in priority order — (1) if `apiKeyEnv` is set and that environment variable is non-empty, use it (`apiKeySource: "env:<NAME>"`); (2) else if `apiKey` is present, de-obfuscate and use it (`apiKeySource: "profile.apiKey"`); (3) else throw `apiKey.missing`. `resolveProfile` returns `{ redacted (profile minus secret fields), apiKey, apiKeySource }` — only `redacted` is safe to log.

### `profile.setApiKey(rawKey, opts?)` / CLI `profile set-key`

Stores the key obfuscated, preserving other fields; if the file is absent it is created as `{ provider: "openai" }`. The file is written with owner-only permissions (POSIX mode `0600`). The key must be non-empty (validated in the SDK; an empty `--key` or empty stdin is rejected). `opts.path` (CLI `--path`) overrides the profile path. CLI sources the key from `--key <value>` or `--stdin`. The CLI prints `{ ok: true }`.

### `profile.clearApiKey(opts?)` / CLI `profile clear-key`

Removes the `apiKey` field (preserving `apiKeyEnv` and the rest); a no-op if the file or field is absent. CLI prints `{ ok: true }`.

**Profile failure modes:** `profile.notFound` (file missing — usage), `profile.readFailed` (open succeeded but read/stat failed — runtime), `profile.invalidJson` (not parseable / not an object — usage), `profile.validationFailed` (fails the schema — usage), `profile.insecureMode` (on POSIX, an `apiKey`-bearing file readable beyond the owner — usage), `profile.writeFailed` (runtime), `apiKey.missing` (usage).

---

## Recipes and the `--set` override

A recipe (`recipe.json`) configures the provider-backed verbs and network budgets. Loading: a verb's `recipe` arg names an explicit file (missing → `recipe.notFound`); with no arg, the default `<profileDir>/recipe.json` is loaded if present, else an empty recipe `{}` is used (no error).

**Sections (each validated, unknown keys passed through):**

- `generate`, `edit`: `{ model?, size?, quality?, n? (int > 0), ...passthrough }`.
- `vision`: `{ model?, shrink?:{width,height} (ints > 0), detail?: low|high|original|auto, systemPrompt?, ...passthrough }`.
- `chroma`: `{ color?:#rrggbb, preserveInterior?:bool, borderSample?:int>0, saturationRatio?:number in (0,1], ...passthrough }`.
- `network`: per-category budgets (`imageGenerate`, `imageVision`, `imageDownload`, `modelDownload`), each `{ timeout, maxRetries, retryIntervals }` overriding the defaults above.

**`--set` / `args.set`:** a repeatable `dot.path=value` expression that overrides recipe values for one call. The value is JSON-parsed when it parses (numbers, booleans, null, arrays, objects), else taken as a raw string; an `@<file>` value reads the file (JSON-parsed if valid, else raw). A path beginning with a section name (`generate`/`edit`/`vision`/`chroma`/`network`) is rooted at the recipe; otherwise it is scoped under the current verb's section (so `size=...` on `generate` sets `recipe.generate.size`). A malformed expression (no `=`, empty key, unreadable `@file`) throws `set.invalidExpression` (usage).

**Recipe failure modes:** `recipe.notFound` (usage), `recipe.readFailed` (runtime), `recipe.invalidJson` (usage), `recipe.validationFailed` (usage), `set.invalidExpression` (usage).

---

## Error codes

Every code string the SDK can attach to a thrown error, grouped by `errorType`. Codes in the usage set (exit `2`) are marked **(usage)**; all others map to their domain exit code (profile/recipe → 3, provider → 4, localOp → 5) or 130 for abort.

**ProfileError (exit 3 / usage):** `profile.notFound` (usage), `profile.readFailed`, `profile.invalidJson` (usage), `profile.validationFailed` (usage), `profile.insecureMode` (usage), `profile.writeFailed`, `apiKey.missing` (usage), `apiKey.invalidObf`.

**RecipeError (exit 3 / usage):** `recipe.notFound` (usage), `recipe.readFailed`, `recipe.invalidJson` (usage), `recipe.validationFailed` (usage), `set.invalidExpression` (usage).

**ProviderError (exit 4 / usage):** `provider.unknown` (usage), `provider.requestFailed`, `provider.invalidResponse`.

**LocalOpError (exit 5 / usage)** — argument and input validation, image ops, model fetch/inference, output and sidecar I/O:
- Arguments: `args.invalid` (usage), `vision.detailUnsupported` (usage).
- Image: `image.noContent` (usage), `image.sizeMismatch` (usage), `image.readFailed`, `image.decodeFailed`, `image.writeFailed`, `image.formatUnknown`.
- Model: `model.downloadFailed`, `model.checksumMismatch`, `model.loadFailed`, `model.outputShape`.
- Output: `output.exists` (usage), `output.staleSiblings` (usage), `output.mixedExtensions` (usage), `output.duplicate`, `output.writeFailed`, `output.mkdirFailed`, `output.scanFailed`.
- Sidecar: `sidecar.writeFailed`, `sidecar.malformed`.

**AbortError (exit 130):** `cancelled`.

A non-`GptImgError` (an unexpected throwable) renders with `type: "unknown"`, `code: "unknown"` and exits `1`.

---

## Notes for integrators

- **One JSON object on stdout, always.** Parse stdout as a single JSON value on exit 0. On any nonzero exit, stdout is empty and the diagnostic is on stderr (a plain `error:` line for usage errors, a `{ "error": { type, code, message } }` object otherwise).
- **Branch on exit code first, then `code`.** Exit code gives the coarse category (2 usage, 3 profile/recipe, 4 provider, 5 local op, 130 cancelled, 1 unknown); the `code` string gives the specific reason.
- **Sidecars are the audit trail.** Every generated/edited image and every vision check writes a `<stem>.json` next to it recording the exact request and the (secret-redacted, base64-nulled) response. They also key chroma masking: `generate` records `chroma.color`, and `mask --key from-sidecar` reads it back.
- **Warm shared state before fanning out.** Run `profile set-key` once and `model install` once; thereafter parallel invocations are read-mostly and safe.
