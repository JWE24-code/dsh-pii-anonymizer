import { test } from "node:test";
import assert from "node:assert/strict";

import { findPii, ibanValid, luhnValid, validatePhone } from "../src/detectors.mjs";
import { PiiPseudonymizer } from "../src/anonymizer.mjs";

const KEY = "11".repeat(32);
const anon = () => new PiiPseudonymizer({ key: KEY });

test("validates payment and network identifiers", () => {
  assert.equal(luhnValid("4111 1111 1111 1111"), true);
  assert.equal(luhnValid("4111 1111 1111 1112"), false);
  assert.equal(ibanValid("DE89 3704 0044 0532 0130 00"), true);
  assert.equal(ibanValid("DE89 3704 0044 0532 0130 01"), false);
  assert.equal(validatePhone("2024-01-15"), false);
  assert.equal(validatePhone("+31 6 1234 5678"), true);
});

test("space-grouped IBANs are detected", () => {
  const { text, findings } = anon().anonymize(
    "send to IBAN DE89 3704 0044 0532 0130 00 today",
  );
  assert.match(text, /^send to IBAN \[\[IBAN_[0-9a-f]{8}\]\] today$/);
  assert.deepEqual(findings.map((f) => f.type), ["IBAN"]);
});

test("a space-grouped IBAN with a bad checksum is not labelled IBAN", () => {
  const { findings } = anon().anonymize(
    "DE89 3704 0044 0532 0130 01",
  );
  assert.equal(findings.filter((f) => f.type === "IBAN").length, 0);
});

test("a parenthesized phone group is tokenized whole", () => {
  const { text } = anon().anonymize("call (020) 555-0123 now");
  assert.match(text, /^call \[\[PHONE_[0-9a-f]{8}\]\] now$/);
});

test("card numbers win over the looser phone rule", () => {
  const { findings } = anon().anonymize("pay 4111 1111 1111 1111 now");
  assert.deepEqual(findings.map((f) => f.type), ["CREDIT_CARD"]);
});

test("IPv4 wins over the phone rule", () => {
  const { findings } = anon().anonymize("host 192.168.1.10 up");
  assert.deepEqual(findings.map((f) => f.type), ["IPV4"]);
});

test("API keys are detected", () => {
  const { findings } = anon().anonymize(
    "export KEY=sk-ant-abcdefghijklmnopqrstuvwx",
  );
  assert.deepEqual(findings.map((f) => f.type), ["API_KEY"]);
});

test("SSN example is detected without the phone rule stealing it", () => {
  const { findings } = anon().anonymize("ssn 123-45-6789 on file");
  assert.deepEqual(findings.map((f) => f.type), ["SSN"]);
});

test("plain prose with no PII is returned untouched", () => {
  const { text, findings } = anon().anonymize(
    "please refactor the parser and add tests",
  );
  assert.equal(text, "please refactor the parser and add tests");
  assert.equal(findings.length, 0);
});

test("findPii returns spans in document order", () => {
  const spans = findPii("a@x.com then 192.168.0.1");
  assert.deepEqual(spans.map((s) => s.type), ["EMAIL", "IPV4"]);
});
