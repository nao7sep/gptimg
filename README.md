# GptImg

GptImg is a TypeScript **SDK** for AI image generation paired with a local image-processing pipeline. It generates and edits images through OpenAI and verifies them with a vision model, then does the on-device work around them: masking, compositing, mask algebra, cropping, gradient backplates, layering, drop shadows, super-resolution upscaling, resizing, macOS/Windows icon packing, deterministic keying-quality and frame-geometry checks, and comparison-sheet tiling. It's built for **AI agents and scripts** that need durable, inspectable artifacts: the AI verbs (`generate`, `edit`, `vision`) write JSON sidecars — `generate` and `edit` also write timestamped images — every run writes a JSONL log, and each verb returns a typed result object naming what it produced. Every capability is a method on one `GptImg` class — there is no CLI; the library is the whole product.

Each verb does one observable operation; composing them into finished assets — margins, glyph sizing, directory layout, output names — is deliberately the caller's job, not GptImg's. A personal tool: v1 ships **OpenAI only** (the provider boundary exists, but no second provider is shipped).

## Requirements

- Node.js **22.12+** and npm. GptImg is consumed directly from its TypeScript source — there is no build step; run your scripts with [`tsx`](https://tsx.is) (`npx tsx your-script.ts`).
- An **OpenAI API key** for the provider-backed verbs (`generate`, `edit`, `vision`), billed to your key. The local image ops need no key; AI matting and upscaling need the one-time model downloads described below, then run offline.
- For AI matting (`mask({ method: "ai" })`) and `upscale`: a one-time **ONNX model download** (BiRefNet ~0.5 GB, Swin2SR ~53 MB) and the RAM to run them (~1–1.5 GB / ~4.4 GB peak) — run these one at a time. Models are accepted third-party ONNX re-exports from the `onnx-community` organization on Hugging Face (the model authors do not publish ONNX builds), fetched on first use or explicitly via the `model` API, commit-pinned and SHA-256-verified, and cached under `~/.gptimg`. The model API can also re-verify cached files on demand.
- Cross-platform (Node). Icon packing emits macOS `.icns` and Windows `.ico`.

## Getting started

```sh
git clone https://github.com/nao7sep/gptimg.git
cd gptimg
npm install
```

No build step — `import "gptimg"` resolves to the TypeScript source, so editing `src/` takes effect on the next run with nothing to keep in sync. Store your API key once, then generate an image and verify it:

```ts
import { GptImg } from "gptimg";

const img = new GptImg();
await img.profile.setApiKey("sk-..."); // one-time, into the default profile

const gen = await img.generate({ prompt: "a single centered pink frosted donut", outName: "donut" });
const verdict = await img.vision({ in: gen.files[0].path, check: "one donut, centered and fully visible" });
```

Run it with `npx tsx your-script.ts`.

Every long-running verb accepts the same optional call controls. Pass an `AbortSignal` to cancel at the next safe boundary and `onProgress` to receive the structured stage events that also feed the JSONL log:

```ts
const controller = new AbortController();

const result = await img.upscale(
  { in: "cutout.png", toSize: 2048 },
  {
    signal: controller.signal,
    onProgress: event => console.log(event.stage, event.message),
  },
);
```

The package entry point exports the argument, result, error, model, progress, profile, image-helper, and logger types used by its public surface. Source, those types, focused examples, and tests are the API reference; there is no parallel hand-maintained API inventory.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — yoshinao@inoguchi.com — <https://inoguchi.com>
