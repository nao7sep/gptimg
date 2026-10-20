# GptImgSdk

Generate, edit and judge images with OpenAI, then mask, compose, trim, upscale and pack them locally, with a JSON record beside every paid image.

GptImgSdk (package `gptimgsdk`) is the TypeScript library the [GptImg](../README.md) app is built on. Scripts and tools use it for image work whose results are kept: every paid image gets a sidecar with the request, OpenAI's full response and its token usage, and every derived image keeps its source's metadata.

It is consumed from its TypeScript source on **Node.js 24.12 or later**, with no build step, and is not published to a registry. OpenAI calls are billed to the API key you pass; the local verbs need no key.

## Getting started

Depend on it by path and import it by name:

```json
{ "dependencies": { "gptimgsdk": "file:../gptimg/sdk" } }
```

```ts
import { GptImg, completed } from "gptimgsdk";

const img = new GptImg({ apiKey: process.env.OPENAI_API_KEY });
const result = completed(
  await img.generate({ prompt: "a single centered pink frosted donut", outDir: "/absolute/output" }),
);
console.log(result.files.map((file) => file.path), result.usage);
```

## How it behaves

- **Nothing ambient.** The SDK reads no environment variable, configuration file or working directory: everything comes from the constructor and each call, and every path is absolute.
- **One shape for every verb.** A verb takes its arguments and the same call options (`signal`, `onEvent`, `onProgress`, `onPartialImage`); a verb with nothing to report through a hook never calls it. An argument, option or policy field the SDK does not know is refused, never ignored or sent on.
- **Results and refusals.** A verb returns `{ status: "completed", … }` or `{ status: "refused", refusal }` with a stable code. `completed()` turns a refusal into a thrown error for scripts that do not handle one. Paid results and paid refusals carry `usage` and the provider's `responseId`.
- **One error type.** A failure is a `GptImgError` with a stable `code`, a `kind` (`invalid`, `unavailable`, `cancelled`, `internal`) and an `effect` (`none`, or `unknown` when a write or a paid request may have taken effect). It serializes with `toJSON()`, and `isGptImgErrorData` recognizes that shape when it arrives from another process.
- **No log.** Pass `onEvent` to receive each event of a call as a complete record, credentials masked, and store it with your own records.
- **Outputs.** A single-file verb writes into `outDir` under `outName`, or at the exact file `out` names. Nothing is replaced unless the call sets `overwrite`, and every file appears whole or not at all.
- **Metadata.** An image derived from an input keeps all of that input's metadata (EXIF, colour profile, XMP, IPTC) unchanged, with its pixels in the input's orientation and colour profile; only an embedded EXIF preview is dropped. How an image was made goes in its sidecar and the result.
- **sharp's cache.** Loading the SDK sets `sharp.cache({ files: 0 })` for the whole process, so libvips keeps no input file open (an open file stays locked on Windows). The memory cache is kept. An app that uses sharp itself shares that setting.

`chat` is one turn of a conversation, for an app that holds conversations, as the GptImg app does: the caller keeps the conversation and passes it with each turn, and the SDK sends that turn and publishes its images with their records. A script that makes or changes images uses `generate` and `edit`.

## Entries

- `gptimgsdk`: the `GptImg` class, the error type and the code tables.
- `gptimgsdk/types`: the types and the dependency-free tables and checks, for code that cannot load sharp or ONNX Runtime, such as a browser window.
- `gptimgsdk/testing`: `startOpenAIDouble()`, a local stand-in for OpenAI that a consumer's tests reach through the `baseURL` option.

The public types, the exported code tables, the tests and [`CHANGELOG.md`](CHANGELOG.md) are the API reference.

## Local models

AI matting (`mask` with `method: "ai"`) and `upscale` run local models that are installed only on request (`img.model.install`), into `~/.gptimgsdk/models` unless a call or the constructor names another folder. They run offline once installed, but need memory: an AI mask peaks at about 11 GB, an upscale at about 3 GB with its default tile. Each is downloaded from a pinned revision whose size and SHA-256 digest are checked:

- [BiRefNet ONNX](https://huggingface.co/onnx-community/BiRefNet-ONNX), MIT, for AI matting (about 0.5 GB).
- [Swin2SR real-world ×4 ONNX](https://huggingface.co/onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX), Apache-2.0, for upscaling (about 53 MB).

## Development

From the repository root, `npm test` type-checks and tests the SDK with the app. In `sdk/`, `npm test` runs the SDK's own suite, and `npm run test:live` its paid lane: a few OpenAI calls (export `OPENAI_API_KEY` first) and both model downloads into `sdk/node_modules/.cache` (about 540 MB, once per pinned revision), and a photo read from the company test-fixture corpus, which must be checked out beside this repository.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
