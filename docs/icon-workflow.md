# Icon Workflow

An **app icon** is a square master image packed into the platform formats a desktop toolchain consumes: `icon.icns` (macOS), `icon.ico` (Windows), and sized PNGs (Linux/web/store). This document is a complete, self-contained recipe for producing one with `gptimg`: generate the glyph art, remove its background, set it on a gradient plate, size it to *look* right, and pack the platform files.

> **Scope.** `gptimg` performs the **imaging operations** and writes outputs to the paths you give it. It does not know which framework will consume them or how files must be named for it — that placement and renaming is the operator's job (see "Packing"). The conventions below are a reliable way to drive it, but every destination path is yours to supply.

Target formats this produces for: **Tauri** (`src-tauri/icons/` with framework-specific filenames), **Electron** (`build/icon.icns` + `build/icon.ico` via electron-builder), **Avalonia / .NET** (`<ApplicationIcon>` pointing at an `.ico`), **Qt** (PySide6/PyQt — a runtime PNG via `QIcon` plus `.icns`/`.ico` for the packager), and any toolchain that wants a loose sized-PNG set.

## The pipeline

```
generate content → mask → compose → trim --square → [upscale if below on-plate size] → shadow → backplate → layer → icon → rename
```

A worked example — a real run this workflow was validated on (Dropkick's three stacked downward chevrons; substitute any glyph). It stages **directly in the asset library** so every step is a reviewable git diff (see "Working conventions"):

```sh
# Stage in the library path you'll keep this in — NOT a temp dir.
ICONS=~/code/<repo>/assets/<project>/icons
mkdir -p "$ICONS/chevrons-down/blue"

# 1. Generate the glyph on a chroma backdrop whose key color is absent from the
#    art (these chevrons have no green, so #00ff00 is safe), at MEDIUM quality.
#    Pass an absolute --out-dir so a paid generation lands where you expect.
gptimg generate \
  "A modern flat app-icon illustration: a bold set of three stacked downward \
   chevron arrows, thick and chunky, a coral-to-amber gradient across the \
   chevrons, clean minimal vector style, crisp edges, centered, on a solid pure \
   green #00ff00 background, no green on the artwork, no shadow, no real words" \
  --set size=1024x1024 --set chroma.color=#00ff00 --set quality=medium \
  --out-dir "$ICONS" --out-name chevrons-down-original

ORIG="$ICONS/chevrons-down-original.png"
C="$ICONS/chevrons-down"           # candidate dir = shared content prep
B="$C/blue"                        # base dir = one brand plate

# 2. Shared content prep (used by BOTH platform masters): key out the backdrop,
#    square the glyph with a shadow margin, cast a contact shadow inside the canvas.
gptimg mask    --in "$ORIG" --key from-sidecar --out-dir "$C" --out-name chevrons-down-mask.png
gptimg compose --in "$ORIG" --mask "$C/chevrons-down-mask.png" --remove-bleed "#00ff00" --out-dir "$C" --out-name chevrons-down-cutout.png
gptimg trim    --in "$C/chevrons-down-cutout.png" --square --margin 0.10 --out-dir "$C" --out-name chevrons-down-content.png
gptimg shadow  --in "$C/chevrons-down-content.png" --keep-canvas --blur 24 --offset 0,18 \
  --opacity 0.32 --color "#0a0a20" --out-dir "$C" --out-name chevrons-down-shadow.png
#    A glyph generated near 1024 is already larger than its on-plate size, so no
#    upscale is needed here — see "Normalizing the content size".

# 3. Three renderings from the one content (mac + win shown; web = the same content on a
#    full-bleed --content 1.0 --radius 0 plate). Only the plate --content and the
#    layer --scale (and an optional --top-offset) differ (see "Three renderings",
#    "Sizing the glyph", "Positioning the glyph").
#    Corner `--radius 0.305` and `--content 0.87` are *measured* from real macOS
#    system icons (see "The base (plate)"); the `squircle` shape is squarer and is
#    the wrong tool here.
#    macOS: 0.87 plate, glyph at 0.68, nudged DOWN 15px to optically center it
#    (a downward chevron is top-heavy — see "Positioning the glyph").
gptimg backplate --size 1024 --from "#2563eb" --to "#1e3a8a" --shape rect --radius 0.305 --content 0.87 --out-dir "$B" --out-name plate-blue-mac.png
gptimg layer --base "$B/plate-blue-mac.png" --top "$C/chevrons-down-shadow.png" --scale 0.68 --top-offset 164,179 --out-dir "$B" --out-name chevrons-down-blue-mac.png
#    Windows: fuller 0.92 plate, glyph at 0.72 — computed (= mac 0.68 × 0.92/0.87), not eyeballed.
gptimg backplate --size 1024 --from "#2563eb" --to "#1e3a8a" --shape rect --radius 0.305 --content 0.92 --out-dir "$B" --out-name plate-blue-win.png
gptimg layer --base "$B/plate-blue-win.png" --top "$C/chevrons-down-shadow.png" --scale 0.72 --top-offset 144,160 --out-dir "$B" --out-name chevrons-down-blue-win.png

# 4. Pack each master into its own subdir (so icon.icns/icon.ico don't collide),
#    then cherry-pick per target at deploy time (see "Packing").
gptimg icon --in "$B/chevrons-down-blue-mac.png" --out-dir "$B/mac" --pngs
gptimg icon --in "$B/chevrons-down-blue-win.png" --out-dir "$B/win" --pngs
```

The **0.68 macOS scale** here is deliberately **small** — three chevrons are a simple mark, and a simple glyph reads oversized next to busier ones (see "Sizing the glyph"). Only the macOS scale is tuned by eye; the **Windows 0.72 is computed** from it (`0.68 × 0.92/0.87`), not chosen. Treat the macOS scale, the plate colors, and the macOS `--top-offset` as this glyph's *chosen* values, not defaults — and the **authoritative record of any icon's parameters is its base README**, not this example.

## Quality: always start at medium

Generate at **`quality=medium`** — candidates are chosen or rejected on concept/composition, not resolution. Use `high` only on the operator's explicit request, never on the AI's own initiative.

## Concurrency

API calls (`generate`, `edit`, `vision`) may run in parallel, ~5 at a time. The local ONNX models (`mask --method ai` ~1–1.5 GB, `upscale` ~4.4 GB) are memory-heavy and must run **strictly one at a time** — running two at once can swap the machine into a crash.

## Why square

Icons are **forced square** (`trim --square`) — the plate and every packed size are square. (A transparent stamp is the opposite and preserves native aspect.)

## Masking: chroma key by default

**Chroma key is the default** — it beats the AI matte on the clean, flat art most glyphs are made of. Generate on a flat chroma backdrop whose key color is **absent from the art** (`#00ff00`, or magenta `#ff00ff` if the glyph contains green), then key it out. Reach for the **AI matte** (`mask --method ai`, BiRefNet) only when a glyph genuinely can't be keyed — wispy/translucent edges, or art that spans every candidate key hue.

## The base (plate)

`backplate` synthesizes the bottom layer: a centered rounded shape filled with a linear gradient on a transparent square canvas.

- `--shape rect` is a circular-arc rounded rectangle; `--shape squircle` is a quarter-superellipse (n=4) corner — a *squarer* look. **For a macOS-matching plate use `rect`, not `squircle`** (see the macOS note below).
- `--from` / `--to` are the gradient endpoints (required); `--angle` is the gradient direction (CSS deg: 0=bottom→top, 90=left→right; default 135° runs `--from` top-left → `--to` bottom-right).
- `--content` is the plate side as a fraction of the canvas; `--radius` is the corner radius as a fraction of the plate side.

**macOS-matching plate:** `--content 0.87 --shape rect --radius 0.305`. These reproduce a real macOS body and corner (measured by circle-fitting system icons): the body fills ~0.87 of the canvas (the rest is the system's shadow margin) and the corner is an essentially circular arc at 0.305 of the body. Use `--shape rect` (an exact circular corner) — **not** `squircle` (an n=4 superellipse, too square to reach macOS roundness).

## Three renderings (macOS, Windows, web)

Build the content once, then make three images from it — they differ only in the `backplate` and the (computed) `layer --scale`, all cheap local composites:

- **macOS** — `--content 0.87 --shape rect --radius 0.305` (rounded plate with a shadow margin) → packed into `icon.icns`.
- **Windows** — fuller plate, `--content 0.92` → packed into `icon.ico` (Windows tiles fill more).
- **Web** — full-bleed plate, `--content 1.0 --radius 0` (background to the edges; the glyph keeps its own margin) → favicon / branding use.

Each platform reads its own file in its own format (a `.app` reads one `.icns`, an `.exe` embeds one `.ico`, the web set is PNG/ICO), so they never share bytes — pack each from the rendering that suits it. The shared sized-PNGs (Linux, tray, runtime) can use the macOS rendering. Only the macOS scale is eyeballed; Windows and Web are computed from it (see "Sizing the glyph").

## Shadow

A soft **contact shadow** under the glyph lifts it off the plate. Cast it on the squared content with `--keep-canvas` so the canvas stays square, sizing the blur/offset to fit within the `trim --square` margin (a `0.10` margin leaves room for a moderate shadow). Then `layer` the shadowed glyph onto the plate. This is a depth cue *on the plate*, not an outer shadow on the icon itself — the OS adds the outer shadow at display time, so do not bake one around the whole plate.

## Sizing the glyph

How large to make the glyph is the one genuinely hard call — there is no exact formula, because **perceived size is multi-factorial**. Don't size by the bounding box (`layer --scale` over-weights sparse glyphs) or by ink area (under-counts open ones); gauge by the **region the glyph appears to occupy** (≈ its convex hull). Then nudge by eye for what geometry misses: a vivid/bright/warm or tall glyph reads larger (size it a touch smaller), a dark/muted or squat one reads smaller (a touch larger). The effect that dominates *across a suite* is **complexity** — see the caveat below.

**Archetype ranges** (as % of the plate body, ~890 px on a 1024 canvas at `--content 0.87`): full-bleed / background-as-shape art ~90–100 %; a symbol on a plate ~55–82 %, with sparse open glyphs near the top of that band and dense solid blocks near the bottom — exactly what the hull metric predicts. Within the range, **eyeball against a familiar reference icon and nudge.**

**Across a suite, complexity outranks hull parity.** The hull metric equalizes perceived size for *one glyph in isolation*; a suite, though, is seen side by side, where complexity takes over. A simple mark sized to the same hull as a busy neighbour reads **too big** — so size **simple glyphs down and busy ones up**, and confirm against the actual neighbours at real Dock size, not by matching hull area. (Dropkick's three chevrons, the simplest mark in its suite, sit *smaller* than the busier card-deck and photo-grid icons beside them — not equal to them. An earlier "equalize hull area" pass oversized them; the fix was to shrink the simple glyph, then re-confirm the others by eye.)

**Tune only the macOS scale by eye — the other platforms are mechanical.** `layer --scale` is measured against the canvas while the plate body is `--content × canvas`, so a glyph's fraction *of its frame* is `scale / content`. Holding that frame-fraction constant across platforms keeps a glyph that is balanced on one sheet balanced on all of them — so fix the **macOS** scale by eye (a small sweep, a `vision` balance check helps, judged against the suite), then **compute** the rest and do *not* re-eyeball them:

- **Windows** (`--content 0.92`): `s_win = s_mac × 0.92/0.87` (≈ × 1.057).
- **Web** (a full-bleed plate, `--content 1.0`): `s_web = s_mac × 1/0.87` (≈ × 1.149). No cap is needed — a macOS glyph never exceeds its plate body, so `s_mac ≤ 0.87` and therefore `s_web ≤ 1.0`, which always fits the canvas; web has no frame, so a full glyph is correct (the content's own trim margin still leaves breathing room).

The optical-centering `--top-offset` transfers the same way — it is the same glyph, so the pixel nudge just scales with the placed size (`scale × canvas`). Only the macOS scale is ever a judgment call.

## Positioning the glyph

Sizing and positioning are **separate decisions on the same `layer` step** — `--scale` sets how big, `--top-offset` sets where. Most glyphs need only the first.

**Optional — skip it by default.** `layer` centers the top image by its bounding box (`--gravity center`). For a glyph whose visual mass is centered in its box — most symmetric marks — that is already right; do nothing. Reach for positioning only when the glyph is **asymmetric in mass**.

**Why box-centering can look off.** When the ink is not centered in its bounding box, the box sits centered but the glyph *looks* shifted toward its heavy side. A downward chevron is heavy at the top (two arms) and tapers to a point, so box-centered it reads **lifted**; an arrow or other leaning mark pulls to one side. Center the **perceived mass** (the alpha centroid), not the box — the positional cousin of the perception effects in "Sizing the glyph."

**Any direction.** Usually a **vertical** nudge — top-heavy → move down, bottom-heavy → up — but it can be **horizontal** (a side-weighted glyph → left/right) or both.

**How — `--top-offset` overrides `--gravity`** and sets the scaled top's absolute top-left corner. Start from the centered position and add the nudge:

```
topW = topH = round(scale × min(baseW, baseH))      # square top
x0   = round((baseW − topW) / 2)                     # centered left
y0   = round((baseH − topH) / 2)                     # centered top
--top-offset (x0 + dx),(y0 + dy)                     # dy>0 down / <0 up; dx>0 right / <0 left
```

**Finding the nudge.** A good starting `dy` is the glyph's alpha-centroid offset from its canvas center, scaled by the layer factor; then **confirm by eye** with a small offset sweep (free, like the scale sweep) over a center crosshair — a touch past the pure centroid often reads best for tapering shapes. Re-confirm whenever the scale changes, since the pixel nudge scales with it.

**Record per app, not here.** Whether positioning was applied and the exact `--top-offset` belong in the app's base README; this recipe describes only the technique. *(Worked example: Dropkick's chevrons at `--scale 0.68` are box-centered at left 164; their mass sits ~19 px high, so a swept-and-confirmed **down 15 px** gives `--top-offset 164,179`.)*

## Normalizing the content size

**The resize rule — enlarge with AI, shrink plainly.** `upscale` (Swin2SR ×4, then resample) is the tool for making art *larger* than its source; `resize` (plain Lanczos) is for making it *smaller*. Always enlarge through the model and always shrink with a plain resample — never the reverse. *Rationale:* the learned model reconstructs detail when enlarging (faithful, and sharper than a plain stretch), but adds **nothing** when shrinking — sending a downscale through the model (×4 up, then back down) yields pixels indistinguishable from a direct Lanczos resample, at the cost of minutes and ~4.4 GB of RAM per image (A/B-verified at 256 px and 64 px on flat glyph art). The split is about cost, not quality.

The glyph's final size on the plate is `layer --scale × plate-side` (for example `0.68 × 1024 ≈ 696 px`), **not** 1024 — `layer` scales the content *down* onto the plate. So normalization is conditional, not a fixed "resize to 1024" step:

- **If the cut-out glyph is already at least its on-plate size — the usual case, since it's generated near 1024 and then scaled down — skip this step.** `layer` downscales it cleanly; there is nothing to enlarge.
- **If the glyph came out smaller than its on-plate size, `upscale` it first** to at least that size. Use the learned ×4 super-resolution for *any* enlargement, however small — never a plain stretch — so `layer` isn't forced to enlarge it with a plain kernel. Never enlarge by re-generating; that changes the art. (`upscale` is one of the two strictly-sequential local models — see "Concurrency".)

The icon master is always the plate size (1024); the content only needs to be crisp at the smaller size it occupies on it, so a glyph born near 1024 needs no upscale at all.

## Iterating bases and sizes cheaply

Only the content generation costs money or time (the chroma mask is a cheap local step). The plate, the gradient, and the glyph scale are **free local composites** — generate the content once, then sweep bases and scales with `backplate` + `layer`. Render a *manageable* grid (not every combination at once), compare, and narrow interactively. "Make the background more vivid" or "try it bigger" is a re-render of the cheap layers, not a new generation. When you do want several content candidates (different designs/styles), generate them in parallel (API calls, ~5 at a time).

These sweep renders are **decision scaffolding** (see "Working conventions"): build a contact sheet or a side-by-side to drive the pick, record the chosen plate and scale in the base README, then keep or drop the extra renders casually. Because each icon uses its **own distinct prompt** rather than micro-variations of one prompt, you converge on one master per platform — there is no numbered series of same-prompt variants to name or retain.

## Multi-size legibility

Before committing, look at the glyph at the sizes it will actually appear. `gptimg icon --pngs` emits the small sizes; open `icon-16.png` and `icon-32.png` and check that the silhouette survives. Thin elements (fine text lines, hairline strokes) vanish at 16 px — that is the moment to catch it, by eye. This is a visual check; vision verdicts add little at icon sizes.

## Verifying

Unlike a transparent stamp cutout, a composited icon is **opaque**, so `gptimg vision` can judge it directly:

```sh
gptimg vision --in "$B/chevrons-down-blue-mac.png" \
  --check "three downward chevrons centered on a rounded gradient plate, well balanced, not cut off, good contrast" \
  --out-name chevrons-down-vision
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
- **Qt — PySide6 / PyQt**: no fixed icon directory. Set the **runtime** window/app icon from a PNG (`app.setWindowIcon(QIcon(...))`, loaded from the package's resources), and hand `icon.icns` / `icon.ico` to whatever packages the app (PyInstaller, briefcase, py2app).
- **Linux / web / generic**: use the loose `icon-<size>.png` set directly.

The master must be **square and ≥1024×1024** (this workflow produces 1024²).

## Working conventions

These keep a session reproducible and debuggable.

- **Stage in the asset library you'll keep the work in** — the target directory you supply (for example `~/code/<repo>/assets/<project>/icons/`), **not** a temp dir. Working in the destination means every step shows up as a reviewable git diff: you can commit (lock) the stable pieces early — the raw generation and its sidecar first — keep iterating on the rest, and prune on request as phases complete. A temp dir is git-invisible and does not survive across sessions, so a human pick that spans sessions would lose its candidates. (`~/.gptimg/` is the tool's own territory — do not stage there.) Get any timestamp from the OS (`date -u`), not from memory.
- **The top level holds raw generations and their sidecars only.** Every other file — masks, cutouts, plates, composites, previews, finals, packed icons — lives in a subdirectory. This keeps the originals (the one paid, irreplaceable artifact) trivially findable.
- **One directory per content candidate; one subdirectory per base.** A "candidate" is a distinct *design* (a different concept or style), named by a descriptive slug. Its shared content prep (`mask`, `cutout`, squared `content`, `shadow`) lives at the candidate level; each base (plate color/shape) gets its own subdirectory holding that base's plate(s) and master(s). The chosen master lives in its base subdirectory — there is no separate "final" folder; a clean filename marks it.
- **Use descriptive slug filenames — no index numbers.** Distinguish candidates by *concept* (`chevrons-down`, `boot-tread`, `bold-monogram`), never `-01` — and because each icon gets its **own distinct prompt** rather than micro-variations of one prompt, there is nothing to enumerate. Work files encode the pipeline role (`chevrons-down-original.png`, `-mask.png`, `-content.png`, `-shadow.png`). When you split mac/Windows masters, the `-mac`/`-win` suffix is a **platform tag, not an index** (`chevrons-down-blue-mac.png`). A few throwaway scale renders while you pick a size are scaffolding — keep only the chosen master and record its scale in the README.
- **If you rename a generated image, fix its sidecar.** The generation sidecar (`<stem>.json`) records the image basename in `files[0].name`; if you rename the PNG you must rename the sidecar *and* update that field, or the image↔sidecar pairing silently breaks. The `sha256` does **not** change — it hashes the bytes, not the name.
- **Keep every raw generation and its sidecar.** The sidecar (`<stem>.json`, written by `generate`) holds the prompt and resolved request — the recipe to reproduce the art. The post-processing verbs (`mask`, `compose`, `trim`, `backplate`, `layer`, `shadow`, `upscale`, `icon`) write **no** sidecars, so record their parameters yourself (see "READMEs").
- **Never destroy a durable artifact.** Renaming on a collision is fine — both files survive. Overwriting is not: you must be able to inspect how anything was made. Previews are work-in-progress and live in the subdirectories like everything else.
- **Sign off on the raw generation before processing it.** Generation is the only paid step and the only one that can be "wrong." If a generation is no good, re-prompt — do not invest the pipeline in a reject.
- **A README at each level.** `<candidate>/README.md` records the raw → content recipe (mask method, trim, shadow, any upscale); `<candidate>/<base>/README.md` records the content → icon recipe (plate `from`/`to`, shape, angle, content fraction, layer scale, chosen size). Free format — enough for another operator to replicate it. These are the human-readable substitute for the sidecars the processing verbs do not emit.
- **Retention is casual and keeper-scoped.** Keep the complete trail of any asset you decide to keep — raw + sidecar, every pipeline intermediate, the plate(s), the master(s), the packed set, and the READMEs. It is fine to keep the **decision scaffolding** too — contact sheets, scale sweeps, comparison montages, legibility strips, size/DPI references, preview composites; disk is cheap and the goal is to have whatever you might want later, not to be tidy. A candidate you reject outright is dropped *whole*. **When asked to clean up**, delete scaffolding first (the renders that only compared options or informed a pick already recorded in a README), then anything clearly redundant — but **never** the durable trail of a keeper (raw + sidecar, the pipeline-stage outputs that reproduce the asset, the master(s), the packs, the READMEs). This is a guide for what is *safe to remove on request*, not a mandate to auto-prune; keep by default.

A staging layout — rooted in the asset library — for two content candidates (two distinct designs), the keeper split into mac/Windows masters:

```
~/code/<repo>/assets/<project>/icons/
  chevrons-down-original.png               # raw + sidecar ONLY at the top level
  chevrons-down-original.json              #   generation sidecar = prompt/provenance
  boot-tread-original.{png,json}          # a second candidate = a different design
  chevrons-down/                           # the kept candidate's shared content prep
    README.md                             #   raw → content recipe
    chevrons-down-mask.png  chevrons-down-cutout.png  chevrons-down-content.png  chevrons-down-shadow.png
    blue/                               # one base (brand plate)
      README.md                           #   content → icon recipe (records the chosen scales + offsets)
      plate-blue-mac.png  plate-blue-win.png
      chevrons-down-blue-mac.png         #   macOS master (0.87 plate, glyph 0.68, down 15px)
      chevrons-down-blue-win.png         #   Windows rendering (0.92 plate, glyph 0.72)
      mac/  icon.icns icon.ico icon.png icon-16.png … icon-1024.png   # pack of the mac master
      win/  icon.icns icon.ico icon.png icon-16.png … icon-1024.png   # pack of the win master
  boot-tread/                             # a rejected candidate is dropped whole
    ...
```

The library keeps gptimg's toolchain-agnostic `icon-NN.png` names; renaming to a framework's names (`32x32.png`, …) happens only when you deploy into the app (see "Packing"). The provenance is the top-level `chevrons-down-original.json`; there is no renamed sidecar copy beside the master — a copy under a new name would break the image↔sidecar pairing (see "If you rename a generated image, fix its sidecar").

## Finalizing and deploying

1. **Pick one combination** (content × base × scale, and a platform master each if you split mac/Windows). Because you staged in the asset library, the keepers and their sidecars and READMEs are already in place — there is nothing to copy; just confirm the chosen master(s) carry clean filenames and the base README records the recipe.
2. **Pack** the master(s) with `icon --pngs` (one `--out-dir` per master) and **rename** the outputs for the target framework (see "Packing").
3. **Deploy** the renamed files into the framework's icon directory and wire them up where required (the Tauri `bundle.icon` list; the .NET `<ApplicationIcon>`), replacing any placeholder.
4. **Confirm the icon shows.** A *built* bundle (`.app` / `.dmg` / `.exe`) carries the new icon directly; a running *dev* session can keep showing a cached old one — on macOS + Tauri especially (see "macOS: refreshing the Dock icon for `tauri dev`" below).

Note an asymmetry with a transparent stamp: a stamp's descriptive slug *is* its deployed filename, but an icon's deployed names are **fixed by the target framework** — the slug only organizes your library. Destination paths are supplied per task, not baked into this workflow.

## macOS: refreshing the Dock icon for `tauri dev`

A *built* bundle shows the new icon immediately; a running `tauri dev` session keeps the **old** Dock tile, because macOS draws it from the last-registered `.app` bundle, not from `src-tauri/icons/`. Rebuild and re-register a bundle (from the app repo root):

```sh
tauri build --debug --bundles app
lsregister -f src-tauri/target/debug/bundle/macos/<App>.app
killall Dock
```

`lsregister` lives at `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister`. If it still sticks, clear the image cache: `sudo rm -rf /Library/Caches/com.apple.iconservices.store && killall Dock Finder`. Other targets don't need this — Windows compiles the icon into the `.exe`, and Electron sets its dev Dock icon at runtime (`app.dock.setIcon`).
