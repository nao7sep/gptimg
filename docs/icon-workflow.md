# Icon Workflow

An **app icon** is a square master image packed into the platform formats a desktop toolchain consumes: `icon.icns` (macOS), `icon.ico` (Windows), and sized PNGs (Linux/web/store). This document is a complete, self-contained recipe for producing one with `gptimg`: generate the glyph art, remove its background, set it on a gradient plate, size it to *look* right, and pack the platform files.

> **Scope.** `gptimg` performs the **imaging operations** and writes outputs to the paths you give it. It does not know which framework will consume them or how files must be named for it — that placement and renaming is the operator's job (see "Packing"). The conventions below are a reliable way to drive it, but every destination path is yours to supply.

Target formats this produces for: **Tauri** (`src-tauri/icons/` with framework-specific filenames), **Electron** (`build/icon.icns` + `build/icon.ico` via electron-builder), **Avalonia / .NET** (`<ApplicationIcon>` pointing at an `.ico`), and any toolchain that wants a loose sized-PNG set.

## The pipeline

```
generate content → mask → compose → trim --square → (upscale | resize) → [shadow] → backplate → layer → icon → rename
```

A worked example (a cluster of fanned note panels; substitute any glyph):

```sh
WORK="$TMPDIR/$(date -u +%Y%m%d-%H%M%S)-utc-panes-icon"
mkdir -p "$WORK/panes-01/indigo"
cd "$WORK"

# 1. Generate the glyph on a chroma backdrop whose key color is absent from the
#    art (these panes have no green, so #00ff00 is safe), at MEDIUM quality.
gptimg generate \
  "three overlapping rounded-rectangle note panels fanned like a hand of cards, \
   vivid coral, teal and amber, flat vector style, centered, on a solid pure green #00ff00 background, no green on the panels, no shadow" \
  --set size=1024x1024 --set chroma.color=#00ff00 --set quality=medium --out-name panes-01-original

cd "$WORK/panes-01"
ORIG="$WORK/panes-01-original.png"

# 2. Remove the background by keying out the backdrop.
gptimg mask --in "$ORIG" --key from-sidecar --out-name panes-01-mask.png
gptimg compose --in "$ORIG" --mask panes-01-mask.png --remove-bleed "#00ff00" --out-name panes-01-cutout.png

# 3. Square the glyph, leaving margin for a shadow. (--square is correct for icons.)
gptimg trim --in panes-01-cutout.png --square --margin 0.10 --out-name panes-01-square.png

# 4. Normalize the squared content to 1024: upscale (learned ×4) when the glyph
#    is smaller than 1024, resize (plain) when larger.
gptimg upscale --in panes-01-square.png --to-size 1024 \
  --out-name panes-01-content.png

# 5. (Optional) Cast a contact shadow that stays within the square canvas.
gptimg shadow --in panes-01-content.png --keep-canvas --blur 24 --offset 0,18 \
  --opacity 0.32 --color "#0a0a20" --out-name panes-01-content-shadow.png

# 6. Build the base in the variant subdirectory: a squircle plate with a brand gradient.
gptimg backplate --size 1024 --from "#4f46e5" --to "#1e1b4b" --shape squircle \
  --out-name indigo/plate-indigo.png

# 7. Composite the glyph onto the plate at a tuned scale (see "Sizing the glyph").
#    The final carries a clean slug so it is obvious which file is the master.
gptimg layer --base indigo/plate-indigo.png --top panes-01-content-shadow.png --scale 0.80 \
  --out-name indigo/panes-indigo.png

# 8. Pack the platform files into the variant dir, then rename per target (see "Packing").
gptimg icon --in indigo/panes-indigo.png --out-dir indigo --pngs
```

## Quality: always start at medium

Always generate at **`quality=medium`**. `high` is significantly more expensive, and the overwhelming majority of icon candidates are discarded for *what they contain and how* — concept, composition, balance — not for resolution. Use `high` **only when the operator explicitly asks for it** after judging a specific medium render insufficient — never on the AI's own initiative.

## Concurrency

- **API calls** — `generate`, `edit`, `vision` — are network-bound and may run **in parallel**, around **5 at a time**, which speeds up generating a batch of candidates.
- **Local ONNX models** — `mask --method ai` (BiRefNet) and `upscale` (Swin2SR) — load 1.5–4.4 GB of native memory each and must run **strictly one at a time**. Never run two in parallel; it can drive the machine into swap and crash the desktop session.

## Why square (and why this differs from a stamp)

Icons are **forced square** — `trim --square` extends the shorter axis with transparent pixels so the glyph sits on a square canvas, because the plate and every packed size are square. (A transparent overlay stamp is the opposite: there, forcing square would bake dead side-space onto tall or wide subjects, so stamps preserve native aspect.) Use `--square` for icons.

## Masking: chroma key by default

As with stamps, **chroma key is the default** — it reliably beats the AI matte on the clean, flat art most glyphs are made of (the AI matte tends to *add* edge problems on simple subjects). Generate the glyph on a flat chroma backdrop whose key color is **absent from the art**: `#00ff00` for most glyphs, or magenta `#ff00ff` / another unused hue if the glyph contains green. Then key it out, exactly like a stamp.

Reach for the **AI matte** (`mask --method ai`, BiRefNet, generated on a plain neutral background instead) only in the narrow cases where a glyph genuinely can't be keyed: fine fibers/fur, or colors that unavoidably span every candidate key hue. It is heavy (~1–1.5 GB RAM, run one at a time — see "Concurrency"; pre-fetch with `gptimg model install birefnet`).

## The base (plate)

`backplate` synthesizes the bottom layer: a centered rounded shape filled with a linear gradient on a transparent square canvas.

- `--shape squircle` matches the macOS continuous-curvature dock shape; `--shape rect` is a plain rounded rectangle.
- `--from` / `--to` are the gradient endpoints (required); `--angle` is the gradient direction (default 135°, bottom-left → top-right).
- `--content` is the plate side as a fraction of the canvas; `--radius` is the corner radius as a fraction of the plate side.

**The defaults are tuned to the macOS icon grid.** On a 1024 artboard, macOS places the rounded body at **824×824 (≈80 % of the canvas, ~100 px transparent padding all around) with a corner radius of ~185 px (≈22.5 % of the body).** `backplate`'s defaults — `--content 0.80`, `--radius 0.225` — reproduce exactly this. The transparent padding is intentional: it is the system's space for the icon's shadow and keeps every app's icon consistently sized.

## Two platforms, two masters

The macOS 80 % grid looks correct on macOS but slightly *small* in a full-bleed Windows context, where icons typically fill their tile. Do not force one compromise master onto both — **make a master per platform**, because the two platforms read **separate files in separate formats** and never share bytes:

- a **macOS master** with the default `--content 0.80` squircle → packed into **`icon.icns`** (what a `.app` bundle reads),
- a **Windows master** with a fuller plate (raise `--content` toward `0.90`–`1.0`, optionally `--shape rect`) → packed into **`icon.ico`** (what an `.exe` embeds).

A `.app` reads exactly one `.icns` and an `.exe` embeds one `.ico`, so each bundle already gets its own file — you simply pack each from the master that suits it. Cross-platform bundlers (Tauri, Electron) reference `.icns` and `.ico` independently, so providing a mac-tuned `icon.icns` and a win-tuned `icon.ico` is all that's required. The shared sized-PNGs (Linux, tray, window-runtime) use one master of your choice — the macOS one is a fine default. Build the content once; only the `backplate`/`layer` steps differ per platform, and those are cheap local composites.

## Shadow

A soft **contact shadow** under the glyph lifts it off the plate. Cast it on the squared content with `--keep-canvas` so the canvas stays square, sizing the blur/offset to fit within the `trim --square` margin (a `0.10` margin leaves room for a moderate shadow). Then `layer` the shadowed glyph onto the plate. This is a depth cue *on the plate*, not an outer shadow on the icon itself — the OS adds the outer shadow at display time, so do not bake one around the whole squircle.

## Sizing the glyph

How large to make the glyph on the plate is the one genuinely hard call. It has no exact formula, because **perceived size is multi-factorial** — at least four separable effects drive it:

1. **Visual mass / area** — how much ink there is.
2. **Maximum extent / elongation** — a longer shape reads larger at a glance (the *elongation bias*: a tall glass "looks like it holds more"). For equal area, the elongated shape looks bigger.
3. **Orientation** — vertical extent reads ~5–10 % longer than the same physical horizontal extent (the *horizontal–vertical illusion*).
4. **Color, contrast, brightness** — a bright, warm, high-contrast glyph reads **larger** than a dark, muted, low-contrast one of identical geometry (the *irradiation illusion*: a light shape on a dark field looks bigger than a dark shape on a light field).

Because of (4) especially, **no geometric number can be authoritative** — the same shape looks larger in vivid coral-on-dark than in muted gray-on-white. So the guidance below is a **starting point to be adjusted by eye**, not a rule, and deliberately not encoded in `gptimg`.

**Don't normalize by bounding box.** `layer --scale` sizes the top image by its longer edge, which over-weights extent and is fooled by sparse glyphs (a fanned cluster whose bounding box is mostly empty reads far smaller than its box). Two pro systems make the point: Material and Apple do not use one bounding box — they define **per-shape keylines** (Material's circle keyline is ~11 % larger than its square keyline so the two *look* equal).

**A practical starting metric: optical size.** Estimate the glyph's *optical* size as the equivalent square side of its actual ink — `√(filled-alpha area)`, which for typical glyphs lands near `(width + height) / 2` of the ink's bounding box — expressed as a percentage of the 824 body. This blends mass and extent and uses the real ink, not the box. Then **eyeball it against a familiar reference icon and nudge.**

**Two archetypes set the target range:**

- **Full-bleed / background-as-shape** (the artwork *is* the plate's fill, edge to edge): ~90–100 % of the body.
- **Symbol-on-plate** (a distinct glyph floating on a colored plate): ~55–82 % of the body. *Object-cluster* glyphs (stacked notes, overlapping shapes) sit at the high end, ~75–82 %; a single small symbol can sit lower.

For a symbol-on-plate icon, **start around 70–75 % optical, then trust your eyes** — and remember a vivid, high-contrast glyph on a dark plate can be set a little smaller than a muted one and still read as large, thanks to the irradiation effect.

## Normalizing the content size

Normalize the squared content to **1024** before compositing, picking the verb by direction:

- **`upscale --to-size 1024`** when the cut-out glyph is **smaller** than 1024: the learned ×4 super-resolution (distortion-optimized — it enlarges faithfully rather than hallucinating texture) makes a small glyph genuinely crisp before `layer` scales it onto the plate. Never enlarge by re-generating; that changes the art. `upscale` is one of the two strictly-sequential local models (see "Concurrency").
- **`resize --to-size 1024`** when the content is already **≥ 1024**: a plain, model-free downscale is clean and instant.

Generating at a fixed 1024² keeps this predictable: a centered glyph usually lands below 1024 after `trim --square`, so it is the upscale case and the content is crisp at composite time.

## Iterating bases and sizes cheaply

Only the content generation costs money or time (the chroma mask is a cheap local step). The plate, the gradient, and the glyph scale are **free local composites** — generate the content once, then sweep bases and scales with `backplate` + `layer`. Render a *manageable* grid (not every combination at once), compare, and narrow interactively. "Make the background more vivid" or "try it bigger" is a re-render of the cheap layers, not a new generation. When you do want several content candidates, generate them in parallel (API calls, ~5 at a time).

## Multi-size legibility

Before committing, look at the glyph at the sizes it will actually appear. `gptimg icon --pngs` emits the small sizes; open `icon-16.png` and `icon-32.png` and check that the silhouette survives. Thin elements (fine text lines, hairline strokes) vanish at 16 px — that is the moment to catch it, by eye. This is a visual check; vision verdicts add little at icon sizes.

## Verifying

Unlike a transparent stamp cutout, a composited icon is **opaque**, so `gptimg vision` can judge it directly:

```sh
gptimg vision --in indigo/panes-indigo.png \
  --check "one centered glyph on a rounded gradient plate, well balanced, not cut off, good contrast" \
  --out-name panes-vision
```

Prefer your own eyes for the real judgment and run `gptimg vision` as an additional recorded check — useful so a vision-incapable agent can complete the same work, and harmless to keep.

## Packing and target layouts

`gptimg icon --in <square master ≥1024²> --out-dir <dir> --pngs` emits the same bytes for every toolchain:

```
icon.icns  icon.ico  icon.png            # containers + 1024² master copy
icon-16.png … icon-1024.png              # loose sized set (with --pngs)
```

`gptimg` stops there: it produces files in a layout you can distinguish, and **renaming/placing them is your job** — the tool has no knowledge of the consuming framework. Rename and place per target:

- **Tauri** (`src-tauri/icons/`): `32x32.png`, `128x128.png`, `128x128@2x.png` (= 256 px), `icon.icns`, `icon.ico`, `icon.png`. Map from the loose set: `icon-32.png → 32x32.png`, `icon-128.png → 128x128.png`, `icon-256.png → 128x128@2x.png`; the `.icns`/`.ico`/`.png` keep their names. Then list them in the project's `bundle.icon` array. (If you made per-platform masters, pack each separately and take `icon.icns` from the macOS master, `icon.ico` from the Windows master.)
- **Electron** (electron-builder): `build/icon.icns` + `build/icon.ico` — the two containers, copied under `build/`.
- **Avalonia / .NET**: point `<ApplicationIcon>` at `icon.ico`.
- **Linux / web / generic**: use the loose `icon-<size>.png` set directly.

The master must be **square and ≥1024×1024** (this workflow produces 1024²).

## Working conventions

These keep a session reproducible and debuggable.

- **Stage in a fresh temp directory** under the OS temp root, named with a UTC timestamp and the task objective: `$TMPDIR/<yyyymmdd-hhmmss-utc>-<objective>/`. (`~/.gptimg/` is the tool's own territory — do not stage there.) Get the timestamp from the OS (`date -u`), not from memory.
- **The top level holds raw generations and their sidecars only.** Every other file — masks, cutouts, plates, composites, previews, finals, packed icons — lives in a subdirectory. This keeps the originals (the one paid, irreplaceable artifact) trivially findable.
- **One directory per content candidate; one subdirectory per base.** A candidate's shared content prep (`mask`, `cutout`, squared `content`) lives at the candidate level; each base (plate color/shape) gets its own subdirectory, and the **content size is a filename suffix** within it (sizes are cheap, you make many). The chosen final lives in its base subdirectory too — there is no separate "final" folder; a clean filename (no candidate index / `-sNN` suffix) marks the master.
- **Use descriptive slug filenames**, never bare timestamps, with room for future siblings. Encode role and candidate index on work files (`panes-01-original.png`, `-01-mask.png`); the final master carries a clean slug (`panes-indigo.png`).
- **Keep every raw generation and its sidecar.** The sidecar (`<stem>.json`, written by `generate`) holds the prompt and resolved request — the recipe to reproduce the art. The post-processing verbs (`mask`, `compose`, `trim`, `backplate`, `layer`, `shadow`, `upscale`, `icon`) write **no** sidecars, so record their parameters yourself (see "READMEs").
- **Never destroy a durable artifact.** Renaming on a collision is fine — both files survive. Overwriting is not: you must be able to inspect how anything was made. Previews are work-in-progress and live in the subdirectories like everything else.
- **Sign off on the raw generation before processing it.** Generation is the only paid step and the only one that can be "wrong." If a generation is no good, re-prompt — do not invest the pipeline in a reject.
- **A README at each level.** `<candidate>/README.md` records the raw → content recipe (mask method, trim, shadow, any upscale); `<candidate>/<base>/README.md` records the content → icon recipe (plate `from`/`to`, shape, angle, content fraction, layer scale, chosen size). Free format — enough for another operator to replicate it. These are the human-readable substitute for the sidecars the processing verbs do not emit.
- **Retention is branch-level.** Any candidate or base you keep retains its *complete* intermediate trail — never prune a keeper's intermediates. A branch you clearly reject (a base you hated, a content candidate that lost) is dropped *whole*.

A staging layout for two content candidates, one with two bases:

```
$TMPDIR/<ts-utc>-panes-icon/
  panes-01-original.png                   # raw + sidecar ONLY at the top level
  panes-01-original.json                  #   generation sidecar = prompt/provenance
  panes-02-original.{png,json}
  panes-01/                               # one content candidate's work
    README.md                             #   raw → content recipe
    panes-01-mask.png  panes-01-cutout.png  panes-01-content.png   # shared across all bases
    indigo/
      README.md                           #   content → icon recipe for this base
      plate-indigo.png
      panes-indigo-s80.png  panes-indigo-s84.png   # candidate composites (size = suffix)
      panes-indigo.png                    #   FINAL master (clean name = obvious)
      panes-indigo.json                   #   provenance sidecar copy
      icon.icns  icon.ico  icon.png  32x32.png  128x128.png  128x128@2x.png   # packed + renamed
    slate/
      README.md  plate-slate.png  panes-slate-s80.png
  panes-02/
    ...
```

## Finalizing and deploying

1. **Pick one combination** (content × base × size, and a platform master each if you split mac/Windows). Copy the keeper candidates plus their sidecars and READMEs into your asset library, at a path you supply; the chosen master and its provenance sidecar sit in their base subdirectory under a clean filename.
2. **Pack** the master(s) with `icon --pngs` and **rename** the outputs for the target framework (see "Packing").
3. **Deploy** the renamed files into the framework's icon directory and wire them up where required (the Tauri `bundle.icon` list; the .NET `<ApplicationIcon>`), replacing any placeholder.

Note an asymmetry with a transparent stamp: a stamp's descriptive slug *is* its deployed filename, but an icon's deployed names are **fixed by the target framework** — the slug only organizes your library. Destination paths are supplied per task, not baked into this workflow.
