# gptimg

gptimg is a TypeScript **SDK + CLI** for AI image generation paired with a local image-processing pipeline. It generates and edits images through OpenAI and verifies them with a vision model, then does the on-device work around them: masking, compositing, mask algebra, cropping, gradient backplates, layering, drop shadows, super-resolution upscaling, resizing, and macOS/Windows icon packing. It's built for human CLI use and — especially — for **AI agents and scripts** that need durable, inspectable artifacts: every run writes timestamped images, JSON sidecars, and JSONL logs, prints one JSON object on stdout, and signals its outcome by exit code. It is SDK-first; the CLI is a thin bridge over the same methods.

Each verb does one observable operation; composing them into finished assets — margins, glyph sizing, directory layout, output names — is deliberately the caller's job, not gptimg's. A personal tool: v1 ships **OpenAI only** (the provider boundary exists, but no second provider is shipped).

## Requirements

- Node.js and npm — gptimg is consumed from source: build it, then use the SDK or the `bin/gptimg.js` CLI.
- An **OpenAI API key** for the provider-backed verbs (`generate`, `edit`, `vision`), billed to your key. The local image ops need no key and no network.
- For `mask --method ai` and `upscale`: a one-time **ONNX model download** (BiRefNet ~0.5 GB, Swin2SR ~4.4 GB) and the RAM to run them (~1–1.5 GB / ~4.4 GB peak) — run these one at a time.
- Cross-platform (Node). Icon packing emits macOS `.icns` and Windows `.ico`.

## Getting started

```sh
git clone <this repo> gptimg
cd gptimg
npm install
npm run build
```

The build emits `dist/`; the CLI entry is `bin/gptimg.js` (add `bin/` to `PATH`, or invoke `node bin/gptimg.js`). Store your API key once:

```sh
gptimg profile set-key --key sk-...
```

Then generate an image and verify it:

```sh
gptimg generate "a single centered pink frosted donut" --out-dir ./out --out-name donut
gptimg vision --in ./out/donut.png --check "one donut, centered and fully visible"
```

The SDK mirrors the CLI:

```ts
import { GptImg } from "gptimg";
const gen = await new GptImg().generate({ prompt: "a red mug" });
```

## Documentation

The full contract — every verb's arguments, result envelopes, on-disk artifacts, error and exit codes, cancellation, profiles and recipes, and the operational caveats (running AI models one at a time, why `vision` can't judge a transparent cutout) — is in **[docs/reference.md](docs/reference.md)**.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
