# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.1] - 2026-02-09

### Changed
- Replaced `vscode.lm` backend with Cursor CLI (`agent -p --mode=ask`) for AI-powered enhancement. Uses your existing Cursor subscription models -- no API key required.
- Prompt is piped via stdin to avoid Windows argument-length limits on long prompts.
- Added `findAgentCLI()` helper that auto-discovers the CLI with result caching.
- Added one-time "Install Cursor CLI" notification when the CLI is not found.
- Updated backend label from "Cursor LM" to "Cursor CLI" in webview, notifications, and chat participant.

### Fixed
- AI-powered enhancement now actually works in Cursor IDE (the previous `vscode.lm` API is not supported by Cursor).

## [0.5.0] - 2025-02-09

### Added
- Editor-native language model support via `vscode.lm` API (Cursor / Copilot).
- Zero-config experience: works out of the box in Cursor with no API key.
- New `preferEditorLM` setting to control backend priority.
- Backend indicator in webview, notifications, and chat participant (Cursor LM / OpenAI / Template).

### Changed
- Enhancement pipeline now tries Cursor LM first, then OpenAI, then template fallback.
- Return type includes `backend` field ("cursor", "openai", or "template") alongside existing `usedLLM` boolean.

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
