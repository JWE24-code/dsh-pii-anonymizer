/**
 * Deterministic pseudonymization of detected PII — one-way.
 *
 * The same original value always maps to the same placeholder for the lifetime
 * of one pseudonymizer instance (i.e. one session), so the model can reason
 * about a stable pseudonym across turns. The original values are held only in
 * this process, in volatile memory, and are never written to the session log,
 * a model request, or disk. There is deliberately no reverse mapping: nothing
 * can put the values back, which is the point.
 */

import { findPii } from "./detectors.mjs";

/** Build the placeholder for one finding. */
export function makeToken(type, ordinal) {
  return `[[${type}_${ordinal}]]`;
}

export class PiiPseudonymizer {
  /** @type {Map<string, string>} original -> placeholder */
  #forward = new Map();
  /** @type {Map<string, number>} type -> last ordinal issued */
  #counters = new Map();

  /**
   * Replace every detected PII value in `text` with a stable placeholder.
   *
   * @param {string} text
   * @returns {{ text: string, findings: Array<{ type: string, token: string }> }}
   */
  anonymize(text) {
    if (typeof text !== "string" || text.length === 0) {
      return { text, findings: [] };
    }

    const spans = findPii(text);
    if (spans.length === 0) return { text, findings: [] };

    let out = "";
    let cursor = 0;
    const findings = [];
    for (const span of spans) {
      out += text.slice(cursor, span.start);
      let token = this.#forward.get(span.value);
      if (token === undefined) {
        const ordinal = (this.#counters.get(span.type) ?? 0) + 1;
        this.#counters.set(span.type, ordinal);
        token = makeToken(span.type, ordinal);
        this.#forward.set(span.value, token);
      }
      out += token;
      findings.push({ type: span.type, token });
      cursor = span.end;
    }
    out += text.slice(cursor);
    return { text: out, findings };
  }

  /** @returns {number} number of distinct original values seen this session */
  get size() {
    return this.#forward.size;
  }
}

/**
 * Anonymize the text blocks of one human user message, preserving everything
 * else. Harness-injected context (runtime context, skill catalogs, tool
 * results) is deliberately left alone: it is not the user's prompt, and
 * rewriting it can clobber values the agent legitimately needs.
 *
 * @param {{ role?: string, source?: { kind?: string }, content?: unknown }} message
 * @param {PiiPseudonymizer} pseudonymizer
 * @returns {{ message: unknown, findings: Array<{ type: string, token: string }> }}
 */
export function anonymizeMessage(message, pseudonymizer) {
  if (
    message?.role !== "user" ||
    message.source?.kind !== "user" ||
    !Array.isArray(message.content)
  ) {
    return { message, findings: [] };
  }

  const findings = [];
  let changed = false;
  const content = message.content.map((block) => {
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

  if (!changed) return { message, findings: [] };
  return { message: { ...message, content }, findings };
}
