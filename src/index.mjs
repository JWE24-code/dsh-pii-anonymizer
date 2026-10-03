/**
 * `pii-anonymizer` — a native DeepSeek Harness plugin that puts a one-way,
 * deterministic PII shield at the start of the agent loop.
 *
 * It listens on the `agent/pre-step` waterfall (the loop's admission point) and
 * replaces every detected PII value in the user messages that are about to enter
 * the model request with a stable local placeholder. The real values are kept
 * only in this process, so they never leave the computer. When something is
 * anonymized, a `notice`-form plugin message tells the user what stayed local.
 *
 * @module dsh-pii-anonymizer
 */

import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { PiiPseudonymizer, anonymizeMessage } from "./anonymizer.mjs";

export const name = "pii-anonymizer";

/** Schemastery schema for this plugin's `config:` block. */
export const Config = z.object({
  /** Master switch; when false the loop is untouched. */
  enabled: z.boolean().default(true),
  /** Emit a local `notice` message whenever PII was anonymized on a step. */
  notify: z.boolean().default(true),
  /** Log load/shield events (counts only, never values). */
  debug: z.boolean().default(false),
});

const DEFAULTS = { enabled: true, notify: true, debug: false };

/**
 * Human-readable, PII-free account of what was shielded. Only types and counts
 * appear — never the values themselves.
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
  return `🔒 PII shield: ${findings.length} item(s) anonymized locally (${detail}). Real values did not leave this computer.`;
}

/**
 * Cordis entry point. The plugin is inert until the loader applies it.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, notify?: boolean, debug?: boolean }} [config]
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...config };
  if (settings.debug) ctx.logger?.info?.("[pii-anonymizer] loaded");

  /** @type {WeakMap<object, PiiPseudonymizer>} */
  const sessions = new WeakMap();

  /** One pseudonymizer (and therefore one stable token namespace) per session. */
  const anonymizerFor = (session) => {
    let anonymizer = sessions.get(session);
    if (anonymizer === undefined) {
      anonymizer = new PiiPseudonymizer();
      sessions.set(session, anonymizer);
    }
    return anonymizer;
  };

  ctx.on("agent/pre-step", async ({ agent, signal, step }, next) => {
    const decision = await next();
    if (!settings.enabled || decision.kind === "reject") return decision;

    const anonymizer = anonymizerFor(agent.session);
    const findings = [];
    const messages = decision.messages.map((message) => {
      const result = anonymizeMessage(message, anonymizer);
      if (result.findings.length > 0) findings.push(...result.findings);
      return result.message;
    });

    if (findings.length === 0) return decision;
    if (settings.debug) {
      ctx.logger?.info?.(
        "[pii-anonymizer] shielded %d item(s) on step %d",
        findings.length,
        step,
      );
    }

    if (settings.notify && !signal?.aborted) {
      const summary = renderNotice(findings);
      messages.push(
        createUserMessage({
          content: [{ type: "text", text: summary }],
          source: { kind: "plugin", plugin: name, form: "notice", summary },
        }),
      );
    }

    return { ...decision, messages };
  });
}
