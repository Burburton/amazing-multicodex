import assert from "node:assert/strict";
import test from "node:test";
import { ValidationCheckId, ValidationProfileId, validateProfile } from "./validation";

test("rejects duplicate validation check IDs", () => {
  const result = validateProfile({
    id: "profile" as ValidationProfileId,
    mode: "sequential",
    checks: [
      { id: "same" as ValidationCheckId, label: "A", executable: "a", args: [] },
      { id: "same" as ValidationCheckId, label: "B", executable: "b", args: [] }
    ]
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "validation.duplicate-check");
});

test("rejects oversized validation profiles and commands", () => {
  const tooMany = validateProfile({
    id: "profile" as ValidationProfileId,
    mode: "parallel",
    checks: Array.from({ length: 51 }, (_, index) => ({
      id: `check-${index}` as ValidationCheckId,
      label: "Check",
      executable: "check",
      args: []
    }))
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.error.code, "validation.too-many-checks");

  const oversized = validateProfile({
    id: "profile" as ValidationProfileId,
    mode: "sequential",
    checks: [{
      id: "check" as ValidationCheckId,
      label: "Check",
      executable: "check",
      args: ["x".repeat(10_001)]
    }]
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "validation.check-too-large");
});

test("rejects unsafe validation resource limits", () => {
  const base = {
    id: "profile" as ValidationProfileId,
    mode: "sequential" as const
  };
  const timeout = validateProfile({
    ...base,
    checks: [{ id: "check" as ValidationCheckId, label: "Check", executable: "check", args: [], timeoutMs: -1 }]
  });
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.error.code, "validation.invalid-timeout");

  const output = validateProfile({
    ...base,
    checks: [{
      id: "check" as ValidationCheckId, label: "Check", executable: "check", args: [],
      maxOutputBytes: 10 * 1024 * 1024 + 1
    }]
  });
  assert.equal(output.ok, false);
  if (!output.ok) assert.equal(output.error.code, "validation.invalid-output-limit");
});
