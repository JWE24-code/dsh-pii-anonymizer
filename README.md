# dsh-pii-anonymizer

[![dshfind](https://dshfind.com/api/badge/JWE24-code/dsh-pii-anonymizer)](https://dshfind.com/plugins/JWE24-code/dsh-pii-anonymizer)
[![CI](https://github.com/JWE24-code/dsh-pii-anonymizer/actions/workflows/ci.yml/badge.svg)](https://github.com/JWE24-code/dsh-pii-anonymizer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-pii-anonymizer.svg)](https://www.npmjs.com/package/dsh-pii-anonymizer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that replaces **detected PII with stable placeholders in what the model is sent**:
your prompt, the system prompt, runtime context, workspace instructions, recalled
sessions, relayed agent messages, and tool results.

Detection uses fixed rules and checksums (never a model). Every detected value is
replaced with a keyed placeholder such as `[[EMAIL_3f9a2c1d]]` before the request
goes to the provider. The real values do stay on this computer: the host app
commits your message to the local session log exactly as you typed it, and files
and tool outputs on disk are not changed.

```
you type:    email a@x.com or call +31 6 1234 5678
model sees:  email [[EMAIL_6c1f0a9e]] or call [[PHONE_d24b7c03]]
             + a notice: "🔒 PII shield: 2 item(s) in this step's input were
               replaced with placeholders before being sent to the model
               provider (1 EMAIL, 1 PHONE)."
local log:   the message as typed — raw values remain in the local session
             log and transcript.
```

The notice is a **user-role message**: it is shown in your transcript *and* the
model receives it (that is how the harness delivers plugin notices). It carries
only types and counts — never values or placeholders. Turn it off with
`notify: false`.

Anonymization is **one-way**: the plugin keeps no value → placeholder table and
has no restore path, so nothing it holds can put the real values back.

## Where it hooks

Each listener is registered with `prepend: true`, so it is the outermost
listener of its waterfall and rewrites the final value after every other plugin
has contributed.

| Hook (package) | What is rewritten |
| --- | --- |
| `system-prompt/assemble` (`dsh-system-prompt`) | prompt **section** text (e.g. a terminal app's workspace section), runtime-**context** text, and string prompt **variables**. The agent loop renders the assembled contexts into its `form: "snapshot"` user message, so snapshots (e.g. a memory index) are covered here, and the loop's "has the snapshot changed?" check stays stable. |
| `agent/pre-step` (`dsh-agent-loop`) | the text blocks of **every** message entering the step, whatever its source: the user prompt, runtime-context snapshots, workspace instructions (`AGENTS.md`), recalled sessions (`recall`), relayed agent messages (`relay`), skill catalogs, and contexts attached by tool results. |
| `tools/post-execute` (`dsh-tools`) | the tool **result content** the model reads (file reads, grep, shell output, memory reads…), a block decision's feedback, and attached contexts. |

### Why a native plugin, not a hook

The Claude Code / Codex hook bridges **cannot** do this. `HookOutput` in
`@deepseek-ai/dsh-hook-protocol` exposes only `additionalContext`; its
`updatedInput` is documented as *"PARSED but NOT honored."* There is no
prompt-rewrite channel. Only a native Cordis plugin can replace the messages,
prompt, and tool results that enter the model request.

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

A placeholder is `[[TYPE_<hash>]]`, where `<hash>` is the first 8 hex digits of
HMAC-SHA256(key, type + normalized value). Normalization folds trivial spelling
differences (email case, IBAN/card/phone spacing and separators) into one value.

- **Stable everywhere.** The same value gets the same placeholder in every
  session, in subagents, and after a restart, so a placeholder saved into a
  memory or a note keeps meaning the same thing. Different values get different
  placeholders (barring a 32-bit truncation collision).
- **Keyed.** The key is a per-install secret: 32 random bytes in
  `$DSH_HOME/pii-anonymizer.key` (default `~/.dsh/pii-anonymizer.key`), created
  on first use with mode `0600` (an existing file with looser permissions is
  tightened). Without the key, a placeholder cannot be matched against guessed
  values, which matters for low-entropy values such as phone numbers. Keep the
  file private; deleting it changes every placeholder from then on. If the file
  cannot be read or created, the plugin logs a warning and uses a process-only
  key: values are still replaced, but placeholders are not stable across
  restarts.
- **No raw PII on disk.** The key file holds only the random key. The plugin
  keeps no value table and writes no values anywhere.
- **Idempotent.** Existing placeholders are never re-detected, so text that has
  already been rewritten passes through unchanged.

## What is and is not covered

Covered (model-facing text):

- your prompt and every other message entering a step — snapshots, workspace
  instructions, recall, relay, catalogs, tool-result contexts;
- system-prompt sections, runtime-context sections, and string prompt variables;
- tool result content, including errors returned by a tool body.

Not covered:

- **Local storage.** The session log, transcript, memory files, and any file on
  disk keep the raw values; this shield changes only what is sent to the
  provider. The raw values are protected by the file permissions of `$DSH_HOME`
  and nothing else.
- **Undetectable PII.** Free-form names, postal addresses, and other
  context-dependent PII are not detected (see *Detection scope*).
- **A `complete: true` system-prompt section.** `dsh-system-prompt` restores an
  effective complete section from its pre-waterfall text *after* the
  `system-prompt/assemble` waterfall, so a plugin cannot rewrite it.
- **Tool schemas** (tool names, descriptions, parameter schemas) are sent as is.
- **Tool results that skip `tools/post-execute`.** The registry finalizes a
  few outcomes without post-execute — cancellations and pipeline failures (for
  example a throwing `tools/pre-execute` or `tools/execute` listener) — and a
  tool's own `finalizeContent` callback runs after post-execute. Their text
  reaches the model unrewritten. Denials, approval rejections, tool errors and
  successes all pass through post-execute and are covered. A downstream
  post-execute listener that replaces the result's `value` is left alone (the
  registry forbids replacing both value and content).
- **Model output.** The assistant's replies are not rewritten; placeholders are
  not restored in them.
- **Requests made outside the agent loop** by other plugins (for example a
  session-title generator) only see what the loop already rewrote — the title
  request built from your messages receives the placeholders, but a plugin that
  reads raw files itself and calls a model directly is outside this shield.

Rewriting injected context can occasionally hide a value the agent genuinely
needs (for example an IP address in a workspace instruction). Disable the
system-prompt or tool-result rewrite with `systemPrompt: false` or
`toolResults: false` if that matters more to you than the coverage.

## Configuration

```yaml
- id: pii-anonymizer
  name: dsh-pii-anonymizer
  config:
    enabled: true        # master switch
    notify: true         # add the notice message when a step's input had PII
    debug: false         # log load/shield events (counts only, never values)
    systemPrompt: true   # rewrite system prompt + runtime context
    toolResults: true    # rewrite tool result content
    keyFile: ''          # empty = $DSH_HOME/pii-anonymizer.key
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

The package must also be resolvable from the profile, for example by
symlinking the checkout into the shared resolution root:

```sh
ln -s "$PWD" ~/.dsh/profiles/node_modules/dsh-pii-anonymizer
```

Restart the app to load it. Rollback per profile: restore its `package.json.bak`.

## Development

```sh
npm test             # node --test: detectors, keyed pseudonymizer, key file, and
                     # the pre-step / assemble / post-execute rewrites
```

The unit tests import only `src/detectors.mjs`, `src/anonymizer.mjs` and
`src/hooks.mjs`, which have no harness dependencies, so CI needs no install.
`src/index.mjs` imports the harness peers; for local module-load smoke tests,
symlink `node_modules/@deepseek-ai` to the `@deepseek-ai` directory of your
harness install. An installed plugin resolves them from the profile instead.

### End-to-end test (no credentials, no network)

`tools/mock-provider.mjs` is a tiny OpenAI-compatible SSE server; `tools/e2e.patch.yml`
routes the deepseek adapter at it and loads this plugin. A real harness loop then
runs against the mock, and `tools/requests.jsonl` records exactly what the
provider received. With `MOCK_READ_FILE` set, the mock first asks the agent to
`read` that file, so the tool-result path is exercised too.

```sh
# 1. throwaway harness home (never ~/.dsh), with this checkout resolvable
export DSH_HOME=$(mktemp -d)
dsh --profile pitest --from-default-profile headless --dump-config >/dev/null
ln -s "$PWD" "$DSH_HOME/profiles/node_modules/dsh-pii-anonymizer"

# 2. a scratch workspace with PII in an instruction file and a data file
WORK=$(mktemp -d) && git -C "$WORK" init -q
echo 'Owner: owner@corp.example'                 > "$WORK/AGENTS.md"
echo 'customer: c@corp.example +31 6 9876 5432'  > "$WORK/notes.txt"

# 3. mock provider
MOCK_READ_FILE="$WORK/notes.txt" node tools/mock-provider.mjs &

# 4. one real turn
(cd "$WORK" && DSH_E2E_KEY=dummy dsh --profile pitest \
  --patch "$OLDPWD/tools/e2e.patch.yml" "My email is jane.doe@corp.example; read notes.txt")

# 5. confirm the provider only ever saw placeholders
grep -c 'corp.example' tools/requests.jsonl      # expect 0
grep -o '\[\[[A-Z_]*_[0-9a-f]*\]\]' tools/requests.jsonl | sort | uniq -c
```

Verified: across the agent requests and the session-title request, the
provider received placeholders for the prompt email, the `AGENTS.md` email
(workspace instructions), and the email and phone in the `read` tool result;
no `corp.example` value appeared. A second run with the same `DSH_HOME`
produced the identical placeholders, and the runtime-context snapshot was sent
once, not re-sent every step. The raw values do remain in the local session
log, as documented above.

## Status

- [x] Deterministic detectors with checksum validation
- [x] Keyed, cross-session stable placeholders (one-way, no reverse map)
- [x] User prompt and all injected messages (snapshot, instructions, recall,
      relay, catalogs, tool contexts) via `agent/pre-step`
- [x] System prompt, runtime context and variables via `system-prompt/assemble`
- [x] Tool result content via `tools/post-execute`
- [x] Run through a real headless harness against a mock provider
