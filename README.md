# GptImg

Make and edit images by chatting with OpenAI's models, and keep every conversation to pick up again later.

GptImg is a desktop app that works like ChatGPT's image feature: describe a picture, get it back, then ask for changes ("warmer light", "make it a night scene") until it is right. Every chat is saved as a folder of its own, with its messages, images and attached files, so it can be reopened and continued months later.

It runs on your own OpenAI API key and is billed per use, so there is no subscription and no message cap. Each reply shows the tokens it used, the assistant model's and the image model's separately.

The repository also holds **GptImgSdk** (`gptimgsdk`, in [`sdk/`](sdk/)), the TypeScript library the app is built on. Scripts use it for image generation and editing with JSON records beside every paid image, and for local image work: masking, compositing, trimming, shadows, upscaling, icon packing and comparison sheets.

## Requirements

- An **OpenAI API key**, created at [platform.openai.com](https://platform.openai.com). Each message is billed to that account.
- **macOS on Apple silicon** is the primary platform. A Windows build is configured but not yet qualified.
- To build from source: **Node.js 24.12 or later** and npm.

## Getting started

There is no published download yet; build the app from source:

```sh
git clone https://github.com/nao7sep/gptimg.git
cd gptimg
```

On macOS, double-click `scripts/rebuild.command`. It installs dependencies, type-checks, builds `dist/mac-arm64/GptImg.app` and opens it. Later launches can use `scripts/run-built.command`, which opens the existing build without rebuilding it. On Windows, the matching `.ps1` scripts do the same.

The app is unsigned (an ad-hoc seal on macOS). If macOS refuses to open it, right-click the app and choose Open, or run `xattr -dr com.apple.quarantine GptImg.app`.

On first launch GptImg asks for your API key, then for a folder to keep chats in. If `OPENAI_API_KEY` is set in the environment, it is used and the key step can be skipped. Both choices can be changed later in Settings.

## Using the app

- **Send a message** to start a chat. Attach images to work from with the paperclip, by dropping files on the window, or by pasting. Under the message box, choose the image's shape (square, portrait, landscape, an exact size checked against the image model's rules, or let the model decide), its quality and its background (transparent, opaque, or the model's choice). Replies show the assistant's formatting (bold, lists, headings, links).
- **The images pane** on the right lists every image in the chat, the ones you attached and the ones the assistant made. Click one to attach it to your next message; click it again to take it off. The assistant sees an earlier image only when it is attached: without one, a follow-up such as "add a hat" edits the latest image through OpenAI's copy of the conversation, but comparing images or picking an older one needs them attached.
- **Paint where it may change**: the brush on an attached image opens a painter. Paint over the area to change. The mask goes to OpenAI's image tool, and the assistant is shown it too, so it asks for the change in that area. OpenAI treats a mask as guidance, so the rest of the image stays close to how it was rather than identical.
- **Each generated image** can be opened full size (with its size and format, and Copy and Export), copied, exported, or used as an attachment in the next message.
- **Export** saves an image as PNG, JPEG or WebP with the quality you choose, at its own size, at a longest side you type, or enlarged 2× or 4× by an AI upscaling model that runs on your computer. Transparent areas can be kept (PNG, WebP) or filled with a colour. The upscaling model is a one-time download of about 54 MB, made only when you click Download in the dialog; an upscale takes a few minutes and a few GB of memory.
- **A reply takes a minute or two** when it makes an image. A placeholder of the chosen shape shows the elapsed time and, unless drafts are off in Settings, rough drafts of the image as it is drawn, with Stop beside it. A message whose reply failed or was stopped stays in the chat with Try again; once you send another message instead, it is marked as one the assistant does not know about. An image OpenAI's safety system blocked is reported as such.
- **Chats** are listed on the left by their latest image. Rename a chat from its title (its folder is renamed to match), show its folder, or move it to the Trash from the File menu.
- **The menu** at the top of the chat list holds New chat, Show chats folder, Settings, Records, Keyboard Shortcuts and About GptImg.
- **Records** opens a window of what GptImg has recorded on this computer: its own activity and the image engine's events as log lines, and every request to OpenAI (each attempt, with what was sent and what came back) as provider calls. Search it, or filter by launch, chat, kind and level.
- **Settings** (in tabs: General, Chats, OpenAI) hold the language (ten languages, or follow the system), appearance, time zone, interface and conversation fonts, the chats folder, the API address (OpenAI's own unless you use a proxy or another service that speaks OpenAI's API), the API key, the assistant and image models with the assistant's thinking level, and how many drafts to show while an image is drawn. The built-in models are the recommended ones; another model id can be typed, and one GptImg does not know is marked as unsupported but still sent.

OpenAI keeps each conversation for about 30 days, so a follow-up sends only the new message. When OpenAI's copy is gone, GptImg resends the conversation from the chat's folder (with the images of its eight most recent image turns) and carries on.

## Files

- **Chats** live in the folder you chose, one folder per chat: `session.json` (the conversation), each image with a JSON record of the request and OpenAI's full reply beside it, and `inputs/` with a copy of every attached image. A chat folder is self-contained and can be moved, backed up or shared whole.
- **App data** lives in `~/.gptimg`: `config.json` (only the settings you changed), `state.json` (window and list layout), `api-keys.json` (your key, obfuscated and readable only by you; obfuscation is not encryption), `records.sqlite3` (every launch, the app's activity, every OpenAI call with its full reply and token use, and the image engine's events, the key masked; the Records window reads it, and a line it cannot take goes to `logs/` instead) and `backups.sqlite3` (earlier copies of each settings and chat file the app wrote). Set `GPTIMG_DATA_DIR` to use another folder.
- The upscaling model, once downloaded, lives in `~/.gptimgsdk/models`, where scripts using GptImgSdk find it too.
- Removing a chat moves its folder to the Trash; GptImg never deletes images itself.

## GptImgSdk

`gptimgsdk` is consumed from its TypeScript source on plain Node, with no build step. A script outside this repository depends on it by path (`"gptimgsdk": "file:../gptimg/sdk"`) and imports it by name:

```ts
import { GptImg, completed } from "gptimgsdk";

const img = new GptImg({ apiKey: process.env.OPENAI_API_KEY });
const result = completed(
  await img.generate({ prompt: "a single centered pink frosted donut", outDir: "/absolute/output" }),
);
console.log(result.files.map((file) => file.path));
```

The SDK reads no environment variable, configuration file or working directory: everything comes from the constructor and each call, and every path is absolute. Each verb returns `{ status: "completed", … }` or `{ status: "refused", refusal }`; `completed()` turns a refusal into a thrown `GptImgError` for scripts that do not handle one. The SDK writes no log: pass `onEvent` to receive each event of a call as a complete record, credentials masked, and store it where you keep your own records. Paid images get a JSON sidecar with the request, OpenAI's response and token usage.

The public types, the exported code tables, the tests and [`sdk/CHANGELOG.md`](sdk/CHANGELOG.md) are the API reference.

`chat` is one turn of a conversation, for an app that holds conversations, as the GptImg app does: the caller keeps the conversation (its earlier turns, the previous turn's `responseId`, which images to attach) and passes it with each turn, and the SDK sends that one turn to OpenAI and publishes the turn's images with their records, like any other paid verb. A script that makes or changes images uses `generate` and `edit`.

AI matting (`mask` with `method: "ai"`) and `upscale` run local models that are installed only on request (`img.model.install`), into `~/.gptimgsdk/models` unless a call or the constructor names another folder. They run offline once installed, but need memory: an AI mask peaks at about 11 GB, an upscale at about 3 GB with its default tile.

## Third-party models

Neither the app nor the SDK ships model files. The app downloads Swin2SR when you ask for upscaling; the SDK downloads either on request, from pinned revisions whose size and SHA-256 digest it checks:

- [BiRefNet ONNX](https://huggingface.co/onnx-community/BiRefNet-ONNX), MIT, for AI matting (about 0.5 GB).
- [Swin2SR real-world ×4 ONNX](https://huggingface.co/onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX), Apache-2.0, for upscaling (about 53 MB).

## Development

- `scripts/run-dev.command` runs the app from source with live reload; `rebuild.command` and `run-built.command` exercise the production build.
- `npm test` type-checks the app and the SDK and runs the ordinary suite.
- `npm run test:full` also runs the SDK's live lane: it makes a few paid OpenAI calls (export `OPENAI_API_KEY` first), downloads both models into `sdk/node_modules/.cache` (about 540 MB, once per pinned revision), and reads a photo from the company test-fixture corpus, which must be checked out beside this repository.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
