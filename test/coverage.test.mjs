import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PiiPseudonymizer,
  anonymizeMessage,
  defaultKeyPath,
  loadOrCreateKey,
} from "../src/anonymizer.mjs";
import {
  PLUGIN_NAME,
  anonymizeAssembly,
  anonymizePostExecuteDecision,
  anonymizePreStepDecision,
  renderNotice,
} from "../src/hooks.mjs";

const KEY = "ab".repeat(32);
const TOKEN = /\[\[EMAIL_[0-9a-f]{8}\]\]/;
const EMAIL = "jane.doe@corp.example";
const text = (t) => [{ type: "text", text: t }];

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pii-anon-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── placeholders: keyed, stable, collision-free ───────────────────────────

test("same value → same placeholder across two separate instances", () => {
  const one = new PiiPseudonymizer({ key: KEY }).anonymize(`mail ${EMAIL}`);
  const two = new PiiPseudonymizer({ key: KEY }).anonymize(`cc ${EMAIL} now`);
  assert.match(one.text, TOKEN);
  assert.equal(one.findings[0].token, two.findings[0].token);
});

test("different values → different placeholders; repeats share one", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const { findings } = p.anonymize("a@x.com b@y.com a@x.com");
  assert.equal(findings[0].token, findings[2].token);
  assert.notEqual(findings[0].token, findings[1].token);
  assert.equal(p.size, 2);
});

test("normalization: case/spacing variants of one value share a placeholder", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  assert.equal(p.tokenFor("EMAIL", "A@X.com"), p.tokenFor("EMAIL", "a@x.com"));
  assert.equal(
    p.tokenFor("IBAN", "DE89 3704 0044 0532 0130 00"),
    p.tokenFor("IBAN", "DE89370400440532013000"),
  );
});

test("a different key gives different placeholders (tokens are keyed)", () => {
  const a = new PiiPseudonymizer({ key: KEY }).tokenFor("EMAIL", EMAIL);
  const b = new PiiPseudonymizer({ key: "cd".repeat(32) }).tokenFor("EMAIL", EMAIL);
  assert.notEqual(a, b);
});

test("anonymize is idempotent: placeholders are never re-detected", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const input = "call +31 6 1234 5678, mail a@x.com, ssn 123-45-6789, host 10.0.0.1";
  const once = p.anonymize(input).text;
  const twice = p.anonymize(once);
  assert.equal(twice.text, once);
  assert.equal(twice.findings.length, 0);
  // A placeholder whose hash happens to be all digits stays intact too.
  const digits = "see [[PHONE_12345678]] and [[CREDIT_CARD_41111111]]";
  assert.equal(p.anonymize(digits).text, digits);
});

// ── key file ──────────────────────────────────────────────────────────────

test("key file is created on first use with mode 0600 and reused after restart", (t) => {
  const dir = scratchDir(t);
  const keyPath = join(dir, "home", "pii-anonymizer.key");
  const before = new PiiPseudonymizer({ keyPath }); // lazy: nothing on disk yet
  assert.throws(() => statSync(keyPath));
  const first = before.tokenFor("EMAIL", EMAIL);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.match(readFileSync(keyPath, "utf8"), /^[0-9a-f]{64}\n$/);
  assert.ok(!readFileSync(keyPath, "utf8").includes(EMAIL), "key file holds no PII");

  // "Restart": a fresh instance reading the same key file.
  const after = new PiiPseudonymizer({ keyPath }).tokenFor("EMAIL", EMAIL);
  assert.equal(after, first);
});

test("an existing key file with loose permissions is tightened to 0600", (t) => {
  const dir = scratchDir(t);
  const keyPath = join(dir, "pii-anonymizer.key");
  writeFileSync(keyPath, `${KEY}\n`);
  chmodSync(keyPath, 0o644);
  assert.deepEqual(loadOrCreateKey(keyPath), Buffer.from(KEY, "hex"));
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
});

test("default key path follows $DSH_HOME, falling back to ~/.dsh", () => {
  assert.equal(defaultKeyPath({ DSH_HOME: "/x/home" }), join("/x/home", "pii-anonymizer.key"));
  assert.match(defaultKeyPath({ DSH_HOME: "  " }), /\.dsh[/\\]pii-anonymizer\.key$/);
});

// ── agent/pre-step: every message source ──────────────────────────────────

const plugin = (form, extra = {}) => ({ kind: "plugin", plugin: "x", form, ...extra });

test("pre-step anonymizes snapshot, recall, relay, instructions and user messages", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const sources = [
    { kind: "user" },
    { kind: "plugin", plugin: "runtime-context", form: "snapshot", sections: [] },
    { kind: "session-reference", form: "recall", version: 1, references: [] },
    { kind: "agent-message", form: "relay", senderSessionId: "s-1" },
    { kind: "agent-instructions", form: "instructions", changes: [] },
    plugin("catalog"),
  ];
  const decision = {
    kind: "enter",
    messages: sources.map((source, i) => ({
      role: "user",
      id: `m${i}`,
      source,
      content: [...text(`contact ${EMAIL}`), { type: "image", attachment: { id: "a" } }],
    })),
  };
  const { decision: out, findings } = anonymizePreStepDecision(decision, p);
  assert.equal(findings.length, sources.length);
  for (const [i, message] of out.messages.entries()) {
    assert.ok(!message.content[0].text.includes(EMAIL), `source ${sources[i].kind} leaked`);
    assert.match(message.content[0].text, TOKEN);
    assert.deepEqual(message.content[1], { type: "image", attachment: { id: "a" } });
    assert.equal(message.source, sources[i], "source metadata is preserved");
    assert.equal(message.id, `m${i}`);
  }
});

test("pre-step leaves a reject decision and its own notice untouched", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const reject = { kind: "reject", reason: "x" };
  assert.equal(anonymizePreStepDecision(reject, p).decision, reject);
  const own = {
    role: "user",
    content: text("1 EMAIL"),
    source: { kind: "plugin", plugin: PLUGIN_NAME, form: "notice" },
  };
  const decision = { kind: "enter", messages: [own] };
  assert.equal(anonymizePreStepDecision(decision, p).decision, decision);
});

test("anonymizeMessage returns the same object when nothing matched", () => {
  const message = { role: "user", content: text("no pii here"), source: { kind: "user" } };
  assert.equal(anonymizeMessage(message, new PiiPseudonymizer({ key: KEY })).message, message);
});

// ── system-prompt/assemble ────────────────────────────────────────────────

test("assemble anonymizes prompt sections, runtime-context sections and variables", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const tools = [{ name: "read", description: "d", parameters: {} }];
  const assembly = {
    sections: [
      { name: "harness:identity", text: "You are an agent." },
      { name: "moqi:workspace", text: `Owner: ${EMAIL}. Host {{host}}.` },
    ],
    contexts: [{ name: "moqi:memory", text: `- call +31 6 1234 5678 about ${EMAIL}` }],
    tools,
    variables: { host: "10.1.2.3", model: "deepseek", count: 3 },
  };
  const { assembly: out, findings } = anonymizeAssembly(assembly, p);
  assert.equal(findings.length, 4);
  assert.equal(out.sections[0], assembly.sections[0], "untouched section kept by identity");
  assert.match(out.sections[1].text, /^Owner: \[\[EMAIL_[0-9a-f]{8}\]\]\. Host \{\{host\}\}\.$/);
  assert.ok(!out.contexts[0].text.includes(EMAIL));
  assert.ok(!out.contexts[0].text.includes("1234 5678"));
  assert.match(out.variables.host, /^\[\[IPV4_[0-9a-f]{8}\]\]$/);
  assert.equal(out.variables.model, "deepseek");
  assert.equal(out.variables.count, 3);
  assert.equal(out.tools, tools);
  // The same email in a section and a context gets one placeholder.
  assert.equal(out.sections[1].text.match(TOKEN)[0], out.contexts[0].text.match(TOKEN)[0]);
});

test("assemble is stable step to step (no snapshot churn)", () => {
  const assembly = { sections: [], contexts: [{ name: "c", text: `mail ${EMAIL}` }], variables: {} };
  const a = anonymizeAssembly(assembly, new PiiPseudonymizer({ key: KEY })).assembly;
  const b = anonymizeAssembly(assembly, new PiiPseudonymizer({ key: KEY })).assembly;
  assert.equal(a.contexts[0].text, b.contexts[0].text);
  // Re-running over the rewritten snapshot changes nothing.
  assert.equal(anonymizeAssembly(a, new PiiPseudonymizer({ key: KEY })).findings.length, 0);
});

// ── tools/post-execute ────────────────────────────────────────────────────

test("post-execute anonymizes the tool result content the model reads", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const result = { isError: false, value: { raw: EMAIL }, content: text(`line 1: ${EMAIL}`) };
  const { decision, findings } = anonymizePostExecuteDecision({ kind: "accept" }, result, p);
  assert.equal(findings.length, 1);
  assert.equal(decision.kind, "accept");
  assert.match(decision.content[0].text, /^line 1: \[\[EMAIL_[0-9a-f]{8}\]\]$/);
  assert.ok(!Object.hasOwn(decision, "value"), "never replaces both value and content");
});

test("post-execute rewrites a downstream replacement, block feedback and contexts", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const result = { isError: false, content: text("ok") };
  const replaced = anonymizePostExecuteDecision(
    { kind: "accept", content: text(`now ${EMAIL}`) },
    result,
    p,
  ).decision;
  assert.match(replaced.content[0].text, TOKEN);

  const blocked = anonymizePostExecuteDecision(
    { kind: "block", feedback: text(`denied for ${EMAIL}`) },
    result,
    p,
  ).decision;
  assert.match(blocked.feedback[0].text, TOKEN);
  assert.ok(!Object.hasOwn(blocked, "content"));

  const withContext = anonymizePostExecuteDecision(
    { kind: "accept", additionalContexts: [{ role: "user", source: plugin("notice"), content: text(EMAIL) }] },
    result,
    p,
  ).decision;
  assert.match(withContext.additionalContexts[0].content[0].text, TOKEN);
});

test("post-execute with nothing to rewrite returns the decision unchanged", () => {
  const decision = { kind: "accept" };
  const out = anonymizePostExecuteDecision(decision, { content: text("clean") }, new PiiPseudonymizer({ key: KEY }));
  assert.equal(out.decision, decision);
  assert.equal(out.findings.length, 0);
});

// ── notice ────────────────────────────────────────────────────────────────

test("the notice carries types and counts only, never values or placeholders", () => {
  const p = new PiiPseudonymizer({ key: KEY });
  const { findings } = p.anonymize(`${EMAIL} and +31 6 1234 5678`);
  const notice = renderNotice(findings);
  assert.match(notice, /2 item\(s\).*1 EMAIL, 1 PHONE/);
  assert.ok(!notice.includes(EMAIL));
  assert.ok(!notice.includes("[["));
});
