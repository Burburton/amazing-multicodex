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

