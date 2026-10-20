# Changelog

All notable changes to GptImgSdk (`gptimgsdk`) are documented in this file. It records every change to a persisted format, an error or result code, or a public signature.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The SDK was redesigned under the fleet's SDK conventions. Every change under Changed and Removed is breaking for code written against 0.1.0.

### Changed

- The SDK is the package `gptimgsdk` in `sdk/` of the GptImg repository, laid out as the repository root it would become and imported by that name; the repository root is the GptImg app package.
- The source runs on plain Node 24.12 or later with type stripping: no `tsx` or other loader is needed.
- Configuration comes only from the caller. `new GptImg()` takes `apiKey`, `organization`, `project`, `baseURL`, `modelsDir`, `debug`, `policy` and `app`, refuses any other option, and touches no disk. The SDK reads no environment variable and no working directory, and has no home folder for consumer data.
- Every path argument must be absolute; a relative one is `args.invalid` naming the bare field. An output name is a bare name or an absolute stem that also chooses the folder, for `generate`, `edit` and `vision` as for the local verbs; `generate` takes either `outDir` or an absolute `outName`.
- An argument a verb does not take is refused as `args.invalid` naming it, rather than ignored; a retired one says where its value now goes. A policy is checked whole where it is given (constructor, call), so an unknown section or field is `policy.invalid` naming its section.
- A missing or unreadable input is the filesystem's `fs.*` code in every verb; only an image that cannot be decoded is `image.undecodable`.
- Models default to `~/.gptimgsdk/models`, overridable per call and per instance, and are installed only on request: AI masking and upscaling without the model fail `model.notInstalled`. `model.install` returns `{ installed }` like `installAll`. A superseded pin's file is deleted during installation.
- The SDK writes no log. Its record of a call is its events: every event reaches the call's `onEvent` as a complete record (`time`, `level`, `stage`, `verb`, a stable `event` name, typed fields and a short English `message` fixed by the name), with credentials masked, for the caller to store with its own records. One `sdk.start` event per instance, on the first call that listens, carries the SDK's version and runtime configuration. Debug events reach `onEvent` only with the instance option `debug: true`.
- One error type, `GptImgError`, with `code`, `kind` (`invalid`, `unavailable`, `cancelled`, `internal`), `effect` (`none`, `unknown`), `subject`, `details` and `cause`, replaces `ProfileError`, `RecipeError`, `ProviderError`, `LocalOpError` and `AbortError`. Codes name the observed cause and are declared in the exported `ERROR_CODES`; `toJSON()` and `isGptImgErrorData` carry errors across processes. Filesystem failures are `fs.*` codes, provider failures `provider.timeout`, `provider.connectionLost`, `provider.serverError`, `provider.rateLimited`, `provider.quotaExhausted`, `provider.rejected` and `provider.unreachable`, and anything unclassified is `internal.unexpected`. An exhausted quota is never retried.
- Every verb returns `{ status: "completed", … }` or `{ status: "refused", refusal }`. Refusals (`REFUSAL_CODES`) cover an existing destination, case and Unicode spelling conflicts, stale numbered siblings, a busy output group, a sidecar that does not describe its image, and the provider's moderation block, refusal and content filter, whose documented reason is in `refusal.safeReason`.
- `generate` and `edit` report each image and its sidecar separately: `files[]` entries carry `sidecar` (published or failed, with code and effect) and the `record`, a published image is kept when its sidecar fails, `failures[]` replaces `partial` and includes every requested image the provider did not return, `leftovers` lists earlier-run files an overwrite could not remove, and `response` holds the provider's response with its token usage on every completed call, also when no image was published. `vision` carries `sidecar` and `record` too, and a refusal that arrived in a paid answer carries that answer as `response`.
- Sidecars are format 2: each names its `kind` and its `writer` (`gptimgsdk`, its version, and the calling app when the caller passes `app`), with typed records `GenerateSidecar`, `EditSidecar` and `VisionSidecar`. Format 1 and unmarked v0.1.0 sidecars read unchanged; `readSidecar` reads every supported format.
- `onProgress` receives counts of countable work (`{ verb, stage, done, total, unit, subject? }`, `subject` naming the model while models install or verify, the check after a download included), and the former event stream is `onEvent`.
- `icon` publishes its set together, removing the files it created when publication fails or is cancelled.
- `grid`'s `skipped` entries (`GridSkip`) carry the error code and effect naming why each input could not be read; when none can be read, the first input's own error is thrown. Verdicts and findings are exported constant lists.
- `policy` replaces per-call `overrides`, with precedence call, instance, built-in default; ONNX tuning is `policy.onnx`.
- ONNX Runtime loads on the first local-model inference instead of with the SDK, so a consumer that runs no local model need not install or ship `onnxruntime-node`; when it cannot be loaded, the call fails `model.loadFailed`.
- Masking also covers a provider's partial echo of a credential, such as OpenAI's `sk-proj-****…abcd` in a rejected-key message.
- The `gptimgsdk/types` entry type-checks with browser libraries and no Node types.
- `model.install`, `model.installAll`, `model.list` and `model.verify` take `(args, opts)` like every verb: `model.install({ key, force, modelsDir, policy }, opts)`, `model.installAll({ … }, opts)`, `model.verify({ modelsDir }, opts)`, and `model.list({ modelsDir }, opts)`, which is now async. A call option passed among the arguments is refused with a hint.
- `icon` takes `outName` (a bare stem or an absolute one) instead of `name`, and its result reports `sourceWidth` and `sourceHeight` instead of `width` and `height`, as `resize` and `upscale` do.
- `vision` takes `inputs`, an array of one or more images, instead of `in`. The old names are refused with the new one.
- A `gptimgsdk/testing` entry: `startOpenAIDouble()` runs a local stand-in for OpenAI that the SDK reaches through `baseURL`, with scripted answers (success with chosen usage, a refusal, the content filter, moderation, an expired conversation, a missing picture, any HTTP error, a call that never answers), so a consumer's tests meet them without paying.
- `model.release()` frees the loaded local models' memory once inference in flight has finished; the next call that needs a model loads it again.
- A paid verb checks its arguments, policy and the chosen model's values before it asks for the key, so a wrong value is reported as such without one.
- On Windows, an image the SDK wrote and read back (`encode` checks what it wrote) no longer stays locked while the process runs: libvips keeps no files open in its cache.
- `model.list` with a `modelsDir` that is a file fails with the filesystem's code on every platform; on Windows it had reported nothing installed.
- The constructor takes `baseURL`, the OpenAI API's base URL, for a proxy or another endpoint that speaks OpenAI's API; without it, OpenAI's own.
- Every verb that writes an image can write JPEG (`format: "jpeg"`, `.jpg`, with `quality`), and can fill transparency with a caller-chosen `background` colour. A JPEG of an image with translucent pixels and no `background` is refused as `image.notOpaque`; `background` with `opaque` is `args.invalid`.

### Added

- `verify({ in })` checks a published paid image against its sidecar and returns coded findings.
- `chat(...)`: one turn of a conversation with an assistant that answers in words and generates or edits images, through OpenAI's Responses API and its image tool. The caller passes the earlier turns and the previous turn's `responseId`; while OpenAI holds that response only the new turn is sent, and when it is gone the history is resent. Each image is written with a sidecar of the new kind `chat`; a turn without images keeps its record as `<stem>.json`. `policy.chat` sets the assistant, its effort, instructions and the image tool's model and values; the routing table gains the `chat` kind and role.
- `chat` takes `mask`, a PNG the size of the first attached image whose transparent pixels mark where that image may change, sent as the image tool's `input_image_mask`. It is checked before the call: an image to apply to, a PNG, the same size, with transparency (`args.invalid` naming `mask`). The chat record names the mask and its SHA-256. The mask goes to the image tool in OpenAI's documented form (opaque white kept, transparent where it may change), and the assistant, which writes the image request, is shown it too: opaque at low detail, after a sentence giving the area's bounds.
- `policy.chat.partial_images` (0 to 3) asks for drafts of each image while it is drawn: the turn is streamed and each draft reaches the new chat-only call option `onPartialImage` as a `PartialImage` (`image`, `index`, `data`, `format`). Drafts are not saved. A stream that goes silent for the attempt's timeout is `provider.timeout`, and one that ends before its final response a dropped connection, both with effect `unknown` and never resent.
- An image the image tool's call failed because OpenAI's moderation blocked it is a `provider.moderationBlocked` item failure in the turn's `failures`, with the categories and stage OpenAI gave, apart from `provider.noImage` for one that went missing.
- The OpenAI stand-in streams a chat turn when asked, with drafts, and scripts a blocked image (`blockedImages`), a stream that drops after some drafts (`streamDropped`) and one that goes silent (`streamStalled`).
- `inspect({ in })` reports what an image is in one call: its format as the bytes say and whether the extension agrees, size, channels, bit depth, colour space, density, EXIF orientation, pages, whether any pixel is translucent, and the sidecar beside it (kind, writer, recorded chroma key) without checking it against the image.
- The `encode` verb, the pipeline's delivery step, and the encoder options (`format`, `quality`, `lossless`, `smartSubsample`, `opaque`, `compressionLevel`, `adaptiveFiltering`) on every verb that writes an image; `opaque` refuses a translucent image as `image.notOpaque`.
- The `gptimgsdk/types` entry: the types and the dependency-free code tables, loadable without sharp, ONNX Runtime or the OpenAI client.
- `SUPPORTED_MODELS`, `MODEL_LINEUP`, `modelsFor` and `defaultModelFor` (the supported-model table with each model's sizes, qualities, formats and efforts), `validatePolicy`, and `SUPPORTED_IMAGE_EXTENSIONS`.
- `model.list` entries carry `downloadBytes`, for a free-space check before installing.
- `completed(result)`: a verb's completed result narrowed to its type, or a refusal thrown as a `GptImgError` coded `refused` with the refusal in `details.refusal`, for scripts that treat any refusal as a stop.

### Removed

- `recipe.json` and the `recipe` argument; `GPTIMG_DATA_DIR`, `GPTIMG_MODELS_DIR`, `GPTIMG_DEBUG`, `GPTIMG_ONNX_INTRA_OP_THREADS` and `GPTIMG_ONNX_EP`; the `profileDir` option and the default `~/.gptimg` folder.
- Profiles: `profile.json`, the default `~/.gptimg/profile.json`, the `profile` option, `profile.setApiKey` and `profile.clearApiKey`. Pass the key as `apiKey`; a key stored `obf:`-encoded in a 0.1.0 profile is the base64 after `obf:` of the key's bytes reversed.
- File logging: the call option `log`, the instance option `logDir`, the `logPath` on every result, and the log files they wrote. A script that wants a file writes the events `onEvent` receives.
- `recipe.load`, `recipe.merge`, `sidecar.write`, the `log` helpers and the `image` helpers on the instance, and `mask`'s `dryRun`.
- The ambient `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_ADMIN_KEY` reads the OpenAI client would otherwise make.

### Fixed

- Chroma masking makes a pixel equal to a lighter or darker key (such as `#80ff80`) fully transparent; such a key used to leave its own backdrop faintly opaque. Pure keys such as `#00ff00` mask as before.
- A recorded provider response keeps a field named `__proto__` as a field.
- An image download's connection failure or timeout, as the OpenAI client reports it without a socket code, is retried; its generic error name had hidden it from the retry rule. Paid requests are still resent only when provably unprocessed.

## [0.1.0] - 2026-07-08

### Added

- First public release, as the package `gptimg`.
