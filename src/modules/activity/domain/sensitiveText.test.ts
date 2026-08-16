import assert from "node:assert/strict";
import test from "node:test";
import { redactAndTruncateSensitiveText, redactSensitiveText } from "./sensitiveText";

test("redacts common credentials while preserving useful context", () => {
  const text = [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "OPENAI_API_KEY=sk-example1234567890",
    "github ghp_1234567890abcdefghijklmnop",
    "gitlab glpat-1234567890abcdef",
    "npm npm_1234567890abcdef",
    "slack xoxb-1234567890-secretvalue",
    "password: 'correct horse battery staple'",
    "aws AKIA1234567890ABCDEF",
    "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"
  ].join("\n");

  const redacted = redactSensitiveText(text);
  assert.equal(redacted.includes("eyJhbGci"), false);
  assert.equal(redacted.includes("sk-example"), false);
  assert.equal(redacted.includes("ghp_"), false);
  assert.equal(redacted.includes("correct horse"), false);
  assert.equal(redacted.includes("AKIA"), false);
  assert.equal(redacted.includes("glpat-"), false);
  assert.equal(redacted.includes("npm_"), false);
  assert.equal(redacted.includes("xoxb-"), false);
  assert.equal(redacted.includes("private-material"), false);
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
});

test("leaves ordinary activity text unchanged", () => {
  assert.equal(redactSensitiveText("Ran npm test: 29 passed"), "Ran npm test: 29 passed");
});

test("marks bounded text after redacting its retained content", () => {
  const bounded = redactAndTruncateSensitiveText("sk-example1234567890 " + "x".repeat(100), 40);
  assert.equal(bounded.length, 40);
  assert.equal(bounded.includes("sk-example"), false);
  assert.match(bounded, /truncated/);
});
