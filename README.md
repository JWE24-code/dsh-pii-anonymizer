# dsh-pii-anonymizer

[![dshfind](https://dshfind.com/api/badge/JWE24-code/dsh-pii-anonymizer)](https://dshfind.com/plugins/JWE24-code/dsh-pii-anonymizer)
[![CI](https://github.com/JWE24-code/dsh-pii-anonymizer/actions/workflows/ci.yml/badge.svg)](https://github.com/JWE24-code/dsh-pii-anonymizer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-pii-anonymizer.svg)](https://www.npmjs.com/package/dsh-pii-anonymizer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that puts a **deterministic, one-way PII shield at the start of the agent loop**.

Your prompt is scanned by fixed rules and checksums (never by a model) and every
detected value is replaced with a stable placeholder before the message is
committed and sent. The real values live only in process memory — never in the
session log, never on disk, never on the wire. When something is shielded, a
local notice tells you.

```
you type:   email a@x.com or call +31 6 1234 5678
model sees: email [[EMAIL_1]] or call [[PHONE_1]]
you see:    🔒 PII shield: 2 item(s) anonymized locally (1 EMAIL, 1 PHONE).
            Real values did not leave this computer.
```

Anonymization is intentionally **irreversible**: there is no reverse map and no
restore path, so nothing in the system can put the real values back.

## Where it hooks

`agent/pre-step` — the loop's step-admission waterfall
(`@deepseek-ai/dsh-agent`). A listener calls `next()`, maps the returning
`decision.messages` through the anonymizer, and returns a decision whose
`messages` carry the placeholders. That is the last moment before the accepted
user batch is committed and sent to the provider.

### Why a native plugin, not a hook

The Claude Code / Codex hook bridges **cannot** do this. `HookOutput` in
`@deepseek-ai/dsh-hook-protocol` exposes only `additionalContext`; its
`updatedInput` is documented as *"PARSED but NOT honored."* There is no
prompt-rewrite channel. Only a native Cordis plugin on `agent/pre-step` can
replace the messages that enter the model request.

## Detection scope

Deterministic means *structural*. The detectors find things with a grammar or a
checksum:

| Type | Trigger | Validation |
| --- | --- | --- |
| `API_KEY` | known prefixes (`sk-`, `sk-ant-`, `AKIA…`, `ghp_…`, `github_pat_…`, `xox…`, `AIza…`) | — |
| `IBAN` | `CC00…`, compact or space-grouped | **mod-97 checksum** |
| `CREDIT_CARD` | 13–19 digits, spaces/dashes allowed | **Luhn checksum** |
| `SSN` | `DDD-DD-DDDD` | none |
| `EMAIL` | RFC-ish address shape | none |
| `IPV6` / `IPV4` | address shapes | octet range for IPv4 |
| `PHONE` | digit run with `+ ( ) . - space`, optional leading `(`, 7–15 digits | rejects ISO dates and version strings |

Free-form **names, postal addresses, and other context-dependent PII are not
detected** — a deterministic rule cannot catch them without unacceptable false
positives. Adding an ML/NER stage would break the "deterministic" property.

Overlaps are resolved by priority (checksum types beat the loose phone rule),
then span length, then position.

## Pseudonymization model

`PiiPseudonymizer` keeps, per session:

- `forward`: original value → placeholder (stable across turns, so the model can
  keep referring to `[[EMAIL_1]]` consistently)
- per-type ordinals, so tokens read `[[EMAIL_1]]`, `[[PHONE_2]]`, …

There is **no reverse map**. The originals are held only in volatile memory for
the life of the process, so they cannot be restored by anyone, including this
plugin. This is a deliberate trade: the shield is safe by construction at the
cost of the transcript showing placeholders.

### Scope

Only **human user messages** (`source.kind === 'user'`) are rewritten.
Harness-injected context — runtime context, skill catalogs, tool results — is
left untouched, because it is not the user's prompt and redacting it can clobber
values the agent legitimately needs (for example a sandbox host IP).

## Configuration

```yaml
- id: pii-anonymizer
  name: dsh-pii-anonymizer
  config:
    enabled: true   # master switch
    notify: true    # emit the local notice when something was shielded
    debug: false    # log load/shield events (counts only, never values)
```

## Installation (as a bundle)

This package is a DSH **bundle**: `package.json` declares `dsh.bundle.patch`, and
`cordis.patch.yml` inserts the `pii-anonymizer` row. A profile lists it in both
`dependencies` and `dsh.profile.bundles` — which is what the moqi-tui `/plugins`
picker reads (it reads the manifest, not the Cordis loader).

Install it from the registry into a profile:

```sh
npm install dsh-pii-anonymizer          # inside ~/.dsh/profiles/<name>
# or, from the terminal app:
/plugins add dsh-pii-anonymizer
```

`tools/register-profile.mjs <profileDir>` makes the manifest edit for a local
checkout, and writes a `package.json.bak` beside it:

```sh
node tools/register-profile.mjs ~/.dsh/profiles/tui
```

The package must also be resolvable from the profile. On this machine it is
symlinked into the shared resolution root:

```
~/.dsh/profiles/node_modules/dsh-pii-anonymizer -> /home/joeri/Projects/dsh-pii-anonymizer
```

**Install status:** registered and enabled in all six profiles (`dev-tui`,
`headless`, `jev-dev`, `tui`, `tui-dev`, `web`). Restart the app to load it.

Rollback per profile: restore its `package.json.bak`.

## Development

```sh
node --test          # 16 detector + pseudonymizer + message-scope unit tests
```

`node_modules/@deepseek-ai` is a dev-only symlink into the local harness install
so `src/index.mjs` resolves its peer dependencies for module-load smoke tests.
An installed plugin resolves them from the profile instead.

### End-to-end test (no credentials, no network)

`tools/mock-provider.mjs` is a tiny OpenAI-compatible SSE server; `tools/e2e.patch.yml`
routes the deepseek adapter at it and loads this plugin. A real harness loop then
runs against the mock, and `tools/requests.jsonl` records exactly what the
provider received.

```sh
# 1. throwaway harness home inside this project (never ~/.dsh)
DSH_HOME=$PWD/../.dsh-scratch dsh --profile pitest \
  --from-default-profile headless --dump-config

# 2. mock provider
node tools/mock-provider.mjs &          # writes tools/requests.jsonl

# 3. one real turn
DSH_HOME=$PWD/../.dsh-scratch DSH_E2E_KEY=dummy \
  dsh --profile pitest --patch tools/e2e.patch.yml \
  "My email is jane.doe@corp.example and my IBAN is DE89 3704 0044 0532 0130 00"

# 4. confirm the provider only ever saw placeholders
grep -o '\[\[[A-Z_0-9]*\]\]' tools/requests.jsonl | sort -u
```

Verified output: the provider received `My email is [[EMAIL_1]] and my IBAN is
[[IBAN_1]]` plus the `notice`; the raw email and IBAN appear nowhere.

## Status

- [x] Deterministic detectors with checksum validation
- [x] Per-session stable pseudonymization (one-way, no reverse map)
- [x] Human-message scoping (injected context left intact)
- [x] `agent/pre-step` wiring — unit-simulated **and** run through a real
      headless harness against a mock provider
- [x] Local `notice` to the user
- [x] Installed as a bundle in all six profiles, listed and enabled in the
      `/plugins` picker
