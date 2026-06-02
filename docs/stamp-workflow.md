# Stamp Workflow

A **stamp** is a transparent-background overlay asset — a sticker, badge, postmark, frame, ribbon, or watermark-style graphic — that a host application composites on top of a photo. This document is a complete, self-contained recipe for producing one with `gptimg`: generate the art, remove its background, normalize its margins, cast a shadow, and deliver a clean transparent PNG.

> **Scope.** `gptimg` performs the **imaging operations** — one operation per command, a path in and a path out. Organizing, renaming, and placing the resulting files is the operator's job, whether a person at the CLI or an agent driving it. The conventions below are a reliable way to do that, but every destination path is yours to supply.

## What a good stamp asset is

- **A transparent PNG.** Some host applications also accept SVG; `gptimg` produces raster PNG, which is the path covered here.
- **Cropped tight to the art, in its native aspect ratio.** A tall subject stays tall, a wide subject stays wide. There is **no forced square**, so there is no dead side-space — the asset is exactly the art plus a thin uniform border. (Forcing a square canvas would bake empty space onto the sides of tall or wide subjects; that is something app icons do, and stamps must not.)
- **One consistent margin around the subject** on all four sides, identical across every stamp in a set, so they share the same visual breathing room when a host app places and scales them by their bounding box. The shadow is drawn *inside* that margin (see "Shadow"), so the 5 % stays pinned to the subject, not the shadow.
- **A baked drop shadow.** The host app composites the PNG as-is, so any "lift" off the photo has to live inside the asset. A shadow is applied **by default** (drop it only on explicit request — see "Shadow").

## The pipeline

```
generate → mask → compose → trim → shadow --keep-canvas → (upscale to enlarge | resize to shrink) → verify
```

A worked example (a distressed circular postmark; substitute any subject):

```sh
WORK="$TMPDIR/$(date -u +%Y%m%d-%H%M%S)-utc-vintage-postmark-stamp"
mkdir -p "$WORK/vintage-postmark"
cd "$WORK"

# 1. Generate the art as ink/shapes on a flat chroma backdrop, at MEDIUM quality
#    (see "Quality"). The chroma color is recorded into the sidecar so the mask
#    step can read it back. Raw image + sidecar stay at the top level.
gptimg generate \
  "a distressed circular postmark, dark crimson ink, concentric rings and a date, \
   printed directly on a flat solid pure green #00ff00 background, no paper, flat top-down view" \
  --set size=1024x1024 --set chroma.color=#00ff00 --set quality=medium \
  --out-name vintage-postmark-original

# All work-in-progress goes in the candidate's subdirectory.
cd "$WORK/vintage-postmark"
ORIG="$WORK/vintage-postmark-original.png"

# 2. Produce an alpha mask by keying out the backdrop.
gptimg mask --in "$ORIG" --key from-sidecar --out-name vintage-postmark-mask.png

# 3. Apply the mask and clean residual key spill from the kept pixels.
gptimg compose --in "$ORIG" --mask vintage-postmark-mask.png \
  --remove-bleed "#00ff00" --out-name vintage-postmark-cutout.png

# 4. Crop the SUBJECT to a uniform 5% margin — NO --square. This locks the asset size.
gptimg trim --in vintage-postmark-cutout.png --margin 0.05 \
  --out-name vintage-postmark-trim.png

# 5. Cast the shadow INSIDE the locked canvas (--keep-canvas = no growth; applied by
#    default, drop only on request). The shadow tucks into the margin; only its faint
#    feathered tail can clip at the edge, which is harmless.
gptimg shadow --in vintage-postmark-trim.png --keep-canvas --blur 16 --offset 0,12 \
  --opacity 0.28 --color "#101010" --out-name vintage-postmark-shadow.png

# 6. Normalize the longer edge to 1024 — upscale to enlarge (the usual case), resize
#    to shrink (see "Normalizing the size"). The final carries the clean slug.
gptimg upscale --in vintage-postmark-shadow.png --to-size 1024 \
  --out-name vintage-postmark.png
```

## Quality: always start at medium

Always generate at **`quality=medium`**. `high` is significantly more expensive, and the overwhelming majority of candidates are discarded for *what they contain and how* — composition, legibility, style — not for resolution. Use `high` **only when the operator explicitly asks for it** after judging a specific medium render's quality insufficient — never on the AI's own initiative, and never speculatively. Medium is the default for every generation, including the final keeper, unless a person has asked for high.

## Concurrency

- **API calls** — `generate`, `edit`, `vision` — are network-bound and may run **in parallel**, around **5 at a time**, which speeds up generating a batch of candidates.
- **Local ONNX models** — `mask --method ai` (BiRefNet) and `upscale` (Swin2SR) — load 1.5–4.4 GB of native memory each and must run **strictly one at a time**. Never run two AI masks, two upscales, or one of each in parallel; it can drive the machine into swap and crash the desktop session. (If an `upscale` ever feels unusually slow, check whether something else is competing for the GPU/CPU — e.g. a local image-generation model running at the same time — rather than reaching for a plain resample.)

## Background removal: chroma key is the default

Two mask methods exist, but **chroma key is the default by a wide margin** — generate the subject on a flat chroma backdrop and key it out. It is deterministic, cheap (no model, no network), and gives the cleanest *hard* edges. This is not a per-subject tie to break: across a large body of generated subjects chroma is the reliable choice, and the AI matte frequently does *worse* on simple, clean art — over- or under-segmenting an edge a key would cut perfectly. Treat the AI matte as a narrow fallback, not a co-equal option.

Two rules make chroma reliable:

- **Pick a key color absent from the subject.** `#00ff00` is the default. If the art contains green (foliage, a green object), key on magenta `#ff00ff` instead; in general choose a hue the art does not use. `generate` records the chosen color in the sidecar, and `mask --key from-sidecar` reads it back, so the choice is made once.
- **Decontaminate edges with `compose --remove-bleed "<key>"`.** This suppresses key spill on every kept pixel and recovers edge colors blended against the backdrop, removing the faint colored fringe that keying otherwise leaves. A faint residual fringe, if any, is hidden under the drop shadow.

**Reach for the AI matte (`mask --method ai`, BiRefNet) only when:**

- the subject has **fine fibers** — hair, fur, feathers, frayed edges, dense foliage. Chroma keying leaves an *irremovable* halo in the gaps between fibers; this is a fundamental limitation of color keying, not a tuning problem, and professional tools hit the same wall. The AI matte handles these cleanly.
- the subject's colors **unavoidably span the key hue**, so no single key color is safe.
- the source is **not on a clean chroma backdrop** at all.

The AI mask works on any background but is heavy (~1–1.5 GB RAM per process) and must run one at a time (see "Concurrency"). The model downloads once on first use; pre-fetch with `gptimg model install birefnet`.

**Interior regions.** By default every key-colored pixel — including pockets fully enclosed by the subject — becomes transparent, which is what you want for line art where the gaps between strokes should show the photo beneath. If a subject has an *intentional* solid interior that happens to be key-colored, use `mask --preserve-interior`, or combine a preserve-interior mask with a plain one via `combine intersect`.

## Margins: one locked number for the whole set

The crop is what makes a set of stamps feel consistent.

- **`trim --margin K` (without `--square`)** pads the art's bounding box by `K × max(bbox.width, bbox.height)` — the **same pixel count on all four sides** — and preserves the native aspect ratio. A tall subject keeps a thin uniform border and stays tall; a wide subject stays wide.
- **Normalizing the longer edge to a fixed target** then makes that margin a **constant** across every stamp, independent of how large or small the subject was in the generated frame. `trim` discards the original canvas entirely, so after it the margin is always the same fraction of the image's longer side — `K / (1 + 2K)` — and normalizing the longer edge scales that fraction to the same absolute pixels every time:

```
final margin (px)  =  K / (1 + 2K) × longerEdge
```

With **`K = 0.05`** and a **1024** longer edge, that is a uniform **≈44 px** border on all four sides of every stamp — square, tall, or wide alike — with the art filling ~91 % of the canvas. `0.05` is the recommended lock: a clean 5 % that reads as deliberate breathing room without wasting box space. Tighter (`0.04`) reads punchier; looser (`0.08`) leaves more room. Whatever you choose, lock it and the margin is fixed set-wide.

A tapered subject (a tower, a cone) can *look* like it has more side-space than top/bottom: the bounding box is set by the widest point, so above that the art narrows away from the edges. The margin is still uniform at the bounding box — the apparent gap is the silhouette, not the crop. Uniform-margin cropping is necessarily defined against the bounding box; that is the only scale-invariant, objective choice.

## Generating and normalizing the size

**Generate at a fixed 1024×1024** (`--set size=1024x1024`) so the canvas is predictable. A centered subject occupies less than the full frame, so after `trim` the art's longer edge is almost always *below* 1024 and the normalize step is an enlargement.

**Normalize the longer edge to 1024:**

- **Enlarging (trimmed art < 1024 — the usual case): always `upscale --to-size 1024`.** Use the learned ×4 super-resolution for *any* enlargement, however small — even art already at 1020 px goes through the model, never a plain stretch. It is distortion-optimized, so it enlarges faithfully rather than hallucinating texture, and is sharper than a plain resample. `upscale` is one of the two strictly-sequential local models (see "Concurrency"); it is normally fast, so a long run usually means something else is contending for the machine, not a reason to switch to `resize`.
- **Shrinking (trimmed art ≥ 1024 — e.g. the subject filled the frame): `resize --to-size 1024`.** A learned model adds nothing when downscaling; a plain resample is clean and instant. `resize` is **only** for shrinking — never use it to enlarge art you care about.

## Shadow (applied by default)

A baked drop shadow makes a stamp "lift" off the photo, gives a set a cohesive die-cut-sticker look, and softens any faint key-color edge fringe (its soft dark perimeter hides it). **Apply a shadow by default**; drop it only when the operator explicitly asks for a flat, shadowless stamp (for example, line art where a per-stroke shadow isn't wanted). It reads strongest on **solid subjects** (a sticker, a seal, a badge), where it casts a single silhouette shadow.

Cast the shadow **after `trim`, with `--keep-canvas`**, so the **subject** is the thing with the uniform 5% margin and the shadow is drawn *inside* that locked canvas without growing it:

```sh
gptimg trim --in <cutout>.png --margin 0.05 --out-name <trim>.png
gptimg shadow --in <trim>.png --keep-canvas --blur 16 --offset 0,12 --opacity 0.28 --color "#101010" \
  --out-name <shadow>.png
gptimg upscale --in <shadow>.png --to-size 1024 --out-name <final>.png   # resize instead if the shadowed canvas is already >= 1024
```

The order matters because the **margin should be measured from the subject, not from the shadow.** `trim` first gives the subject a clean, uniform 5 % on all sides; `shadow --keep-canvas` then tucks the shadow into that margin without enlarging the asset by even one pixel. The shadow's faint, near-zero feathered tail may clip at the canvas edge — harmless: with `blur 16 / offset 0,12` against a 5 % margin the *visible* shadow stays well inside the canvas (only sub-1/255-alpha pixels fall off). If you shadowed *before* trimming instead, the 5 % would be pinned to the shadow's outer edge and the subject would sit off-center, its breathing room varying with shadow size.

## Verifying the result

**`gptimg vision` cannot see transparency.** It ingests a transparent PNG flattened on black, so it always reports a "black background" and may misread a soft shadow — or even the anti-aliased edge — as a halo. Never vision-check a bare RGBA cutout for edge quality.

Instead, **composite the cutout onto a known plate and check that.** Build a solid plate with `backplate` and `layer` the cutout onto it — `layer` honors the cutout's true alpha:

```sh
gptimg backplate --size 1200 --from "#9a9a9a" --to "#9a9a9a" --shape rect --content 1.0 --radius 0 --out-name plate-gray.png
gptimg layer --base plate-gray.png --top <cutout>.png --scale 0.85 --out-name preview-gray.png

# a dark plate reveals any key-color fringe:
gptimg backplate --size 1200 --from "#202020" --to "#202020" --shape rect --content 1.0 --radius 0 --out-name plate-dark.png
gptimg layer --base plate-dark.png --top <cutout>.png --scale 0.85 --out-name preview-dark.png
```

A light plate reveals shadows; a dark plate reveals key-color fringe. Check both. **Do not** preview by feeding the cutout to `compose --mask` as its own mask: `compose` reads the mask image's *luminance* (it greyscales and drops alpha), so a glossy subject's dark areas would read as semi-transparent — a misleading preview, not a real defect. To check *opacity* directly, measure the alpha channel rather than eyeballing a composite. Then, for a recorded verdict:

```sh
gptimg vision --in preview-gray.png \
  --check "one centered subject, fully visible, clean edges with no colored fringe; a soft shadow is acceptable" \
  --out-name vintage-postmark-vision
```

**Use both kinds of sight.** If the agent driving `gptimg` can view images, that direct look is the real check. Run `gptimg vision` *in addition*, as a recorded, scriptable verdict that a vision-incapable agent can also rely on — do not omit it, but do not treat its score as final either: it is noisy, and on **intentionally textured or distressed** art it tends to flag the texture itself as "fringe." Cross-check against the plate composites before acting on a vision verdict.

## Working conventions

These keep a session reproducible and debuggable.

- **Stage in a fresh temp directory** under the OS temp root, named with a UTC timestamp and the task objective: `$TMPDIR/<yyyymmdd-hhmmss-utc>-<objective>/`. (`~/.gptimg/` is the tool's own territory — do not stage there.) Get the timestamp from the OS (`date -u`), not from memory.
- **The top level holds raw generations and their sidecars only.** Every other file — masks, cutouts, previews, finals — lives in a per-candidate subdirectory. This keeps the originals (the one paid, irreplaceable artifact) trivially findable.
- **Use descriptive slug filenames — no index numbers.** A "candidate" is a distinct *design* (a different subject, style, or treatment), so it gets its own descriptive slug — `vintage-postmark`, `gold-star`, `wax-seal` — never a numbered variant like `-01`. Leave room for future siblings: `vintage-postmark`, not `postmark`, so a later `modern-postmark` does not force a rename. Work files encode the pipeline role: `vintage-postmark-original.png`, `-mask.png`, `-cutout.png`, `-shadow.png`, `-trim.png`. The **final** carries the clean slug with no stage suffix (`vintage-postmark.png`), so the finished asset is obvious from its name alone — no separate "final" folder is needed.
- **If you rename a generated image, fix its sidecar.** The generation sidecar (`<stem>.json`) records the image basename in `files[0].name`; if you rename the PNG you must rename the sidecar *and* update that field, or the image↔sidecar pairing silently breaks. The `sha256` does **not** change — it hashes the bytes, not the name — so it stays valid.
- **Keep every raw generation and its sidecar.** The sidecar (`<stem>.json`, written by `generate`) holds the prompt and resolved request — it is the recipe to reproduce the art. The post-processing verbs (`mask`, `compose`, `trim`, `resize`, `upscale`, `shadow`) do **not** write sidecars, so record their parameters yourself (see "READMEs").
- **Never destroy a durable artifact.** Renaming on a name collision is fine — both files survive. Overwriting is not: if something goes wrong, you must still be able to inspect how it was made. Previews are work-in-progress and live in the candidate subdirectory like everything else; they may be regenerated, but do not overwrite originals or finals.
- **Sign off on the raw generation before processing it.** Generation is the only paid step and the only one that can be "wrong." If a generation is no good, re-prompt — do not invest the mask/compose/trim pipeline in a reject.
- **One README per candidate directory.** Write `<candidate>/README.md` recording exactly how the asset was made: the source generation, mask method and key color, `remove-bleed`, shadow parameters, trim margin, normalize verb and target size. The format is free — enough for another operator (human or agent) to replicate it. These READMEs are the human-readable substitute for the sidecars the processing verbs do not emit.
- **Retention is branch-level.** Any candidate you keep retains its *complete* intermediate trail — never prune a keeper's intermediates. A candidate you clearly reject is dropped *whole*.

A staging layout for two candidates (two distinct designs):

```
$TMPDIR/<ts-utc>-cute-concealer-stamps/
  vintage-postmark-original.png        # raw + sidecar ONLY at the top level
  vintage-postmark-original.json       #   generation sidecar = prompt/provenance
  gold-star-original.{png,json}        # a second candidate = a different design
  vintage-postmark/                    # all work-in-progress + the final for this design
    README.md                          #   how this design was made
    vintage-postmark-mask.png
    vintage-postmark-cutout.png
    vintage-postmark-trim.png
    vintage-postmark-shadow.png
    preview-gray.png  preview-dark.png #   disposable checks (still inside the subdir)
    vintage-postmark.png               #   FINAL (clean slug, shadow baked in)
  gold-star/
    ...
```

## Finalizing and deploying

1. **Pick the keepers** and give each a final descriptive slug, conflict-checked against the destination directory (and any existing set the host app merges by filename) — rename to a free slug if needed so nothing collides.
2. **Keep the source of truth in your own asset library** — the finished PNG, its provenance sidecar, and the README — at a path you supply.
3. **Deploy only the image** into the host application's stamp folder. Bundled stamp sets are typically identified by filename alone, so sidecars and READMEs stay in your library, not in the app. The deployed filename is the descriptive slug.

Destination paths are not part of this workflow — supply them per task.
