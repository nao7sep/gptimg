# Changelog

All notable changes to GptImgSdk (`gptimgsdk`) are documented in this file. It records every change to a persisted format, an error or result code, or a public signature.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The SDK was redesigned under the fleet's SDK conventions. Every change under Changed and Removed is breaking for code written against 0.1.0.

### Changed

- The SDK is the package `gptimgsdk` in `sdk/` of the GptImg repository, laid out as the repository root it would become and imported by that name; the repository root is the GptImg app package.
- The source runs on plain Node 24.12 or later with type stripping: no `tsx` or other loader is needed.
- Configuration comes only from the caller. `new GptImg()` takes `profile` (from `loadProfile`), `apiKey`, `organization`, `project`, `modelsDir`, `logDir`, `policy` and `app`, and touches no disk. The SDK reads no environment variable and no working directory, and has no home folder for consumer data.
- Profiles are format 2, a superset of format 1, adding `modelsDir`, `logDir` and `policy`. `loadProfile(path, { env })` reads one from a path the caller gives and resolves `apiKeyEnv` from the environment map the caller passes, never from the process environment; `validateProfile` checks a profile body. Format 1 and unmarked v0.1.0 profiles read unchanged. The SDK never writes a profile.
- Every path argument must be absolute; a relative one is `args.invalid` naming the bare field. An output name is a bare name or an absolute stem that also chooses the folder, for `generate`, `edit` and `vision` as for the local verbs; `generate` takes either `outDir` or an absolute `outName`.
- An argument a verb does not take is refused as `args.invalid` naming it, rather than ignored; a retired one says where its value now goes. A policy is checked whole where it is given (constructor, call, profile), so an unknown section or field is `policy.invalid` naming its section.
- A missing or unreadable input is the filesystem's `fs.*` code in every verb; only an image that cannot be decoded is `image.undecodable`.
- Models default to `~/.gptimgsdk/models`, overridable per call, per instance and in a profile, and are installed only on request: AI masking and upscaling without the model fail `model.notInstalled`. `model.install` returns `{ installed, logPath }` like `installAll`. A superseded pin's file is deleted during installation.
- No log is written unless a call's `log` option (`{ file }` or `{ dir }`) or the instance's or profile's `logDir` asks for one; `log.debug` writes debug lines to the file.
- One error type, `GptImgError`, with `code`, `kind` (`invalid`, `unavailable`, `cancelled`, `internal`), `effect` (`none`, `unknown`), `subject`, `details` and `cause`, replaces `ProfileError`, `RecipeError`, `ProviderError`, `LocalOpError` and `AbortError`. Codes name the observed cause and are declared in the exported `ERROR_CODES`; `toJSON()` and `isGptImgErrorData` carry errors across processes. Filesystem failures are `fs.*` codes, provider failures `provider.timeout`, `provider.connectionLost`, `provider.serverError`, `provider.rateLimited`, `provider.quotaExhausted`, `provider.rejected` and `provider.unreachable`, and anything unclassified is `internal.unexpected`. An exhausted quota is never retried.
- Every verb returns `{ status: "completed", … }` or `{ status: "refused", refusal }`. Refusals (`REFUSAL_CODES`) cover an existing destination, case and Unicode spelling conflicts, stale numbered siblings, a busy output group, a sidecar that does not describe its image, and the provider's moderation block, refusal and content filter, whose documented reason is in `refusal.safeReason`.
- `generate` and `edit` report each image and its sidecar separately: `files[]` entries carry `sidecar` (published or failed, with code and effect) and the `record`, a published image is kept when its sidecar fails, `failures[]` replaces `partial` and includes every requested image the provider did not return, `leftovers` lists earlier-run files an overwrite could not remove, and `response` holds the provider's response with its token usage on every completed call, also when no image was published. `vision` carries `sidecar` and `record` too, and a refusal that arrived in a paid answer carries that answer as `response`.
- Sidecars are format 2: each names its `kind` and its `writer` (`gptimgsdk`, its version, and the calling app when the caller passes `app`), with typed records `GenerateSidecar`, `EditSidecar` and `VisionSidecar`. Format 1 and unmarked v0.1.0 sidecars read unchanged; `readSidecar` reads every supported format.
- `onProgress` now receives counts of countable work (`{ verb, stage, done, total, unit, subject? }`, `subject` naming the model while models install or verify, the check after a download included), and the former event stream is `onEvent`, which also receives error and debug events.
- `logPath` is `null` when nothing was logged.
- `icon` publishes its set together, removing the files it created when publication fails or is cancelled.
- `grid`'s `skipped` entries (`GridSkip`) carry the error code and effect naming why each input could not be read; when none can be read, the first input's own error is thrown. Verdicts and findings are exported constant lists.
- `policy` replaces per-call `overrides`, with precedence call, instance, profile, built-in default; ONNX tuning is `policy.onnx`.

### Added

- `verify({ in })` checks a published paid image against its sidecar and returns coded findings.
- The `encode` verb, the pipeline's delivery step, and the encoder options (`format`, `quality`, `lossless`, `smartSubsample`, `opaque`, `compressionLevel`, `adaptiveFiltering`) on every verb that writes an image; `opaque` refuses a translucent image as `image.notOpaque`.
- The `gptimgsdk/types` entry: the types and the dependency-free code tables, loadable without sharp, ONNX Runtime or the OpenAI client.
- `SUPPORTED_MODELS`, `MODEL_LINEUP`, `modelsFor` and `defaultModelFor` (the supported-model table with each model's sizes, qualities, formats and efforts), `validatePolicy`, and `SUPPORTED_IMAGE_EXTENSIONS`.
- `model.list` entries carry `downloadBytes`, for a free-space check before installing.

### Removed

- `recipe.json` and the `recipe` argument; `GPTIMG_DATA_DIR`, `GPTIMG_MODELS_DIR`, `GPTIMG_DEBUG`, `GPTIMG_ONNX_INTRA_OP_THREADS` and `GPTIMG_ONNX_EP`; the `profileDir` option and the default `~/.gptimg` folder.
- `profile.setApiKey`, `profile.clearApiKey`, `recipe.load`, `recipe.merge`, `sidecar.write`, the `log` helpers and the `image` helpers on the instance, and `mask`'s `dryRun`.
- The ambient `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_ADMIN_KEY` reads the OpenAI client would otherwise make.

### Fixed

- Chroma masking makes a pixel equal to a lighter or darker key (such as `#80ff80`) fully transparent; such a key used to leave its own backdrop faintly opaque. Pure keys such as `#00ff00` mask as before.
- A recorded provider response keeps a field named `__proto__` as a field.
- An image download's connection failure or timeout, as the OpenAI client reports it without a socket code, is retried; its generic error name had hidden it from the retry rule. Paid requests are still resent only when provably unprocessed.

## [0.1.0] - 2026-07-08

### Added

- First public release, as the package `gptimg`.
