# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `encode` verb: re-encodes an image for delivery, as PNG, always lossless, or as WebP, lossy or lossless. Its encoder options, `quality` and `lossless` for WebP and `compressionLevel` and `adaptiveFiltering` for PNG, are passed on only when set, so the encoder's own defaults apply otherwise. `opaque: true` writes no alpha channel and refuses an image with any pixel that is not fully opaque. Every other verb keeps writing PNG as the pipeline's working format.

## [0.1.0] - 2026-07-08

### Added

- First public release.
