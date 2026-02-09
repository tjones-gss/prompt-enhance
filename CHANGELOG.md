# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] - 2025-02-01

### Added
- Chat participant (`@enhance`) for Cursor/VS Code chat integration.
- Clipboard-to-chat enhancement commands.
- MCP server for Cursor Agent integration (no OpenAI key required).
- Editor context menu entry for "Enhance & Send to Chat".

### Changed
- Upgraded context gathering with ripgrep support and adaptive snippet sizing.

## [0.3.0] - 2025-01-15

### Added
- Clipboard enhancement command.
- Auto-copy enhanced prompt to clipboard setting.

### Changed
- Improved keyword extraction with camelCase splitting and quoted phrase support.

## [0.2.1] - 2025-01-10

### Fixed
- Fixed "command not found" error on activation.
- Improved error handling for missing workspace root.

## [0.2.0] - 2025-01-05

### Added
- OpenAI Responses API support (with Chat Completions fallback).
- Configurable base URL for OpenAI-compatible providers.
- Retry with exponential backoff on transient errors.

### Changed
- Refactored context gathering into shared `core/` modules.

## [0.1.1] - 2024-12-20

### Fixed
- Initial bug fixes for extension activation and command registration.

## [0.1.0] - 2024-12-15

### Added
- Initial release.
- Webview panel for prompt enhancement.
- Editor selection enhancement with `Ctrl+Alt+P`.
- Template-based fallback when no API key is configured.
- Git context and project signal detection.
