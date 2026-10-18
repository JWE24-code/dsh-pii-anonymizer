/**
 * Deterministic, keyed, one-way pseudonymization of detected PII.
 *
 * A placeholder is derived from the value itself: `[[TYPE_<hmac>]]`, where
 * `<hmac>` is the first {@link TOKEN_HEX_LENGTH} hex digits of
 * HMAC-SHA256(key, TYPE + NUL + normalized value). With the same key the same
 * value therefore maps to the same placeholder in every session, in every
 * process, and after a restart — so a placeholder saved into a memory or a file
 * keeps meaning the same thing. Different values get different placeholders
 * (up to a negligible 32-bit truncation collision).
 *
 * The key is a per-install secret kept locally (see {@link loadOrCreateKey}).
 * Without it a placeholder cannot be linked back to a guessed value, which is
 * what stops a low-entropy value (a phone number, an SSN) from being
 * brute-forced out of its token.
 *
 * Nothing here keeps a value → placeholder table: there is no reverse map, and
 * no raw value is written anywhere by this module.
 */

import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { findPii } from "./detectors.mjs";

/** Hex digits of the keyed hash that end up in a placeholder. */
export const TOKEN_HEX_LENGTH = 8;

/** Matches a placeholder this module produced (or the old `[[TYPE_n]]` form). */
const PLACEHOLDER_RE = /\[\[[A-Z][A-Z0-9_]*_[0-9a-f]+\]\]/g;

/** File name of the per-install key under `$DSH_HOME`. */
export const KEY_FILE_NAME = "pii-anonymizer.key";

/** Build the placeholder for one value hash. */
export function makeToken(type, hash) {
  return `[[${type}_${hash}]]`;
}

/**
 * Canonical form of a detected value, so trivially different spellings of the
 * same identifier (spacing, case, separators) share one placeholder.
 *
 * @param {string} type
 * @param {string} value
 * @returns {string}
 */
export function normalizeValue(type, value) {
  switch (type) {
    case "EMAIL":
    case "IPV6":
      return value.toLowerCase();
    case "IBAN":
      return value.replace(/\s+/g, "").toUpperCase();
    case "CREDIT_CARD":
    case "SSN":
      return value.replace(/\D/g, "");
    case "PHONE": {
      const digits = value.replace(/\D/g, "");
      return value.trim().replace(/^\(/, "").startsWith("+") ? `+${digits}` : digits;
    }
    default:
      return value;
  }
}

/**
 * The default key location: `$DSH_HOME/pii-anonymizer.key`, where a blank or
 * unset `$DSH_HOME` means `~/.dsh` (the harness's own precedence).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultKeyPath(env = process.env) {
  const fromEnv = env.DSH_HOME?.trim();
  const home = fromEnv ? fromEnv : join(homedir(), ".dsh");
  return join(home, KEY_FILE_NAME);
}

/** @param {Buffer} raw */
function parseKey(raw) {
  const text = raw.toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(text)) {
    throw new Error("pii-anonymizer key file is not 64 hex characters");
  }
  return Buffer.from(text, "hex");
}

/**
 * Read the per-install key, creating it (32 random bytes, hex, mode 0600) on
 * first use. An existing file with looser permissions is tightened to 0600.
 * Creation is exclusive, so two processes racing on first use agree on one key.
 *
 * @param {string} [path]
 * @returns {Buffer}
 */
export function loadOrCreateKey(path = defaultKeyPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (fd !== undefined) {
    try {
      writeSync(fd, `${randomBytes(32).toString("hex")}\n`);
    } finally {
      closeSync(fd);
    }
  }
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  return parseKey(readFileSync(path));
}

/** Ranges of existing placeholders, which must never be re-detected. */
function placeholderRanges(text) {
  const ranges = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER_RE.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export class PiiPseudonymizer {
  /** @type {Buffer | undefined} */
  #key;
  /** @type {() => Buffer} */
  #keySource;
  /** @type {Set<string>} distinct placeholders issued (no raw values) */
  #issued = new Set();

  /**
   * @param {{ key?: Buffer | string, keyPath?: string, keySource?: () => Buffer }} [options]
   *   — a key (Buffer, or 64 hex chars) to use as is, a function producing it,
   *   or the file to load/create it from. The key is resolved lazily, on the
   *   first value that needs it.
   */
  constructor(options = {}) {
    if (typeof options.keySource === "function") {
      this.#keySource = options.keySource;
    } else if (options.key !== undefined) {
      const key = Buffer.isBuffer(options.key) ? options.key : Buffer.from(options.key, "hex");
      if (key.length < 16) throw new Error("pii-anonymizer key must be at least 16 bytes");
      this.#keySource = () => key;
    } else {
      const keyPath = options.keyPath ?? defaultKeyPath();
      this.#keySource = () => loadOrCreateKey(keyPath);
    }
  }

  /** The keyed placeholder for one value. */
  tokenFor(type, value) {
    this.#key ??= this.#keySource();
    const hash = createHmac("sha256", this.#key)
      .update(`${type}\u0000${normalizeValue(type, value)}`)
      .digest("hex")
      .slice(0, TOKEN_HEX_LENGTH);
    return makeToken(type, hash);
  }

  /**
   * Replace every detected PII value in `text` with its keyed placeholder.
   * Idempotent: placeholders already present are left exactly as they are.
   *
   * @param {string} text
   * @returns {{ text: string, findings: Array<{ type: string, token: string }> }}
   */
  anonymize(text) {
    if (typeof text !== "string" || text.length === 0) {
      return { text, findings: [] };
    }

    const protectedRanges = placeholderRanges(text);
    const spans = findPii(text).filter(
      (span) => !protectedRanges.some(([start, end]) => span.start < end && start < span.end),
    );
    if (spans.length === 0) return { text, findings: [] };

    let out = "";
    let cursor = 0;
    const findings = [];
    for (const span of spans) {
      out += text.slice(cursor, span.start);
      const token = this.tokenFor(span.type, span.value);
      this.#issued.add(token);
      out += token;
      findings.push({ type: span.type, token });
      cursor = span.end;
    }
    out += text.slice(cursor);
    return { text: out, findings };
  }

  /** @returns {number} distinct placeholders issued by this instance */
  get size() {
    return this.#issued.size;
  }
}

/**
 * Anonymize an array of content blocks: `text` blocks are rewritten, every
 * other block (images, attachments) is kept as is.
 *
 * @param {unknown[]} content
 * @param {PiiPseudonymizer} pseudonymizer
 * @returns {{ content: unknown[], findings: Array<{ type: string, token: string }>, changed: boolean }}
 */
export function anonymizeContent(content, pseudonymizer) {
  const findings = [];
  let changed = false;
  const out = content.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") {
      const result = pseudonymizer.anonymize(block.text);
      if (result.findings.length > 0) {
        changed = true;
        findings.push(...result.findings);
        return { ...block, text: result.text };
      }
    }
    return block;
  });
  return { content: changed ? out : content, findings, changed };
}

/**
 * Anonymize the text blocks of any message the model is about to receive,
 * whatever its source: the user's prompt, runtime-context snapshots, workspace
 * instructions, recalled sessions, relayed agent messages, tool-result
 * contexts. Everything other than text is preserved.
 *
 * @param {{ content?: unknown }} message
 * @param {PiiPseudonymizer} pseudonymizer
 * @returns {{ message: unknown, findings: Array<{ type: string, token: string }> }}
 */
export function anonymizeMessage(message, pseudonymizer) {
  if (!Array.isArray(message?.content)) return { message, findings: [] };
  const result = anonymizeContent(message.content, pseudonymizer);
  if (!result.changed) return { message, findings: [] };
  return { message: { ...message, content: result.content }, findings: result.findings };
}
