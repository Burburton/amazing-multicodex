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
