import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "./sensitiveText";

test("redacts common credentials while preserving useful context", () => {
  const text = [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "OPENAI_API_KEY=sk-example1234567890",
    "github ghp_1234567890abcdefghijklmnop",
    "password: 'correct horse battery staple'",
    "aws AKIA1234567890ABCDEF"
  ].join("\n");

  const redacted = redactSensitiveText(text);
  assert.equal(redacted.includes("eyJhbGci"), false);
  assert.equal(redacted.includes("sk-example"), false);
  assert.equal(redacted.includes("ghp_"), false);
  assert.equal(redacted.includes("correct horse"), false);
  assert.equal(redacted.includes("AKIA"), false);
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
});

test("leaves ordinary activity text unchanged", () => {
  assert.equal(redactSensitiveText("Ran npm test: 29 passed"), "Ran npm test: 29 passed");
});
