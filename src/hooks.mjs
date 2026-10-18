/**
 * The three model-facing rewrites, as pure functions over the harness's own
 * data shapes. They import nothing from the harness, so they can be unit
 * tested without it; `index.mjs` wires them onto the Cordis events.
 *
 * - `system-prompt/assemble` (dsh-system-prompt): prompt section text,
 *   runtime-context text, and string prompt variables. Runtime context is where
 *   per-request snapshots come from (the agent loop renders the assembled
 *   `contexts` into its `form: "snapshot"` user message), so rewriting it here
 *   keeps the loop's "has the snapshot changed?" comparison stable.
 * - `agent/pre-step` (dsh-agent-loop): every message about to be committed to
 *   the step, whatever its source — user prompt, snapshot, workspace
 *   instructions, recall, relay, tool-result contexts.
 * - `tools/post-execute` (dsh-tools): the tool result content the model reads.
 *
 * @module dsh-pii-anonymizer/hooks
 */

import { anonymizeContent, anonymizeMessage } from "./anonymizer.mjs";

/** Plugin name; also how this plugin recognises its own notice message. */
export const PLUGIN_NAME = "pii-anonymizer";

/** @param {{ source?: { kind?: string, plugin?: string } }} message */
function isOwnMessage(message) {
  return message?.source?.kind === "plugin" && message.source.plugin === PLUGIN_NAME;
}

/**
 * Anonymize the messages of an `agent/pre-step` decision.
 *
 * @param {{ kind: string, messages?: unknown[] }} decision
 * @param {import('./anonymizer.mjs').PiiPseudonymizer} pseudonymizer
 * @returns {{ decision: object, findings: Array<{ type: string, token: string }> }}
 */
export function anonymizePreStepDecision(decision, pseudonymizer) {
  if (decision?.kind === "reject" || !Array.isArray(decision?.messages)) {
    return { decision, findings: [] };
  }
  const findings = [];
  let changed = false;
  const messages = decision.messages.map((message) => {
    if (isOwnMessage(message)) return message;
    const result = anonymizeMessage(message, pseudonymizer);
    if (result.findings.length > 0) {
      changed = true;
      findings.push(...result.findings);
    }
    return result.message;
  });
  return { decision: changed ? { ...decision, messages } : decision, findings };
}

/**
 * Anonymize a `system-prompt/assemble` result: section text, runtime-context
 * text, and string variable values. Tool schemas are left alone.
 *
 * @param {{ sections?: Array<{ name: string, text: unknown }>, contexts?: Array<{ name: string, text: unknown }>, variables?: Record<string, unknown> }} assembly
 * @param {import('./anonymizer.mjs').PiiPseudonymizer} pseudonymizer
 * @returns {{ assembly: object, findings: Array<{ type: string, token: string }> }}
 */
export function anonymizeAssembly(assembly, pseudonymizer) {
  if (assembly === null || typeof assembly !== "object") return { assembly, findings: [] };
  const findings = [];
  let changed = false;
  const rewriteText = (text) => {
    if (typeof text !== "string") return text;
    const result = pseudonymizer.anonymize(text);
    if (result.findings.length === 0) return text;
    changed = true;
    findings.push(...result.findings);
    return result.text;
  };
  const rewriteEntries = (entries) =>
    Array.isArray(entries)
      ? entries.map((entry) => {
          const text = rewriteText(entry?.text);
          return text === entry?.text ? entry : { ...entry, text };
        })
      : entries;

  const sections = rewriteEntries(assembly.sections);
  const contexts = rewriteEntries(assembly.contexts);
  let variables = assembly.variables;
  if (variables !== null && typeof variables === "object") {
    variables = Object.fromEntries(
      Object.entries(variables).map(([name, value]) => [name, rewriteText(value)]),
    );
  }
  if (!changed) return { assembly, findings };
  return { assembly: { ...assembly, sections, contexts, variables }, findings };
}

/**
 * Anonymize a `tools/post-execute` decision: the result content the model
 * will read (the downstream decision's replacement content, or the original
 * result content), a block decision's feedback, and attached contexts.
 *
 * A downstream decision that replaced the result's `value` cannot also have
 * its content replaced (the registry rejects both), so it is left as is; no
 * first-party listener does that.
 *
 * @param {{ kind: string, content?: unknown[], feedback?: unknown[], value?: unknown, additionalContexts?: unknown[] }} decision
 * @param {{ content?: unknown[] }} result
 * @param {import('./anonymizer.mjs').PiiPseudonymizer} pseudonymizer
 * @returns {{ decision: object, findings: Array<{ type: string, token: string }> }}
 */
export function anonymizePostExecuteDecision(decision, result, pseudonymizer) {
  const findings = [];
  let out = decision;
  const patch = (field, content) => {
    if (!Array.isArray(content)) return;
    const rewritten = anonymizeContent(content, pseudonymizer);
    if (!rewritten.changed) return;
    findings.push(...rewritten.findings);
    out = { ...out, [field]: rewritten.content };
  };

  if (decision?.kind === "block") {
    patch("feedback", decision.feedback);
  } else if (decision?.kind === "accept" && !Object.hasOwn(decision, "value")) {
    patch("content", Object.hasOwn(decision, "content") ? decision.content : result?.content);
  }

  if (Array.isArray(decision?.additionalContexts)) {
    let changed = false;
    const contexts = decision.additionalContexts.map((message) => {
      const rewritten = anonymizeMessage(message, pseudonymizer);
      if (rewritten.findings.length > 0) {
        changed = true;
        findings.push(...rewritten.findings);
      }
      return rewritten.message;
    });
    if (changed) out = { ...out, additionalContexts: contexts };
  }
  return { decision: out, findings };
}

/**
 * Human-readable, PII-free account of what was replaced on one step. Only
 * types and counts appear — never the values or the placeholders.
 *
 * This text is delivered as a user-role message: the model receives it too,
 * and the host app shows it in the transcript.
 *
 * @param {Array<{ type: string }>} findings
 * @returns {string}
 */
export function renderNotice(findings) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.type, (counts.get(finding.type) ?? 0) + 1);
  }
  const detail = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  return `🔒 PII shield: ${findings.length} item(s) in this step's input were replaced with placeholders before being sent to the model provider (${detail}).`;
}
