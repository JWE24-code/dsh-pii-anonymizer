/**
 * `pii-anonymizer` — a native DeepSeek Harness plugin that replaces detected
 * PII with keyed, stable placeholders in everything the model is sent.
 *
 * It hooks three harness pipelines, each as the outermost listener
 * (`prepend: true`) so it rewrites the final value after every other listener:
 *
 * - `system-prompt/assemble` — prompt sections, runtime-context sections (the
 *   source of the loop's per-request snapshots), and prompt variables;
 * - `agent/pre-step` — every message entering a step (user prompt, snapshots,
 *   workspace instructions, recalled sessions, relayed agent messages,
 *   tool-result contexts);
 * - `tools/post-execute` — the tool result content the model reads.
 *
 * Placeholders are `[[TYPE_<keyed hash>]]` with a per-install key kept at
 * `$DSH_HOME/pii-anonymizer.key` (mode 0600), so a value maps to the same
 * placeholder in every session and after restarts. When a step's messages
 * contained PII, a `notice`-form plugin message (types and counts only) is
 * added to the step; it is a user-role message, so the model receives it too.
 *
 * @module dsh-pii-anonymizer
 */

import { randomBytes } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { PiiPseudonymizer, defaultKeyPath, loadOrCreateKey } from "./anonymizer.mjs";
import {
  PLUGIN_NAME,
  anonymizeAssembly,
  anonymizePostExecuteDecision,
  anonymizePreStepDecision,
  renderNotice,
} from "./hooks.mjs";

export { renderNotice } from "./hooks.mjs";

export const name = PLUGIN_NAME;

/** Schemastery schema for this plugin's `config:` block. */
export const Config = z.object({
  /** Master switch; when false the loop is untouched. */
  enabled: z.boolean().default(true),
  /** Add a notice message to a step whose messages contained PII. */
  notify: z.boolean().default(true),
  /** Log load/shield events (counts only, never values). */
  debug: z.boolean().default(false),
  /** Rewrite the system prompt and runtime context (`system-prompt/assemble`). */
  systemPrompt: z.boolean().default(true),
  /** Rewrite tool result content (`tools/post-execute`). */
  toolResults: z.boolean().default(true),
  /** Key file; empty means `$DSH_HOME/pii-anonymizer.key`. */
  keyFile: z.string().default(""),
});

const DEFAULTS = {
  enabled: true,
  notify: true,
  debug: false,
  systemPrompt: true,
  toolResults: true,
  keyFile: "",
};

/**
 * Cordis entry point. The plugin is inert until the loader applies it.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [config]
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...config };
  const log = (...args) => {
    if (settings.debug) ctx.logger?.info?.(...args);
  };
  log("[pii-anonymizer] loaded");
  if (!settings.enabled) return;

  const keyPath = settings.keyFile || defaultKeyPath();
  // One pseudonymizer for the whole process: placeholders depend only on the
  // key, so sessions share them by construction.
  const pseudonymizer = new PiiPseudonymizer({
    keySource: () => {
      try {
        return loadOrCreateKey(keyPath);
      } catch (error) {
        // Still anonymize — just without cross-restart stability.
        ctx.logger?.warn?.(
          "[pii-anonymizer] key file unavailable (%s); using a process-only key",
          error?.code ?? "error",
        );
        return randomBytes(32);
      }
    },
  });

  if (settings.systemPrompt) {
    ctx.on(
      "system-prompt/assemble",
      async (_assembly, _context, next) => {
        const assembled = await next();
        const result = anonymizeAssembly(assembled, pseudonymizer);
        if (result.findings.length > 0) {
          log("[pii-anonymizer] system prompt: %d item(s)", result.findings.length);
        }
        return result.assembly;
      },
      { prepend: true },
    );
  }

  if (settings.toolResults) {
    ctx.on(
      "tools/post-execute",
      async (exec, toolResult, next) => {
        const decision = await next();
        const result = anonymizePostExecuteDecision(decision, toolResult, pseudonymizer);
        if (result.findings.length > 0) {
          log("[pii-anonymizer] tool %s: %d item(s)", exec?.name, result.findings.length);
        }
        return result.decision;
      },
      { prepend: true },
    );
  }

  ctx.on(
    "agent/pre-step",
    async ({ signal, step }, next) => {
      const original = await next();
      const { decision, findings } = anonymizePreStepDecision(original, pseudonymizer);
      if (findings.length === 0) return decision;
      log("[pii-anonymizer] shielded %d item(s) on step %d", findings.length, step);

      if (!settings.notify || signal?.aborted) return decision;
      const summary = renderNotice(findings);
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: "text", text: summary }],
            source: { kind: "plugin", plugin: PLUGIN_NAME, form: "notice", summary },
          }),
        ],
      };
    },
    { prepend: true },
  );
}
