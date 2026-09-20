# GptImg's areas, and the tests that stand for them

`npm test` is the type check plus this whole suite, minus `live/`: at a few seconds it is already a
fixed, balanced run, so nothing selects a subset of it. `npm run test:full` adds `live/`, which
drives the public `GptImg` class with nothing substituted — the pinned BiRefNet and Swin2SR models,
fetched through the SDK's own installer into a cache that persists between runs, and the real OpenAI
API for `generate`, `edit`, and `vision`. `vitest.live.config.ts` runs those files one at a time,
with minute-scale timeouts, because they spend money, wait on the network, and share that cache.

This file is the balance judgement the `tests-folder-conventions` require — which areas GptImg has,
and which tests stand for each — so a reader can tell what a green run covered, and an area with no
test standing for it is visible rather than merely absent. `tests/area-map.test.ts` holds every path
below to what is on disk.

Paths are relative to this folder.

| Area | What it covers | Tests standing for it |
|---|---|---|
| The SDK surface | The one `GptImg` class a caller sees: every verb is a method, each returns the typed result it declares, and every verb validates its arguments against one schema before doing work — including the message a rejected argument produces. | `sdk/surface.test.ts`, `verbs/schemas.test.ts`, `internal/zodError.test.ts` |
| The AI verbs | `generate`, `edit`, and `vision` against a mocked provider: what lands on disk, how output is planned from the detected format, and the prompt and check normalization the calls go through. | `verbs/ai-success.test.ts`, `verbs/generate-plan.test.ts`, `internal/textCleanup.test.ts` |
| The OpenAI provider | The only shipped provider, and the boundary the AI verbs call across: client construction, model resolution, and real requests and responses over a local HTTP server. | `providers/openai-client.test.ts`, `providers/openai-provider.test.ts` |
| The network budget and cancellation | Per-call network resolution, the retry and budget policy around a request, the combined-signal and status-error plumbing, and an `AbortSignal` threaded from a verb call through to a typed `AbortError`. | `network/resolve.test.ts`, `network/for-call-fetch.test.ts`, `network/retry.test.ts`, `network/http.test.ts`, `verbs/abort.test.ts` |
| The local verbs through the SDK | The on-device verbs driven the way a caller drives them, rather than through their implementations: each one runs end to end and produces its files, and each refuses to clobber an existing output. | `verbs/local-success.test.ts`, `verbs/overwrite.test.ts` |
| Output naming and reservation | What every verb shares before and after its own work: stem inference, index widths and file names, the output-group reservation that keeps two runs — in one process or two — off the same names, and the staged-then-published atomic write. | `internal/local-verb.test.ts`, `internal/output-group.test.ts`, `internal/output-group-initialization.test.ts`, `internal/output-group-process.test.ts`, `internal/output-naming.test.ts`, `internal/atomic-file.test.ts` |
| Keying and matting | Chroma masking: the key analysis and spill formula in linear light, interior preservation, the fixture images it runs on, and the recipe defaults a `mask` call inherits. | `local/mask.test.ts`, `local/chroma/spill.test.ts`, `verbs/mask-defaults.test.ts` |
| Mask algebra and alpha cleanup | Combining masks, dropping speckles with a floor plus a connected-component filter, and cropping to the alpha bounding box — the alpha-channel arithmetic the compositing verbs depend on. | `local/combine.test.ts`, `local/despeckle.test.ts`, `local/trim.test.ts` |
| Compositing, layering, and backplates | Putting images together: flattening over a colour with bleed removal, stacking layers at offsets, the drop shadow, and the generated gradient backplate. | `local/compose.test.ts`, `local/layer.test.ts`, `local/shadow.test.ts`, `local/backplate.test.ts` |
| Resizing, upscaling, and icon packing | Changing an image's size: resampling to a target, the tile-plan-and-stitch upscaler (driven by a deterministic stand-in for ONNX), and packing a source image into macOS `.icns` and Windows `.ico` sets. | `local/resize.test.ts`, `local/upscale.test.ts`, `local/icon.test.ts` |
| The inspection verbs | The verbs that judge rather than produce: keying quality in HSV, frame geometry from alpha coverage, and the comparison sheet that tiles candidates for a human to look at. | `local/keycheck.test.ts`, `local/framecheck.test.ts`, `local/grid.test.ts` |
| The ONNX model layer | The managed models the AI matting and upscaling paths run on: commit-pinned fetch with size and digest verification into the cache, the `model` API that installs and re-verifies, session loading, the tensor packing each model expects, and that the native runtime this platform installed actually loads. | `local/model-fetch.test.ts`, `verbs/model.test.ts`, `local/models/session.test.ts`, `local/models/birefnet-tensor.test.ts`, `local/models/swin2sr-tensor.test.ts`, `local/models/onnxruntime-native.test.ts` |
| Pixel plumbing and colour | The small shared helpers every image path runs through: format detection and the vision shrink, aspect fitting, single-channel resizing, content hashing, and hex colour parsing. | `image/format-shrink.test.ts`, `image/aspect.test.ts`, `image/bridge.test.ts`, `image/hash.test.ts`, `color.test.ts` |
| Settings on disk | What GptImg resolves before a call: the profile it loads and writes, the API key it stores obfuscated and redacts when logging, the recipe defaults it merges under a call's own arguments, and the home, models, and output directories those files resolve to. | `profile/load-set-key.test.ts`, `profile/resolve.test.ts`, `profile/obfuscate.test.ts`, `profile/redact.test.ts`, `recipe/load.test.ts`, `recipe/merge.test.ts`, `internal/paths-output.test.ts` |
| Sidecars and the JSONL log | The durable record a run leaves: the JSON sidecar written beside each artifact and read back, the base64 payloads nulled out of it, and the JSONL log — its envelope, its debug gating, and its fallback when the file cannot be written. | `sidecar/io.test.ts`, `sidecar/nullBase64.test.ts`, `log/index.test.ts` |
| The release surface and this map | The repository's own contracts: that `VERSION` is derived from `package.json` and exported from the entry point, that a release tag matches that version, and that the map above still names areas and tests that exist. | `version.test.ts`, `release-tag.test.ts`, `area-map.test.ts` |
