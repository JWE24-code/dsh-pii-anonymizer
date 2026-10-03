import { test } from "node:test";
import assert from "node:assert/strict";

import { findPii, ibanValid, luhnValid, validatePhone } from "../src/detectors.mjs";
import { PiiPseudonymizer, anonymizeMessage } from "../src/anonymizer.mjs";

test("detects and tokenizes an email", () => {
  const anon = new PiiPseudonymizer();
  const { text, findings } = anon.anonymize("mail me at joeri@example.com please");
  assert.equal(text, "mail me at [[EMAIL_1]] please");
  assert.deepEqual(findings, [{ type: "EMAIL", token: "[[EMAIL_1]]" }]);
});

test("the same value always gets the same token; distinct values get new ones", () => {
  const anon = new PiiPseudonymizer();
  const first = anon.anonymize("a@x.com and a@x.com");
  assert.equal(first.text, "[[EMAIL_1]] and [[EMAIL_1]]");
  const second = anon.anonymize("now b@y.com");
  assert.equal(second.text, "now [[EMAIL_2]]");
  assert.equal(anon.size, 2);
});

test("ordinals keep counting past ten without collision", () => {
  const anon = new PiiPseudonymizer();
  const values = Array.from({ length: 11 }, (_, i) => `user${i}@example.com`);
  const { text } = anon.anonymize(values.join(" "));
  for (const expected of ["[[EMAIL_1]]", "[[EMAIL_10]]", "[[EMAIL_11]]"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
  assert.equal(anon.size, 11);
});

test("detection is deterministic across fresh instances", () => {
  const input = "reach a@x.com on +31 6 1234 5678 or 4111 1111 1111 1111";
  const one = new PiiPseudonymizer().anonymize(input);
  const two = new PiiPseudonymizer().anonymize(input);
  assert.equal(one.text, two.text);
});

test("validates payment and network identifiers", () => {
  assert.equal(luhnValid("4111 1111 1111 1111"), true);
  assert.equal(luhnValid("4111 1111 1111 1112"), false);
  assert.equal(ibanValid("DE89 3704 0044 0532 0130 00"), true);
  assert.equal(ibanValid("DE89 3704 0044 0532 0130 01"), false);
  assert.equal(validatePhone("2024-01-15"), false);
  assert.equal(validatePhone("+31 6 1234 5678"), true);
});

test("space-grouped IBANs are detected", () => {
  const { text, findings } = new PiiPseudonymizer().anonymize(
    "send to IBAN DE89 3704 0044 0532 0130 00 today",
  );
  assert.equal(text, "send to IBAN [[IBAN_1]] today");
  assert.deepEqual(findings.map((f) => f.type), ["IBAN"]);
});

test("a space-grouped IBAN with a bad checksum is not labelled IBAN", () => {
  const { findings } = new PiiPseudonymizer().anonymize(
    "DE89 3704 0044 0532 0130 01",
  );
  assert.equal(findings.filter((f) => f.type === "IBAN").length, 0);
});

test("a parenthesized phone group is tokenized whole", () => {
  const { text } = new PiiPseudonymizer().anonymize("call (020) 555-0123 now");
  assert.equal(text, "call [[PHONE_1]] now");
});

test("card numbers win over the looser phone rule", () => {
  const { findings } = new PiiPseudonymizer().anonymize("pay 4111 1111 1111 1111 now");
  assert.deepEqual(findings.map((f) => f.type), ["CREDIT_CARD"]);
});

test("IPv4 wins over the phone rule", () => {
  const { findings } = new PiiPseudonymizer().anonymize("host 192.168.1.10 up");
  assert.deepEqual(findings.map((f) => f.type), ["IPV4"]);
});

test("API keys are detected", () => {
  const { findings } = new PiiPseudonymizer().anonymize(
    "export KEY=sk-ant-abcdefghijklmnopqrstuvwx",
  );
  assert.deepEqual(findings.map((f) => f.type), ["API_KEY"]);
});

test("SSN example is detected without the phone rule stealing it", () => {
  const { findings } = new PiiPseudonymizer().anonymize("ssn 123-45-6789 on file");
  assert.deepEqual(findings.map((f) => f.type), ["SSN"]);
});

test("plain prose with no PII is returned untouched", () => {
  const { text, findings } = new PiiPseudonymizer().anonymize(
    "please refactor the parser and add tests",
  );
  assert.equal(text, "please refactor the parser and add tests");
  assert.equal(findings.length, 0);
});

test("anonymizeMessage only rewrites text blocks of user messages", () => {
  const anon = new PiiPseudonymizer();
  const message = {
    role: "user",
    id: "m1",
    content: [
      { type: "text", text: "mail a@x.com" },
      { type: "image", attachment: { id: "att-1" } },
    ],
    source: { kind: "user" },
  };
  const { message: out, findings } = anonymizeMessage(message, anon);
  assert.equal(out.content[0].text, "mail [[EMAIL_1]]");
  assert.deepEqual(out.content[1], { type: "image", attachment: { id: "att-1" } });
  assert.equal(out.id, "m1");
  assert.equal(findings.length, 1);
});

test("harness-injected context is left alone", () => {
  const anon = new PiiPseudonymizer();
  const context = {
    role: "user",
    id: "ctx-1",
    content: [{ type: "text", text: "sandbox host is 192.168.60.12" }],
    source: { kind: "plugin", plugin: "agent-instructions" },
  };
  const { message: out, findings } = anonymizeMessage(context, anon);
  assert.equal(out, context);
  assert.equal(findings.length, 0);
});

test("findPii returns spans in document order", () => {
  const spans = findPii("a@x.com then 192.168.0.1");
  assert.deepEqual(spans.map((s) => s.type), ["EMAIL", "IPV4"]);
});
