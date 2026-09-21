# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `encode` verb: re-encodes an image for delivery, as PNG at the strongest lossless compression or as WebP, lossy or lossless. `opaque: true` writes no alpha channel and refuses an image with any pixel that is not fully opaque. Every other verb keeps writing PNG as the pipeline's working format.

### Changed

- `icon` writes its loose PNGs, `icon.png` and the `pngs` set, with the same lossless delivery encoding as `encode`: every pixel is unchanged and the files are about a third smaller on real art. The `.icns` and `.ico` are byte-for-byte as before, since their encoder already compresses its PNG entries at the strongest level; `icon` now hands it the rendered pixels instead of a PNG it would only decode again.

## [0.1.0] - 2026-07-08

### Added

- First public release.
