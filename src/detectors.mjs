/**
 * Deterministic, rule-based PII detectors.
 *
 * There is no model inference anywhere in this file: every match comes from a
 * fixed regular expression plus an optional checksum validator. The same input
 * therefore always produces the same findings, in the same order, on every
 * machine and every run.
 *
 * Scope is deliberately limited to structurally-identifiable PII (things with a
 * grammar or a checksum). Free-form names, postal addresses, and similar
 * context-dependent values are NOT detected here, because a deterministic rule
 * cannot find them without unacceptable false positives. See README.
 */

/** Credit-card-shaped digit runs; the Luhn check does the real work. */
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
/**
 * IBAN shape, compact or space-grouped. Grouping is modelled as 4-character
 * groups with an optional 1–4 character tail, which covers every valid IBAN
 * length without letting a trailing word be swallowed; mod-97 does the rest.
 */
const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
/** US Social Security number. */
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
/** Email address. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
/** Dotted-quad IPv4. */
const IPV4_RE =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
/** Full IPv6 form. */
const IPV6_FULL_RE = /\b(?:[0-9A-Fa-f]{1,4}:){2,7}(?:[0-9A-Fa-f]{1,4})?\b/g;
/** Compressed `::` IPv6 form. */
const IPV6_COMPRESSED_RE = /\b::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}\b/g;
/**
 * Phone-shaped run. Intentionally the loosest detector; `validatePhone` rejects
 * dates, versions, and the like after the regex has fired.
 */
const PHONE_RE = /(?<![\w.])(\(?\+?\d[\d()\s.-]{5,}\d)(?![\w.])/g;
/**
 * Well-known credential prefixes, one regex per family. Separate patterns
 * rather than one large alternation so each stays simple enough for static
 * analysis to reason about; all share the `API_KEY` type and priority.
 */
const API_KEY_PATTERNS = [
  /\bsk-(?:ant-)?[\w-]{16,}\b/g, // OpenAI / Anthropic
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_\w{20,}\b/g, // GitHub tokens
  /\bgithub_pat_\w{20,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[\w-]{10,}\b/g, // Slack
  /\bAIza[\w-]{35}\b/g, // Google API key
];

/** @param {string} raw @returns {boolean} */
export function luhnValid(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** @param {string} raw @returns {boolean} */
export function ibanValid(raw) {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const chunk = ch >= "A" && ch <= "Z" ? String(ch.codePointAt(0) - 55) : ch;
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** @param {string} raw @returns {boolean} */
export function validatePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  const trimmed = raw.trim();
  // ISO dates and similar calendar forms are not phone numbers.
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) return false;
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(trimmed)) return false;
  // A bare year range or version string.
  if (/^v?\d+(\.\d+)+$/.test(trimmed)) return false;
  return true;
}

/**
 * Priority tiers, lowest number wins an overlap. A credential is never part of
 * a larger identifier, so it sits first; IP shapes must beat the loose phone
 * rule, and numbers-with-checksums beat the phone rule too.
 */
export const DETECTORS = [
  ...API_KEY_PATTERNS.map((pattern) => ({ type: "API_KEY", priority: 0, pattern })),
  { type: "IBAN", priority: 1, pattern: IBAN_RE, validate: ibanValid },
  { type: "CREDIT_CARD", priority: 2, pattern: CARD_RE, validate: luhnValid },
  { type: "SSN", priority: 3, pattern: SSN_RE },
  { type: "EMAIL", priority: 4, pattern: EMAIL_RE },
  { type: "IPV6", priority: 5, pattern: IPV6_FULL_RE },
  { type: "IPV6", priority: 5, pattern: IPV6_COMPRESSED_RE },
  { type: "IPV4", priority: 6, pattern: IPV4_RE },
  { type: "PHONE", priority: 7, pattern: PHONE_RE, validate: validatePhone },
];

/**
 * Find every non-overlapping PII span in `text`.
 *
 * Candidates are collected from every detector, then resolved greedily by
 * (priority, longer span, earlier start) so the most specific reading of an
 * ambiguous run wins. Returned spans are sorted by position.
 *
 * @param {string} text
 * @returns {Array<{ type: string, start: number, end: number, value: string }>}
 */
export function findPii(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  const candidates = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    let match;
    while ((match = detector.pattern.exec(text)) !== null) {
      const value = match[0];
      if (value.length === 0) {
        detector.pattern.lastIndex += 1;
        continue;
      }
      if (detector.validate && !detector.validate(value)) continue;
      candidates.push({
        type: detector.type,
        priority: detector.priority,
        start: match.index,
        end: match.index + value.length,
        value,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      b.value.length - a.value.length ||
      a.start - b.start,
  );

  const accepted = [];
  for (const candidate of candidates) {
    const overlaps = accepted.some(
      (span) => candidate.start < span.end && span.start < candidate.end,
    );
    if (!overlaps) accepted.push(candidate);
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted.map(({ type, start, end, value }) => ({ type, start, end, value }));
}
