# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-18

### Changed

- **Breaking: placeholder format.** Placeholders are now keyed hashes,
  `[[TYPE_<8 hex>]]` (for example `[[EMAIL_3f9a2c1d]]`), instead of per-session
  ordinals (`[[EMAIL_1]]`). Placeholders produced by 0.1.0 do not carry over:
  anything that stored or matched the old format must be updated.
- Placeholders are stable across sessions and restarts. Each one is
  HMAC-SHA256 over the detector type and the normalized value, keyed with a
  per-install secret at `$DSH_HOME/pii-anonymizer.key` (mode `0600`, created on
  first use). The same value always maps to the same placeholder on one
  install, and different values no longer share one. No value table is kept,
  and the plugin writes nothing raw to disk.
- All listeners register with `prepend: true`, so they run outermost in each
  waterfall.

### Added

- Every message entering a step is anonymized, not only the user's prompt:
  runtime-context snapshots (such as a memory index), workspace instructions,
  recall and relay messages, catalogs and tool-result contexts
  (`agent/pre-step`).
- Tool results are anonymized via `tools/post-execute`: result content, errors
  returned by a tool body, downstream replacements, block feedback and attached
  contexts. Disable with `toolResults: false`.
- The system prompt is anonymized via `system-prompt/assemble`: section text,
  runtime-context text and string prompt variables. Disable with
  `systemPrompt: false`.

### Fixed

- The README no longer claims the values stay local or never reach disk. It
  states that the shield rewrites only what is sent to the provider, that the
  notice is a model-visible user-role message, and lists what is and is not
  covered.
- Removed personal absolute paths from the README and development tools.

### Known gaps

Still sent to the model unrewritten (see the README, "What is and is not
covered"):

- a `complete: true` system-prompt section (restored after the waterfall);
- tool schemas (names, descriptions, parameter schemas);
- tool outcomes finalized without `tools/post-execute` (cancellations, pipeline
  failures) and text added by a tool's own `finalizeContent`;
- PII the detectors cannot recognize (free-form names, postal addresses);
- model output (placeholders are not restored in replies);
- requests other plugins make outside the agent loop from data they read
  themselves.

Local storage (session log, transcript, memory files) keeps the raw values.

## [0.1.0]

- Initial release: deterministic, one-way PII anonymization of the user's
  prompt for the DeepSeek Harness.

[0.2.0]: https://github.com/JWE24-code/dsh-pii-anonymizer/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/dsh-pii-anonymizer/v/0.1.0
