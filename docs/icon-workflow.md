# Icon Workflow

An **app icon** is a square master image packed into the platform formats a desktop toolchain consumes: `icon.icns` (macOS), `icon.ico` (Windows), and sized PNGs (Linux/web/store). This document is a complete, self-contained recipe for producing one with `gptimg`: generate the glyph art, remove its background, set it on a gradient plate, size it to *look* right, and pack the platform files.

> **Scope.** `gptimg` performs the **imaging operations** and writes outputs to the paths you give it. It does not know which framework will consume them or how files must be named for it — that placement and renaming is the operator's job (see "Packing"). The conventions below are a reliable way to drive it, but every destination path is yours to supply.

Target formats this produces for: **Tauri** (`src-tauri/icons/` with framework-specific filenames), **Electron** (`build/icon.icns` + `build/icon.ico` via electron-builder), **Avalonia / .NET** (`<ApplicationIcon>` pointing at an `.ico`), **Qt** (PySide6/PyQt — a runtime PNG via `QIcon` plus `.icns`/`.ico` for the packager), and any toolchain that wants a loose sized-PNG set.

## The pipeline

```
generate content → mask → compose → trim --square → [upscale if below on-plate size] → shadow → backplate → layer → icon → rename
```

A worked example — a real run this workflow was validated on (a cluster of fanned note panels; substitute any glyph). It stages **directly in the asset library** so every step is a reviewable git diff (see "Working conventions"):

```sh
# Stage in the library path you'll keep this in — NOT a temp dir.
ICONS=~/code/<repo>/assets/<project>/icons
mkdir -p "$ICONS/fanned-panes/indigo"

# 1. Generate the glyph on a chroma backdrop whose key color is absent from the
#    art (these panes have no green, so #00ff00 is safe), at MEDIUM quality.
#    Pass an absolute --out-dir so a paid generation lands where you expect.
gptimg generate \
  "A modern flat app-icon illustration: three overlapping rounded-rectangle note \
   panels fanned like a hand of cards, vivid coral, teal and amber, flat vector \
   style, centered, on a solid pure green #00ff00 background, no green on the \
   panels, no shadow, no real words" \
  --set size=1024x1024 --set chroma.color=#00ff00 --set quality=medium \
  --out-dir "$ICONS" --out-name fanned-panes-original

ORIG="$ICONS/fanned-panes-original.png"
C="$ICONS/fanned-panes"            # candidate dir = shared content prep
B="$C/indigo"                      # base dir = one brand plate

# 2. Shared content prep (used by BOTH platform masters): key out the backdrop,
#    square the glyph with a shadow margin, cast a contact shadow inside the canvas.
gptimg mask    --in "$ORIG" --key from-sidecar --out-dir "$C" --out-name fanned-panes-mask.png
gptimg compose --in "$ORIG" --mask "$C/fanned-panes-mask.png" --remove-bleed "#00ff00" --out-dir "$C" --out-name fanned-panes-cutout.png
gptimg trim    --in "$C/fanned-panes-cutout.png" --square --margin 0.10 --out-dir "$C" --out-name fanned-panes-content.png
gptimg shadow  --in "$C/fanned-panes-content.png" --keep-canvas --blur 24 --offset 0,18 \
  --opacity 0.32 --color "#0a0a20" --out-dir "$C" --out-name fanned-panes-shadow.png
#    A glyph generated near 1024 is already larger than its on-plate size, so no
#    upscale is needed here — see "Normalizing the content size".

# 3. Two platform masters from the one content — only the plate --content and the
#    layer --scale differ (see "Two platforms, two masters" and "Sizing the glyph").
#    Corner `--radius 0.305` and `--content 0.87` are *measured* from real macOS
#    system icons (see "The base (plate)"); the `squircle` shape is squarer and is
#    the wrong tool here.
#    macOS: 0.87 plate, glyph at 0.78.
gptimg backplate --size 1024 --from "#4f46e5" --to "#1e1b4b" --shape rect --radius 0.305 --content 0.87 --out-dir "$B" --out-name plate-indigo-mac.png
gptimg layer --base "$B/plate-indigo-mac.png" --top "$C/fanned-panes-shadow.png" --scale 0.78 --out-dir "$B" --out-name fanned-panes-indigo-mac.png
#    Windows: fuller 0.92 plate, glyph at 0.86 so it fills the tile.
gptimg backplate --size 1024 --from "#4f46e5" --to "#1e1b4b" --shape rect --radius 0.305 --content 0.92 --out-dir "$B" --out-name plate-indigo-win.png
gptimg layer --base "$B/plate-indigo-win.png" --top "$C/fanned-panes-shadow.png" --scale 0.86 --out-dir "$B" --out-name fanned-panes-indigo-win.png

# 4. Pack each master into its own subdir (so icon.icns/icon.ico don't collide),
#    then cherry-pick per target at deploy time (see "Packing").
gptimg icon --in "$B/fanned-panes-indigo-mac.png" --out-dir "$B/mac" --pngs
gptimg icon --in "$B/fanned-panes-indigo-win.png" --out-dir "$B/win" --pngs
```

The 0.78 / 0.86 scales are **starting points that read right for this glyph**, not fixed numbers — tune them by eye per the art's design, color, and style (see "Sizing the glyph").

## Quality: always start at medium

Always generate at **`quality=medium`**. `high` is significantly more expensive, and the overwhelming majority of icon candidates are discarded for *what they contain and how* — concept, composition, balance — not for resolution. Use `high` **only when the operator explicitly asks for it** after judging a specific medium render insufficient — never on the AI's own initiative.

## Concurrency

- **API calls** — `generate`, `edit`, `vision` — are network-bound and may run **in parallel**, around **5 at a time**, which speeds up generating a batch of candidates.
- **Local ONNX models** — `mask --method ai` (BiRefNet) and `upscale` (Swin2SR) — load large amounts of native memory (BiRefNet ~1–1.5 GB, Swin2SR up to ~4.4 GB) and must run **strictly one at a time**. Never run two in parallel; it can drive the machine into swap and crash the desktop session.

## Why square (and why this differs from a stamp)

Icons are **forced square** — `trim --square` extends the shorter axis with transparent pixels so the glyph sits on a square canvas, because the plate and every packed size are square. (A transparent overlay stamp is the opposite: there, forcing square would bake dead side-space onto tall or wide subjects, so stamps preserve native aspect.) Use `--square` for icons.

## Masking: chroma key by default

As with stamps, **chroma key is the default** — it reliably beats the AI matte on the clean, flat art most glyphs are made of (the AI matte tends to *add* edge problems on simple subjects). Generate the glyph on a flat chroma backdrop whose key color is **absent from the art**: `#00ff00` for most glyphs, or magenta `#ff00ff` / another unused hue if the glyph contains green. Then key it out, exactly like a stamp.

Reach for the **AI matte** (`mask --method ai`, BiRefNet, generated on a plain neutral background instead) only in the narrow cases where a glyph genuinely can't be keyed: **wispy or translucent** fine fibers/fur (a solid, well-defined or stylized fur silhouette keys fine with chroma — reach for the matte only when the edge is genuinely wispy), or colors that unavoidably span every candidate key hue. It is heavy (~1–1.5 GB RAM, run one at a time — see "Concurrency"; pre-fetch with `gptimg model install birefnet`).

## The base (plate)

`backplate` synthesizes the bottom layer: a centered rounded shape filled with a linear gradient on a transparent square canvas.

- `--shape rect` is a circular-arc rounded rectangle; `--shape squircle` is a quarter-superellipse (n=4) corner — a *squarer* look. **For a macOS-matching plate use `rect`, not `squircle`** (see the macOS note below).
- `--from` / `--to` are the gradient endpoints (required); `--angle` is the gradient direction (CSS deg: 0=bottom→top, 90=left→right; default 135° runs `--from` top-left → `--to` bottom-right).
- `--content` is the plate side as a fraction of the canvas; `--radius` is the corner radius as a fraction of the plate side.

**Matching the macOS corner — measured, not guessed.** Both numbers below come from circle-fitting ten real macOS system icons (App Store, Music, Notes, Photos, Reminders, …) at native resolution:

- **`--content 0.87`** — macOS bodies fill ~0.86–0.875 of the canvas (the small remaining margin is the system's space for the drop shadow). The often-quoted "0.80 grid" is *too small*: a 0.80 icon reads visibly smaller than its neighbours in the Dock.
- **`--shape rect --radius 0.305`** — the macOS corner circle-fits to **0.304 ± 0.01 of the body** with a ~1 % residual, i.e. it is essentially a **circular** arc at that radius. gptimg's `rect` produces a mathematically exact circular corner (`radius × body`, verified), so `rect 0.305` reproduces it.

Two traps that cost real time here: (1) the often-cited "~22.5 % radius" figure is only where the corner *starts*, not its roundness — `rect 0.225` reads too square; and (2) a *diagonal/silhouette* fit overshoots badly (it pushed an earlier guess to 0.38, which renders as a near-circle "ball") — **circle-fit the corner arc instead**. (3) `--shape squircle` is an n=4 superellipse — squarer than macOS and unable to reach 0.30 roundness at any radius, so it is the wrong tool despite the name.

## Two platforms, two masters

The macOS body (~0.87 of the canvas) looks correct on macOS but a touch *small* in a full-bleed Windows context, where icons typically fill their tile. Do not force one compromise master onto both — **make a master per platform**, because the two platforms read **separate files in separate formats** and never share bytes:

- a **macOS master** with `--content 0.87 --shape rect --radius 0.305` → packed into **`icon.icns`** (what a `.app` bundle reads),
- a **Windows master** with a fuller plate (raise `--content` toward `0.90`–`1.0`, optionally `--shape rect`) → packed into **`icon.ico`** (what an `.exe` embeds).

A `.app` reads exactly one `.icns` and an `.exe` embeds one `.ico`, so each bundle already gets its own file — you simply pack each from the master that suits it. Cross-platform bundlers (Tauri, Electron) reference `.icns` and `.ico` independently, so providing a mac-tuned `icon.icns` and a win-tuned `icon.ico` is all that's required. The shared sized-PNGs (Linux, tray, window-runtime) use one master of your choice — the macOS one is a fine default. Build the content once; only the `backplate`/`layer` steps differ per platform, and those are cheap local composites.

## Shadow

A soft **contact shadow** under the glyph lifts it off the plate. Cast it on the squared content with `--keep-canvas` so the canvas stays square, sizing the blur/offset to fit within the `trim --square` margin (a `0.10` margin leaves room for a moderate shadow). Then `layer` the shadowed glyph onto the plate. This is a depth cue *on the plate*, not an outer shadow on the icon itself — the OS adds the outer shadow at display time, so do not bake one around the whole plate.

## Sizing the glyph

How large to make the glyph on the plate is the one genuinely hard call. There is no exact formula, because **perceived size is multi-factorial** — at least four separable effects drive it:

1. **Visual mass / area** — how much of the region is actually filled.
2. **Extent / elongation** — a longer shape reads larger at a glance (the *elongation bias*); for equal area the elongated one looks bigger.
3. **Orientation** — vertical extent reads ~5–10 % longer than the same physical horizontal extent (the *horizontal–vertical illusion*).
4. **Color / contrast / brightness** — a vivid, bright, warm, high-contrast glyph reads **larger** (and is more appealing) than a dark, muted one of identical geometry (the *irradiation illusion*: a light shape on a dark field looks bigger than a dark shape on a light field).

So no single number is authoritative — what follows is a **starting point to adjust by eye**, not a rule, and deliberately not encoded in `gptimg`.

**Judge apparent size by the region the glyph occupies — not its bounding box, and not its ink.** `layer --scale` sizes the top image by its longer edge (the bounding box), which over-weights sparse glyphs: a fanned cluster whose box is mostly empty reads far smaller than its box. Filled-alpha area is the opposite error — it under-counts open glyphs and penalizes solid blocks (an outline and a filled square of the same box look about as big but hold very different ink). The fair middle is the **convex-hull area** — the region the eye perceives a shape to occupy, because the visual system completes internal gaps (*Gestalt closure*). So gauge apparent size by **√(convex-hull area)**, not by `--scale` alone. (Material and Apple arrive at the same place from the other direction: instead of one bounding box they define per-shape keylines so different shapes *look* equally large.)

**Hull area is only geometry, and perception is not** — it ignores effects (3) and (4). A vivid/bright/warm glyph reads larger than a dark/muted one of the same hull, and a tall glyph larger than a squat one. So treat any area-derived size as a floor and nudge by eye: vivid or elongated art can sit a little smaller, dark/muted or squat art a little larger.

**Archetype ranges** (as % of the plate body, ~890 px on a 1024 canvas at `--content 0.87`): full-bleed / background-as-shape art ~90–100 %; a symbol on a plate ~55–82 %, with sparse open glyphs near the top of that band and dense solid blocks near the bottom — exactly what the hull metric predicts. Within the range, **eyeball against a familiar reference icon and nudge.**

**Confirm per icon — never ship the starting number unexamined.** Render a small sweep (a few percentages per platform), judge by eye (a `vision` balance check helps), and choose the macOS and Windows percentages separately: the fuller Windows plate (`--content 0.92`) wants a proportionally larger glyph, ≈ mac scale × 0.92/0.87.

## Normalizing the content size

The glyph's final size on the plate is `layer --scale × plate-side` (for example `0.78 × 1024 ≈ 800 px`), **not** 1024 — `layer` scales the content *down* onto the plate. So normalization is conditional, not a fixed "resize to 1024" step:

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
gptimg vision --in "$B/fanned-panes-indigo-mac.png" \
  --check "one centered glyph on a rounded gradient plate, well balanced, not cut off, good contrast" \
  --out-name fanned-panes-vision
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
- **Use descriptive slug filenames — no index numbers.** Distinguish candidates by *concept* (`fanned-panes`, `side-panes`, `bold-monogram`), never `-01` — and because each icon gets its **own distinct prompt** rather than micro-variations of one prompt, there is nothing to enumerate. Work files encode the pipeline role (`fanned-panes-original.png`, `-mask.png`, `-content.png`, `-shadow.png`). When you split mac/Windows masters, the `-mac`/`-win` suffix is a **platform tag, not an index** (`fanned-panes-indigo-mac.png`). A few throwaway scale renders while you pick a size are scaffolding — keep only the chosen master and record its scale in the README.
- **If you rename a generated image, fix its sidecar.** The generation sidecar (`<stem>.json`) records the image basename in `files[0].name`; if you rename the PNG you must rename the sidecar *and* update that field, or the image↔sidecar pairing silently breaks. The `sha256` does **not** change — it hashes the bytes, not the name.
- **Keep every raw generation and its sidecar.** The sidecar (`<stem>.json`, written by `generate`) holds the prompt and resolved request — the recipe to reproduce the art. The post-processing verbs (`mask`, `compose`, `trim`, `backplate`, `layer`, `shadow`, `upscale`, `icon`) write **no** sidecars, so record their parameters yourself (see "READMEs").
- **Never destroy a durable artifact.** Renaming on a collision is fine — both files survive. Overwriting is not: you must be able to inspect how anything was made. Previews are work-in-progress and live in the subdirectories like everything else.
- **Sign off on the raw generation before processing it.** Generation is the only paid step and the only one that can be "wrong." If a generation is no good, re-prompt — do not invest the pipeline in a reject.
- **A README at each level.** `<candidate>/README.md` records the raw → content recipe (mask method, trim, shadow, any upscale); `<candidate>/<base>/README.md` records the content → icon recipe (plate `from`/`to`, shape, angle, content fraction, layer scale, chosen size). Free format — enough for another operator to replicate it. These are the human-readable substitute for the sidecars the processing verbs do not emit.
- **Retention is casual and keeper-scoped.** Keep the complete trail of any asset you decide to keep — raw + sidecar, every pipeline intermediate, the plate(s), the master(s), the packed set, and the READMEs. It is fine to keep the **decision scaffolding** too — contact sheets, scale sweeps, comparison montages, legibility strips, size/DPI references, preview composites; disk is cheap and the goal is to have whatever you might want later, not to be tidy. A candidate you reject outright is dropped *whole*. **When asked to clean up**, delete scaffolding first (the renders that only compared options or informed a pick already recorded in a README), then anything clearly redundant — but **never** the durable trail of a keeper (raw + sidecar, the pipeline-stage outputs that reproduce the asset, the master(s), the packs, the READMEs). This is a guide for what is *safe to remove on request*, not a mandate to auto-prune; keep by default.

A staging layout — rooted in the asset library — for two content candidates (two distinct designs), the keeper split into mac/Windows masters:

```
~/code/<repo>/assets/<project>/icons/
  fanned-panes-original.png               # raw + sidecar ONLY at the top level
  fanned-panes-original.json              #   generation sidecar = prompt/provenance
  side-panes-original.{png,json}          # a second candidate = a different design
  fanned-panes/                           # the kept candidate's shared content prep
    README.md                             #   raw → content recipe
    fanned-panes-mask.png  fanned-panes-cutout.png  fanned-panes-content.png  fanned-panes-shadow.png
    indigo/                               # one base (brand plate)
      README.md                           #   content → icon recipe (records the chosen scales)
      plate-indigo-mac.png  plate-indigo-win.png
      fanned-panes-indigo-mac.png         #   macOS master (0.87 plate, glyph 0.78)
      fanned-panes-indigo-win.png         #   Windows master (0.92 plate, glyph 0.86)
      mac/  icon.icns icon.ico icon.png icon-16.png … icon-1024.png   # pack of the mac master
      win/  icon.icns icon.ico icon.png icon-16.png … icon-1024.png   # pack of the win master
  side-panes/                             # a rejected candidate is dropped whole
    ...
```

The library keeps gptimg's toolchain-agnostic `icon-NN.png` names; renaming to a framework's names (`32x32.png`, …) happens only when you deploy into the app (see "Packing"). The provenance is the top-level `fanned-panes-original.json`; there is no renamed sidecar copy beside the master — a copy under a new name would break the image↔sidecar pairing (see "If you rename a generated image, fix its sidecar").

## Finalizing and deploying

1. **Pick one combination** (content × base × scale, and a platform master each if you split mac/Windows). Because you staged in the asset library, the keepers and their sidecars and READMEs are already in place — there is nothing to copy; just confirm the chosen master(s) carry clean filenames and the base README records the recipe.
2. **Pack** the master(s) with `icon --pngs` (one `--out-dir` per master) and **rename** the outputs for the target framework (see "Packing").
3. **Deploy** the renamed files into the framework's icon directory and wire them up where required (the Tauri `bundle.icon` list; the .NET `<ApplicationIcon>`), replacing any placeholder.
4. **Confirm the icon shows.** A *built* bundle (`.app` / `.dmg` / `.exe`) carries the new icon directly; a running *dev* session can keep showing a cached old one — on macOS + Tauri especially (see "macOS: refreshing the Dock icon for `tauri dev`" below).

Note an asymmetry with a transparent stamp: a stamp's descriptive slug *is* its deployed filename, but an icon's deployed names are **fixed by the target framework** — the slug only organizes your library. Destination paths are supplied per task, not baked into this workflow.

## macOS: refreshing the Dock icon for `tauri dev`

A *built* bundle embeds the icon, so a freshly built `.app`, `.dmg`, or Windows `.exe` shows the new art immediately. A running **dev** session often does not — the OS caches the app's icon — and this bites hardest on **macOS + Tauri**.

`tauri dev` runs the bare debug binary, and macOS draws the Dock tile from the **registered `.app` bundle** for the app's bundle id (cached from the last `tauri build`), not from the binary or from `src-tauri/icons/`. So a changed icon keeps showing the old art in dev, and `killall Dock` alone won't refresh it. Rebuild a bundle that carries the new icon and re-register it — run from the app repo root, substituting your app name for `<App>`:

```sh
tauri build --debug --bundles app        # debug profile, .app only — fast, skips the .dmg
lsregister -f src-tauri/target/debug/bundle/macos/<App>.app
killall Dock
```

`lsregister` is not on `PATH`; it lives at `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister`. After this, `tauri dev` resolves its Dock tile through the freshly-registered bundle. If the old icon still sticks — the deeper, image-level IconServices cache — clear that (regenerable) cache and relaunch the UI:

```sh
sudo rm -rf /Library/Caches/com.apple.iconservices.store && killall Dock Finder
```

The other targets don't need this: **Windows** compiles the icon into the `.exe`, so rebuilding the debug binary already carries it; **Electron** sets its dev Dock icon at runtime (`app.dock.setIcon`), so refreshing that runtime image is enough.
