# Changelog

All notable changes to GptImgSdk (`gptimgsdk`) are documented in this file. It records every change to a persisted format, an error or result code, or a public signature.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The SDK is the workspace package `gptimgsdk` in `packages/gptimgsdk/` of the GptImg repository, imported by that name; the repository root is the GptImg app package.
- The source runs on plain Node 24.12 or later with type stripping: no `tsx` or other loader is needed.

## [0.1.0] - 2026-07-08

### Added

- First public release, as the package `gptimg`.
